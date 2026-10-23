import { previewBindings } from "@getquick/site/preview-bindings";
import * as Alchemy from "alchemy";
import { Stack } from "alchemy/Stack";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ConsentDatabase,
  ConsentPurge,
  consentRateLimiter,
  consentRecords,
  consentRetention,
} from "./consent.ts";

// Hostnames live in gq.ops.json (domains), shared with the Ploi and deploy scripts.
const ops = JSON.parse(readFileSync(new URL("../gq.ops.json", import.meta.url), "utf8")) as {
  domains: { admin: string; frontend: string };
  contentRuntime?: "package";
  preview?: { cmsUrl: string; audience: string };
  wordpress?: { graphqlPath?: "/graphql" | "/wp/graphql" };
  offboarded?: { phase: string };
};
const previewEnv = previewBindings(ops, process.env, Redacted.make);
const productionHostname = ops.domains.frontend;
// Alchemy beta.79 passes string Website.env values to Astro's build child,
// overriding the app's local .env. This is public configuration, not a secret.
const graphqlUrl =
  process.env.PUBLIC_WORDPRESS_GRAPHQL_URL ||
  `https://${ops.domains.admin}${ops.wordpress?.graphqlPath ?? "/wp/graphql"}`;
// An offboarded Site (gq offboard) keeps no public URL: no custom domain, no
// workers.dev and no preview URLs. Its deploy scripts refuse to run anyway.
const offboarded = Boolean(ops.offboarded);

// A Frontend with the publication store's migrations serves published
// content from it (durable delivery); without them it keeps reading the CMS
// on each request and gets no store. A Site generated before the content
// package pair (ADR 0020) keeps its own copy in apps/frontend/migrations; a
// Site on the pair (contentRuntime "package") gets them by installing
// @getquick/content in apps/frontend (its `./migrations` export), so
// installing the package switches the store on. An older Site that installs
// the package for consent alone gets no store from it.
async function installedPublicationMigrations(
  contentRuntime: string | undefined,
): Promise<string | null> {
  const frontendApp = new URL("../apps/frontend/", import.meta.url);
  const copied = new URL("migrations", frontendApp);
  if (existsSync(copied)) return fileURLToPath(copied);
  if (contentRuntime !== "package") return null;
  const manifest = new URL("node_modules/@getquick/content/package.json", frontendApp);
  if (!existsSync(manifest)) return null;
  const entry = JSON.parse(readFileSync(manifest, "utf8")).exports?.["./migrations"]?.import;
  if (typeof entry !== "string") return null;
  const module = (await import(new URL(entry, manifest).href)) as { migrationsDirectory: string };
  return module.migrationsDirectory;
}

const publicationMigrations = await installedPublicationMigrations(ops.contentRuntime);
const durableDelivery = publicationMigrations !== null;

// The trusted refresh's credential and the key the CMS signs its publication
// events with, from Sigillo staging (CI releases get them from the CI Worker).
// Without one, the Worker refuses refreshes or events; what is already stored
// keeps being served.
const refreshToken = process.env.FRONTEND_REFRESH_TOKEN?.trim();
const eventSecret = process.env.PUBLICATION_EVENT_SECRET?.trim();
// The bearer the Site's CMS reads consent records with (GQ Config's Consent
// tab), from Sigillo staging. Without it the Worker refuses reads; records are
// still written.
const consentReadToken = process.env.CONSENT_READ_TOKEN?.trim();

// Only the read-only edge identity belongs in the public Frontend's server.
// Automation credentials must never be bound to this Worker.
const graphqlClientId = process.env.GQ_AUTH_GRAPHQL_CLIENT_ID?.trim();
const graphqlClientSecret = process.env.GQ_AUTH_GRAPHQL_CLIENT_SECRET?.trim();
if (Boolean(graphqlClientId) !== Boolean(graphqlClientSecret)) {
  throw new Error(
    "GQ_AUTH_GRAPHQL_CLIENT_ID and GQ_AUTH_GRAPHQL_CLIENT_SECRET must be set together.",
  );
}
const cmsSecrets: Record<string, Redacted.Redacted<string>> = graphqlClientId && graphqlClientSecret
  ? {
      GQ_AUTH_GRAPHQL_CLIENT_ID: Redacted.make(graphqlClientId),
      GQ_AUTH_GRAPHQL_CLIENT_SECRET: Redacted.make(graphqlClientSecret),
    }
  : {};

// The Site's last-known-good published content. One database per Site and
// stage, separate from the Worker, so a redeploy or restart keeps it; Alchemy
// applies the Frontend's migrations, in order, before the Worker is updated.
// Production's is retained even if this declaration goes away.
const Publications = Effect.gen(function* () {
  const { stage } = yield* Stack;
  const production = stage === "prod";
  // The project's name stays in a constant, as in Website below.
  const database = "{{project}}-fe-publications";
  return yield* Cloudflare.D1.Database("{{Project}}Publications", {
    name: production ? database : `${database}-${stage}`,
    migrations: publicationMigrations ?? undefined,
  }).pipe(Alchemy.RemovalPolicy.retain(production));
});

export const Website = Cloudflare.Website.Astro(
  "{{Project}}Frontend",
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const production = stage === "prod";
    // The project's name stays in constants: in the lines below, a shorter or
    // longer one would make the site's formatter rewrap them, editing this file.
    const worker = "{{project}}-fe";
    const name = production ? worker : `${worker}-${stage}`;
    const publicEnv: Record<string, string> = production
      ? { PUBLIC_WORDPRESS_GRAPHQL_URL: graphqlUrl }
      : {};

    return {
      name,
      rootDir: "../apps/frontend",
      ...(production && !offboarded ? { domain: productionHostname } : {}),
      astro: {
        site: production ? `https://${productionHostname}` : `https://${name}.workers.dev`,
        output: "server",
      },
      workersDev: offboarded
        ? { enabled: false, previewsEnabled: false }
        : production
          ? { enabled: false, previewsEnabled: true }
          : true,
      sessionKVBindingName: false,
      env: {
        ...publicEnv,
        // A Frontend with a consent Runtime (infra/consent.ts) records
        // visitors' decisions in its own eu database.
        ...(consentRecords
          ? {
              CONSENT_DB: yield* ConsentDatabase,
              CONSENT_RATE_LIMITER: consentRateLimiter(name),
              ...consentRetention,
              ...(consentReadToken ? { CONSENT_READ_TOKEN: Redacted.make(consentReadToken) } : {}),
            }
          : {}),
        ...(durableDelivery
          ? {
              ...cmsSecrets,
              PUBLICATION_DB: yield* Publications,
              ...(refreshToken ? { FRONTEND_REFRESH_TOKEN: Redacted.make(refreshToken) } : {}),
              ...(eventSecret ? { PUBLICATION_EVENT_SECRET: Redacted.make(eventSecret) } : {}),
            }
          : cmsSecrets),
      },
    };
  }),
);

export default Alchemy.Stack(
  "{{Project}}Frontend",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Website;
    // Bind after Website init: preview config never enters Astro build env.
    if (ops.preview) yield* site.bind`Preview`({ env: previewEnv });
    if (consentRecords) yield* ConsentPurge;

    return { url: site.url };
  }),
);
