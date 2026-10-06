import * as Alchemy from "alchemy";
import { Stack } from "alchemy/Stack";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Hostnames live in gq.ops.json (domains), shared with the Ploi and deploy scripts.
const ops = JSON.parse(readFileSync(new URL("../gq.ops.json", import.meta.url), "utf8")) as {
  domains: { frontend: string };
  offboarded?: { phase: string };
};
const productionHostname = ops.domains.frontend;
// An offboarded Site (gq offboard) keeps no public URL: no custom domain, no
// workers.dev and no preview URLs. Its deploy scripts refuse to run anyway.
const offboarded = Boolean(ops.offboarded);

// A Frontend that ships the publication store's migrations serves published
// content from it (durable delivery): new content sites do. A Frontend
// without them keeps reading the CMS on each request and gets no store.
const publicationMigrations = fileURLToPath(
  new URL("../apps/frontend/migrations", import.meta.url),
);
const durableDelivery = existsSync(publicationMigrations);

// The trusted refresh's credential and the key the CMS signs its publication
// events with, from Sigillo staging (CI releases get them from the CI Worker).
// Without one, the Worker refuses refreshes or events; what is already stored
// keeps being served.
const refreshToken = process.env.FRONTEND_REFRESH_TOKEN?.trim();
const eventSecret = process.env.PUBLICATION_EVENT_SECRET?.trim();

// Only the read-only edge identity belongs in the public Frontend's server.
// Automation credentials must never be bound to this Worker.
const graphqlClientId = process.env.GQ_AUTH_GRAPHQL_CLIENT_ID?.trim();
const graphqlClientSecret = process.env.GQ_AUTH_GRAPHQL_CLIENT_SECRET?.trim();
if (Boolean(graphqlClientId) !== Boolean(graphqlClientSecret)) {
  throw new Error(
    "GQ_AUTH_GRAPHQL_CLIENT_ID and GQ_AUTH_GRAPHQL_CLIENT_SECRET must be set together.",
  );
}
const cmsSecrets =
  graphqlClientId && graphqlClientSecret
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
    migrations: publicationMigrations,
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
      env: durableDelivery
        ? {
            ...cmsSecrets,
            PUBLICATION_DB: yield* Publications,
            ...(refreshToken ? { FRONTEND_REFRESH_TOKEN: Redacted.make(refreshToken) } : {}),
            ...(eventSecret ? { PUBLICATION_EVENT_SECRET: Redacted.make(eventSecret) } : {}),
          }
        : cmsSecrets,
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

    return { url: site.url };
  }),
);
