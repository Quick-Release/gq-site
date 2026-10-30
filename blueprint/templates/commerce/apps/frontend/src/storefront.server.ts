import "@tanstack/react-start/server-only";
import {
  createStorefrontRuntime,
  type StorefrontBindings,
  type StorefrontRuntime,
} from "@quick-release/storefront/server";

import ops from "../../../gq.ops.json";

// The storefront Runtime (@quick-release/storefront), mounted behind this
// Worker at /api/auth/* and /api/store/* (routes/api.auth.$.ts and
// routes/api.store.$.ts): the same-origin BFF to WooCommerce's Store API and
// GQ eCommerce's customer auth. Its bindings (the cart-session database, rate
// limiters, secrets and variables) are the ones its infra.json declares,
// which infra/frontend.run.ts binds; this file only says which Site it serves.

const domains = (ops as { domains?: { admin: string; frontend: string } }).domains;

// The CMS's DDEV project, which local development reads. Its own constant, so
// no line's length depends on the project name's.
const ddevProject = "{{project}}-admin";

// vp dev serves the storefront at http://localhost:3000 and reads DDEV's CMS;
// a build serves gq.ops.json's domains.
const local = import.meta.env.DEV || !domains;
const storefrontUrl = local ? "http://localhost:3000" : `https://${domains.frontend}`;
const cms = local ? `https://${ddevProject}.ddev.site` : `https://${domains.admin}`;

/**
 * The deployed Worker's bindings. `vp dev` and tests run outside workerd,
 * where `cloudflare:workers` doesn't exist: there are none, and the Runtime
 * answers each request that needs one 503.
 */
async function bindings(): Promise<StorefrontBindings> {
  const workers = await import("cloudflare:workers").catch(() => null);
  return (workers?.env ?? {}) as StorefrontBindings;
}

let runtime: Promise<StorefrontRuntime> | undefined;

/** The Site's storefront Runtime, made once per Worker isolate. */
export function storefront(): Promise<StorefrontRuntime> {
  runtime ??= bindings().then((env) =>
    createStorefrontRuntime({
      env,
      storefrontUrl,
      storeApiUrl: `${cms}/wp-json/wc/store/v1`,
      wordpressApiUrl: `${cms}/wp-json/`,
    }),
  );
  return runtime;
}
