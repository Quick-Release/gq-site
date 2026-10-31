import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// What the storefront Runtime (@quick-release/storefront) declares it needs
// from Cloudflare, in its package's infra.json, resolved for one deploy: the
// Site applies the declaration and copies no binding list (ADR 0017). No
// Alchemy here, so the deploy script and gq's tests can check it alone.

export interface Declared {
  name: string;
  /** true: always required; a string: required only for that feature. */
  required: boolean | string;
}

export interface StorefrontInfra {
  d1Databases: Array<{ binding: string; migrations: string }>;
  rateLimits: Array<{ binding: string; simple: { limit: number; period: number } }>;
  secrets: Declared[];
  vars: Declared[];
}

export interface Ops {
  project: string;
  domains: { admin: string; frontend: string };
  cloudflare?: { rateLimitNamespaces?: Record<string, number> };
}

export interface StorefrontBindings {
  databases: Array<{ binding: string; name: string; migrations: string }>;
  rateLimits: Array<{
    binding: string;
    namespaceId: number;
    simple: { limit: number; period: number };
  }>;
  secrets: Record<string, string>;
  vars: Record<string, string>;
  /** What the deploy can't go ahead without, by name. */
  missing: string[];
}

/** The Runtime's package directory and declaration, or undefined while the Frontend doesn't depend on it. */
export function findStorefrontRuntime(
  frontendPackage: URL,
): { root: string; infra: StorefrontInfra } | undefined {
  let manifest: string;
  try {
    manifest = createRequire(frontendPackage).resolve("@quick-release/storefront/package.json");
  } catch {
    return undefined;
  }
  const root = path.dirname(manifest);
  const infra = JSON.parse(readFileSync(path.join(root, "infra.json"), "utf8")) as StorefrontInfra;
  return { root, infra };
}

/**
 * The bindings one stage's Worker gets. Databases are the Site's own, per
 * stage. Rate-limit namespace IDs are per Cloudflare account, so each Site
 * records its own in gq.ops.json: two Sites sharing one would share counters.
 * A secret or variable the Runtime always requires must be set; one it needs
 * only for a feature may be left out.
 */
export function storefrontBindings({
  ops,
  root,
  infra,
  stage,
  env,
}: {
  ops: Ops;
  root: string;
  infra: StorefrontInfra;
  stage: string;
  env: Record<string, string | undefined>;
}): StorefrontBindings {
  const production = stage === "prod";
  const missing: string[] = [];

  const databases = infra.d1Databases.map(({ binding, migrations }) => {
    const database = `${ops.project}-fe-${binding.toLowerCase().replaceAll("_", "-")}`;
    return {
      binding,
      name: production ? database : `${database}-${stage}`,
      migrations: path.join(root, migrations),
    };
  });

  const namespaces = ops.cloudflare?.rateLimitNamespaces ?? {};
  const rateLimits = [];
  for (const { binding, simple } of infra.rateLimits) {
    const namespaceId = namespaces[binding];
    if (namespaceId === undefined)
      missing.push(`gq.ops.json cloudflare.rateLimitNamespaces.${binding}`);
    else rateLimits.push({ binding, namespaceId, simple });
  }

  const secrets: Record<string, string> = {};
  for (const declared of infra.secrets) {
    const value = env[declared.name]?.trim();
    if (value) secrets[declared.name] = value;
    else if (declared.required === true) missing.push(declared.name);
  }

  // Variables gq knows the value of; any other comes from the environment.
  // A Site not yet provisioned has no domains: the auth upstream then names
  // the domain it is missing, rather than crashing.
  const admin = (ops.domains as Ops["domains"] | undefined)?.admin;
  const known: Record<string, string> = {
    ...(admin
      ? {
          GETQUICK_AUTH_UPSTREAM_URL: `https://${admin}/wp-json/getquick-config/v1/woocommerce/auth`,
        }
      : {}),
    GETQUICK_ENVIRONMENT: production ? "production" : stage,
  };
  const vars: Record<string, string> = {};
  for (const declared of infra.vars) {
    const value = env[declared.name]?.trim() || known[declared.name];
    if (value) vars[declared.name] = value;
    else if (declared.required !== true) continue;
    else if (declared.name === "GETQUICK_AUTH_UPSTREAM_URL" && !admin) {
      missing.push("gq.ops.json domains.admin");
    } else missing.push(declared.name);
  }

  return { databases, rateLimits, secrets, vars, missing };
}
