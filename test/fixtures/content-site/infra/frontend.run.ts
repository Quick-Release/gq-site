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
  domains: {
    admin: string;
    frontend: string;
    frontendTarget?: string;
    frontendProxy?: { trustedProxies: string[] };
  };
  cloudflare?: { zoneId?: string };
  contentRuntime?: "package";
  preview?: { cmsUrl: string; audience: string };
  wordpress?: { graphqlPath?: "/graphql" | "/wp/graphql" };
  forms?: { provider: string; spam?: string[] };
  offboarded?: { phase: string };
};
const previewEnv = previewBindings(ops, process.env, Redacted.make);
const productionHostname = ops.domains.frontend;
// A public hostname outside the Cloudflare zone (domains.frontendTarget set)
// leaves the Worker its Custom Domain on the in-zone hostname. By default it
// is a Cloudflare for SaaS custom hostname: its DNS points at the in-zone
// hostname, and a route on the zone hands its requests to the Worker. gq
// cloudflare custom-hostname creates the custom hostname and its certificate.
// Behind an external proxy (domains.frontendProxy), the proxy sends its
// requests to the in-zone hostname itself: no route. The form and consent
// endpoints believe its X-Forwarded-For from its addresses only
// (GQ_TRUSTED_PROXIES, comma-separated; @getquick/content's trustedProxies).
const frontendTarget = ops.domains.frontendTarget;
const frontendProxy = frontendTarget ? ops.domains.frontendProxy : undefined;
const customHostname = Boolean(frontendTarget) && !frontendProxy;
const trustedProxies = frontendProxy?.trustedProxies.join(",") ?? "";
const zoneId = ops.cloudflare?.zoneId;
if (customHostname && !zoneId) {
  throw new Error("gq.ops.json domains.frontendTarget needs cloudflare.zoneId.");
}
const customHostnameRoutes =
  customHostname && zoneId ? [{ pattern: `${productionHostname}/*`, zoneId }] : undefined;
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

// Headless forms (gq.ops.json `forms`; the managed /gq/forms/ route). A Site
// that chose Turnstile gets its keys from Sigillo staging: the secret as a
// Worker secret the form endpoint verifies with, the site key as a plain
// binding the Site's renderer reads (it is public). A CMS whose submissions
// path is behind Cloudflare Access gets its own service token, never the
// GraphQL reader's. deploy-frontend.mjs refuses a deploy without them.
const turnstile = ops.forms?.spam?.includes("turnstile") ?? false;
const turnstileSecret = process.env.TURNSTILE_SECRET_KEY?.trim();
const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY?.trim();
const formsAccessId = process.env.GQ_FORMS_ACCESS_CLIENT_ID?.trim();
const formsAccessSecret = process.env.GQ_FORMS_ACCESS_CLIENT_SECRET?.trim();
if (Boolean(formsAccessId) !== Boolean(formsAccessSecret)) {
  throw new Error(
    "GQ_FORMS_ACCESS_CLIENT_ID and GQ_FORMS_ACCESS_CLIENT_SECRET must be set together.",
  );
}
const formsSecrets: Record<string, Redacted.Redacted<string> | string> = {
  ...(turnstile && turnstileSecret ? { TURNSTILE_SECRET_KEY: Redacted.make(turnstileSecret) } : {}),
  ...(turnstile && turnstileSiteKey ? { TURNSTILE_SITE_KEY: turnstileSiteKey } : {}),
  ...(formsAccessId && formsAccessSecret
    ? {
        GQ_FORMS_ACCESS_CLIENT_ID: Redacted.make(formsAccessId),
        GQ_FORMS_ACCESS_CLIENT_SECRET: Redacted.make(formsAccessSecret),
      }
    : {}),
};

// The form endpoint's rate limit, per client IP for one request (never
// stored): a visitor sends a form a few times at most. Its namespace is a
// 32-bit FNV-1a hash of the Worker's name, as the consent endpoint's is
// (infra/consent.ts), so each Site and stage counts on its own.
const FORMS_RATE_LIMIT = { limit: 10, period: 60 } as const;
function formsRateLimiter(worker: string) {
  let hash = 0x811c9dc5;
  for (const character of `${worker}:forms`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }
  return Cloudflare.RateLimit("FORMS_RATE_LIMITER", {
    namespaceId: (hash % 2_000_000_000) + 1,
    simple: FORMS_RATE_LIMIT,
  });
}

// The Site's last-known-good published content. One database per Site and
// stage, separate from the Worker, so a redeploy or restart keeps it; Alchemy
// applies the Frontend's migrations, in order, before the Worker is updated.
// Production's is retained even if this declaration goes away.
const Publications = Effect.gen(function* () {
  const { stage } = yield* Stack;
  const production = stage === "prod";
  // The project's name stays in a constant, as in Website below.
  const database = "larkspur-fe-publications";
  return yield* Cloudflare.D1.Database("LarkspurPublications", {
    name: production ? database : `${database}-${stage}`,
    migrations: publicationMigrations ?? undefined,
  }).pipe(Alchemy.RemovalPolicy.retain(production));
});

export const Website = Cloudflare.Website.Astro(
  "LarkspurFrontend",
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const production = stage === "prod";
    // The project's name stays in constants: in the lines below, a shorter or
    // longer one would make the site's formatter rewrap them, editing this file.
    const worker = "larkspur-fe";
    const name = production ? worker : `${worker}-${stage}`;
    const publicEnv: Record<string, string> = production
      ? { PUBLIC_WORDPRESS_GRAPHQL_URL: graphqlUrl }
      : {};

    return {
      name,
      rootDir: "../apps/frontend",
      ...(production && !offboarded
        ? {
            domain: frontendTarget ?? productionHostname,
            ...(customHostnameRoutes ? { routes: customHostnameRoutes } : {}),
          }
        : {}),
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
        ...(ops.forms ? { FORMS_RATE_LIMITER: formsRateLimiter(name), ...formsSecrets } : {}),
        // Only production is behind the proxy.
        ...(production && trustedProxies ? { GQ_TRUSTED_PROXIES: trustedProxies } : {}),
      },
    };
  }),
);

export default Alchemy.Stack(
  "LarkspurFrontend",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Website;
    // Keep preview out of explicit Website.env; Alchemy still exposes bindings
    // to the build process. Build plugins and dependencies must be trusted.
    if (ops.preview) yield* site.bind`Preview`({ env: previewEnv });
    if (consentRecords) yield* ConsentPurge;

    return { url: site.url };
  }),
);
