import * as Alchemy from "alchemy";
import { Stack } from "alchemy/Stack";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Visitors' consent records (CONSENT-1; ADR 0019): the first store a visitor's
// request writes, kept apart from the publication store, whose "visitor
// requests never write" guarantee is unchanged. The consent Runtime
// (@getquick/content's consent exports) owns the endpoints, the schema and the
// purge; this file only provisions what it needs.

const frontendApp = new URL("../apps/frontend/", import.meta.url);

// A Frontend opts in by depending on a consent Runtime: @getquick/content with
// its `./consent/migrations` export installed in apps/frontend. Without it,
// nothing here is created and the Frontend's deploy is unchanged.
async function installedConsentMigrations(): Promise<string | null> {
  const manifest = new URL("node_modules/@getquick/content/package.json", frontendApp);
  if (!existsSync(manifest)) return null;
  const exports = JSON.parse(readFileSync(manifest, "utf8")).exports ?? {};
  const entry = exports["./consent/migrations"]?.import;
  if (typeof entry !== "string") return null;
  const module = (await import(new URL(entry, manifest).href)) as {
    consentMigrationsDirectory: string;
  };
  return module.consentMigrationsDirectory;
}

const consentMigrations = await installedConsentMigrations();
export const consentRecords = consentMigrations !== null;

// Cloudflare sets a D1 database's jurisdiction when it creates it and can't
// change it afterwards: the database must be created in the EU the first
// time, on every stage. gq doctor fails on one that isn't.
export const CONSENT_JURISDICTION = "eu";

// The retention purge runs daily, at a quiet hour (UTC).
export const CONSENT_PURGE_SCHEDULE = "17 3 * * *";

// The record endpoint's rate limit, per client IP for one request (never
// stored): a visitor decides a few times at most.
const CONSENT_RATE_LIMIT = { limit: 30, period: 60 } as const;

// The Site's consent records, one database per Site and stage, retained in
// production even if this declaration goes away. Alchemy applies the consent
// Runtime's migrations, in order, before the Workers that bind it change.
export const ConsentDatabase = Effect.gen(function* () {
  const { stage } = yield* Stack;
  const production = stage === "prod";
  // The project's name stays in a constant, as in frontend.run.ts.
  const database = "larkspur-fe-consent";
  return yield* Cloudflare.D1.Database("LarkspurConsent", {
    name: production ? database : `${database}-${stage}`,
    jurisdiction: CONSENT_JURISDICTION,
    migrations: consentMigrations ?? undefined,
  }).pipe(Alchemy.RemovalPolicy.retain(production));
});

// A Workers Rate Limiting binding for the record endpoint. Its namespace is
// derived from the Worker's name, so each Site and stage counts on its own.
export function consentRateLimiter(worker: string) {
  let hash = 0x811c9dc5;
  for (const character of `${worker}:consent`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }
  return Cloudflare.RateLimit("CONSENT_RATE_LIMITER", {
    namespaceId: (hash % 2_000_000_000) + 1,
    simple: CONSENT_RATE_LIMIT,
  });
}

// The retention purge (CN-R10) on a cron trigger. A Worker of its own, so it
// works the same whatever the Frontend's framework exports: Astro's Worker
// has no scheduled handler. It has no public URL. Its entry,
// apps/frontend/workers/consent-purge.ts, calls the consent Runtime's purge.
export const ConsentPurge = Cloudflare.Worker(
  "LarkspurConsentPurge",
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const production = stage === "prod";
    // The project's name stays in constants, as in frontend.run.ts.
    const worker = "larkspur-fe-consent-purge";
    const site = "larkspur";
    return {
      name: production ? worker : `${worker}-${stage}`,
      main: fileURLToPath(new URL("workers/consent-purge.ts", frontendApp)),
      crons: [CONSENT_PURGE_SCHEDULE],
      workersDev: false,
      env: { SITE_ID: site, CONSENT_DB: yield* ConsentDatabase },
    };
  }),
);
