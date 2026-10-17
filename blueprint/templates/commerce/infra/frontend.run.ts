import * as Alchemy from "alchemy";
import { Stack } from "alchemy/Stack";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { readFileSync } from "node:fs";

import { findStorefrontRuntime, storefrontBindings, type Ops } from "./storefront-bindings.ts";

// The commerce Site's storefront: a TanStack Start app built by Vite and
// deployed as one Worker (ADR 0017). Hostnames and rate-limit namespaces
// live in gq.ops.json, shared with the Ploi and deploy scripts.
const ops = JSON.parse(readFileSync(new URL("../gq.ops.json", import.meta.url), "utf8")) as Ops & {
  offboarded?: { phase: string };
};
const productionHostname = ops.domains.frontend;
// An offboarded Site (gq offboard) keeps no public URL: no custom domain, no
// workers.dev and no preview URLs. Its deploy scripts refuse to run anyway.
const offboarded = Boolean(ops.offboarded);

// The storefront Runtime, once the Frontend depends on it; until then the
// storefront deploys as a plain Worker with no bindings.
const runtime = findStorefrontRuntime(new URL("../apps/frontend/package.json", import.meta.url));

const RuntimeBindings = Effect.gen(function* () {
  const bindings: Cloudflare.WorkerBindingProps = {};
  if (runtime === undefined) return bindings;
  const { stage } = yield* Stack;
  const production = stage === "prod";
  const { databases, rateLimits, secrets, vars, missing } = storefrontBindings({
    ops,
    ...runtime,
    stage,
    env: process.env,
  });
  if (missing.length > 0) {
    throw new Error(`@quick-release/storefront needs ${missing.join(", ")} to deploy.`);
  }
  Object.assign(bindings, vars);
  // Each database is separate from the Worker, so a redeploy keeps it;
  // Alchemy applies the Runtime's migrations, in order, before the Worker is
  // updated. Production's is retained even if this declaration goes away.
  for (const { binding, name, migrations } of databases) {
    bindings[binding] = yield* Cloudflare.D1.Database(binding, { name, migrations }).pipe(
      Alchemy.RemovalPolicy.retain(production),
    );
  }
  for (const { binding, namespaceId, simple } of rateLimits) {
    bindings[binding] = Cloudflare.RateLimit(binding, {
      namespaceId,
      simple: { limit: simple.limit, period: simple.period as Cloudflare.RateLimitPeriod },
    });
  }
  for (const [name, value] of Object.entries(secrets)) bindings[name] = Redacted.make(value);
  return bindings;
});

export const Website = Cloudflare.Website.Vite(
  "{{Project}}Frontend",
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const production = stage === "prod";
    // The project's name stays in a constant: a shorter or longer one would
    // make the site's formatter rewrap these lines, editing this file.
    const worker = "{{project}}-fe";
    const name = production ? worker : `${worker}-${stage}`;

    return {
      name,
      rootDir: "../apps/frontend",
      ...(production && !offboarded ? { domain: productionHostname } : {}),
      workersDev: offboarded
        ? { enabled: false, previewsEnabled: false }
        : production
          ? { enabled: false, previewsEnabled: true }
          : true,
      compatibility: { date: "2026-07-18", flags: ["nodejs_compat"] },
      env: yield* RuntimeBindings,
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
