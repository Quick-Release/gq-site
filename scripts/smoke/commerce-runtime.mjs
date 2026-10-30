#!/usr/bin/env node

// The storefront Runtime proofs commerce-check.sh runs in a generated,
// installed and built commerce Site (#89 slice 6):
//
// - the built Frontend mounts the Runtime: outside workerd it has no Worker
//   bindings, so its BFFs answer their own 503s at /api/store/* and
//   /api/auth/*, not the page;
// - the deploy plan (infra/storefront-bindings.ts) declares every binding the
//   installed package's infra.json requires;
// - infra/scripts/deploy-frontend.mjs, in a bare environment, refuses to run
//   and names each secret and rate-limit namespace it lacks.
//
//   node scripts/smoke/commerce-runtime.mjs <site>
//
// Nothing is deployed: the deploy script refuses before it starts Alchemy,
// and it runs with no Cloudflare credential.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const site = process.argv[2];
if (!site) throw new Error("Usage: commerce-runtime.mjs <site>");

// The built Frontend's routes.
const server = (await import(pathToFileURL(join(site, "apps/frontend/dist/server/server.js"))))
  .default;
const quiet = { ...console };
for (const [path, code] of [
  ["/api/store/cart", "getquick_store_unavailable"],
  ["/api/auth/session", "getquick_auth_unavailable"],
]) {
  // The BFFs log each operation as JSON; that isn't this proof's output.
  for (const method of ["log", "info", "warn", "error"]) console[method] = () => {};
  const response = await server.fetch(new Request(`http://localhost:3000${path}`));
  Object.assign(console, quiet);
  const body = await response.json().catch(() => ({}));
  if (response.status !== 503 || body.code !== code) {
    throw new Error(
      `${path} answered ${response.status} ${JSON.stringify(body)}, not the Runtime's ${code}.`,
    );
  }
  console.log(`${path}: the storefront Runtime answered ${code} (no bindings outside workerd).`);
}

// The deploy plan against the installed package's declaration.
const { findStorefrontRuntime, storefrontBindings } = await import(
  pathToFileURL(join(site, "infra/storefront-bindings.ts"))
);
const runtime = findStorefrontRuntime(pathToFileURL(join(site, "apps/frontend/package.json")));
if (!runtime) throw new Error("infra/storefront-bindings.ts finds no storefront Runtime.");
const { infra } = runtime;
const ops = JSON.parse(readFileSync(join(site, "gq.ops.json"), "utf8"));
ops.domains = { admin: "shop-cms.example.test", frontend: "shop.example.test" };
ops.cloudflare = {
  rateLimitNamespaces: Object.fromEntries(
    infra.rateLimits.map(({ binding }, index) => [binding, 9000 + index]),
  ),
};
const env = Object.fromEntries(infra.secrets.map(({ name }) => [name, "set"]));
const plan = storefrontBindings({ ops, ...runtime, stage: "prod", env });
const declared = [
  ...plan.databases.map(({ binding }) => binding),
  ...plan.rateLimits.map(({ binding }) => binding),
  ...Object.keys(plan.secrets),
  ...Object.keys(plan.vars),
];
const required = [
  ...infra.d1Databases.map(({ binding }) => binding),
  ...infra.rateLimits.map(({ binding }) => binding),
  ...infra.secrets.map(({ name }) => name),
  ...infra.vars.filter(({ required }) => required === true).map(({ name }) => name),
];
const absent = required.filter((name) => !declared.includes(name));
if (plan.missing.length > 0 || absent.length > 0) {
  throw new Error(`The deploy plan lacks ${[...plan.missing, ...absent].join(", ")}.`);
}
console.log(`The deploy plan declares ${declared.join(", ")}.`);

// The deploy, with no secret, namespace or Cloudflare credential.
const result = spawnSync(process.execPath, ["infra/scripts/deploy-frontend.mjs"], {
  cwd: site,
  encoding: "utf8",
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
});
const refusal = `${result.stdout}${result.stderr}`.trim();
if (result.status === 0)
  throw new Error("deploy-frontend.mjs ran without the storefront's secrets.");
const unnamed = [
  ...infra.secrets.filter(({ required }) => required === true).map(({ name }) => name),
  // gq new leaves domains to provisioning, so the auth upstream is unknown too.
  "gq.ops.json domains.admin",
  ...infra.rateLimits.map(({ binding }) => `cloudflare.rateLimitNamespaces.${binding}`),
].filter((name) => !refusal.includes(name));
if (unnamed.length > 0) {
  throw new Error(`deploy-frontend.mjs refused without naming ${unnamed.join(", ")}: ${refusal}`);
}
console.log(`deploy-frontend.mjs refuses without them: ${refusal}`);
