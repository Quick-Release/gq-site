// gq new and gq sync on a commerce site (ADR 0017), driven through run(): the
// variant alone selects the CMS and Frontend skeletons and the managed
// deploy, a second sync writes nothing, a managed edit is refused, and the
// content site's wiring (Astro, WPGraphQL, the publication store) is absent.
import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { runGq, temporaryDirectory } from "../support/fixture-site.mjs";
import { newSite, readSite, snapshot } from "../support/generated-site.mjs";

const COMMERCE_PLUGINS = [
  "gq-design",
  "woocommerce",
  "getquick-ecommerce",
  "gq-support",
  "s3-uploads",
  "simple-history",
  "cimo-image-optimizer",
  "safe-svg",
];

async function newCommerceSite(extra = []) {
  const parent = await temporaryDirectory();
  const created = await runGq(
    ["new", "shop", "--project", "shop", "--variant", "commerce", ...extra],
    { cwd: parent },
  );
  assert.equal(created.code, 0, created.stderr);
  const root = join(parent, "shop");
  return { root, created, run: (argv) => runGq(argv, { cwd: root }) };
}

async function exists(root, path) {
  try {
    await access(join(root, path));
    return true;
  } catch {
    return false;
  }
}

test("gq new --variant commerce writes a WooCommerce CMS without WPGraphQL", async () => {
  const site = await newCommerceSite();

  const manifest = JSON.parse(await readSite(site.root, "gq.ops.json"));
  assert.equal(manifest.variant, "commerce");
  assert.deepEqual(manifest.wordpress, { plugins: COMMERCE_PLUGINS, locale: "en_US" });
  const composer = JSON.parse(await readSite(site.root, "apps/cms/composer.json"));
  for (const plugin of COMMERCE_PLUGINS) {
    const installed = Object.keys(composer.require).some((name) => name.endsWith(`/${plugin}`));
    assert.ok(installed, plugin);
  }
  assert.equal(composer.require["wp-plugin/woocommerce"], "11.2.1");
  assert.equal(composer.require["getquick/getquick-ecommerce"], "0.3.5");
  assert.ok(!Object.keys(composer.require).some((name) => name.includes("graphql")));

  const deploy = await readSite(site.root, "deploy/ploi/admin.sh");
  assert.match(deploy, new RegExp(`^ {2}for plugin in ${COMMERCE_PLUGINS.join(" ")}; do$`, "mu"));
  assert.match(deploy, /^SITE_VARIANT="commerce"$/mu);
  assert.match(deploy, /^ {4}wp wc update$/mu);
  // WooCommerce's update runs after the plugins are active, before the
  // site's own deploy extensions.
  assert.ok(deploy.indexOf("wp wc update") > deploy.indexOf("wp plugin activate"));
  assert.ok(deploy.indexOf("wp wc update") < deploy.lastIndexOf("run_deploy_extensions\n"));

  const content = await newSite();
  assert.match(await readSite(content.root, "deploy/ploi/admin.sh"), /^SITE_VARIANT="content"$/mu);
});

test("a commerce site gets the storefront skeleton and none of the content Frontend", async () => {
  const site = await newCommerceSite();

  for (const path of [
    "apps/frontend/package.json",
    "apps/frontend/vite.config.ts",
    "apps/frontend/src/router.tsx",
    "apps/frontend/src/routeTree.gen.ts",
    "apps/frontend/src/routes/__root.tsx",
    "apps/frontend/src/routes/index.tsx",
    "apps/frontend/src/components/Home.tsx",
    "infra/frontend.run.ts",
    "infra/storefront-bindings.ts",
    "infra/scripts/deploy-frontend.mjs",
    ".npmrc",
  ]) {
    assert.ok(await exists(site.root, path), path);
  }
  for (const path of [
    "apps/frontend/astro.config.mjs",
    "apps/frontend/migrations",
    "apps/frontend/src/pages",
    "apps/cms/web/app/mu-plugins/content-api.php",
    "apps/cms/web/app/mu-plugins/publication-events.php",
    "apps/cms/web/app/mu-plugins/settings-events.php",
    "apps/cms/web/app/mu-plugins/delivery-retries.php",
  ]) {
    assert.ok(!(await exists(site.root, path)), path);
  }

  const frontend = JSON.parse(await readSite(site.root, "apps/frontend/package.json"));
  assert.equal(frontend.name, "@shop/frontend");
  assert.ok(frontend.dependencies["@tanstack/react-start"]);
  assert.equal(frontend.dependencies.astro, undefined);
  // The storefront Runtime isn't released with its auth contract yet: the
  // skeleton installs without it (ADR 0017).
  assert.equal(frontend.dependencies["@quick-release/storefront"], undefined);
  assert.equal(frontend.scripts.build, "vp build");
  assert.match(
    await readSite(site.root, "infra/frontend.run.ts"),
    /Cloudflare\.Website\.Vite\(\n {2}"ShopFrontend",/u,
  );

  // The registry is named; its token never is.
  const npmrc = await readSite(site.root, ".npmrc");
  assert.match(npmrc, /^@quick-release:registry=https:\/\/npm\.pkg\.github\.com$/mu);
  assert.doesNotMatch(npmrc, /^[^#].*_authToken/mu);

  const content = await newSite();
  assert.ok(!(await exists(content.root, ".npmrc")));
  assert.ok(await exists(content.root, "apps/frontend/astro.config.mjs"));
  assert.ok(!(await exists(content.root, "infra/storefront-bindings.ts")));
});

test("a commerce CMS's env templates have no GraphQL or publication-event settings", async () => {
  const site = await newCommerceSite();

  for (const path of ["apps/cms/.env.example", "apps/cms/.env.production.example"]) {
    const env = await readSite(site.root, path);
    assert.doesNotMatch(env, /GRAPHQL|PUBLICATION_EVENT/u, path);
  }
  assert.match(
    await readSite(site.root, "apps/cms/.env.production.example"),
    /^GETQUICK_STOREFRONT_PROXY_SECRET=''$/mu,
  );
  assert.match(
    await readSite(site.root, "apps/cms/.env.example"),
    /^GETQUICK_FRONTEND_URL='http:\/\/localhost:3000'$/mu,
  );
});

test("a commerce site gq new generated is in sync, and a managed edit is refused", async () => {
  const site = await newCommerceSite();
  const before = await snapshot(site.root);

  const check = await site.run(["sync", "--check"]);
  assert.equal(check.code, 0, check.stderr);
  const sync = await site.run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.deepEqual(await snapshot(site.root), before);

  await writeFile(join(site.root, ".npmrc"), "registry=https://example.test\n");
  const edited = await site.run(["sync"]);
  assert.equal(edited.code, 1);
  assert.match(edited.stderr, /Local edits to managed files: \.npmrc\./u);
});

test("a commerce site keeps its own storefront through gq sync", async () => {
  const site = await newCommerceSite();
  const home = join(site.root, "apps/frontend/src/components/Home.tsx");
  await writeFile(home, "export function Home() { return <main>Ours</main>; }\n");
  await rm(join(site.root, "apps/frontend/src/home.test.tsx"));

  const sync = await site.run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(
    await readFile(home, "utf8"),
    "export function Home() { return <main>Ours</main>; }\n",
  );
  assert.ok(!(await exists(site.root, "apps/frontend/src/home.test.tsx")));
});

test("gq new --variant commerce prints its provisioning, with no events, refresh or readiness", async () => {
  const site = await newCommerceSite(["--locale", "pt_PT_ao90"]);
  const { stdout } = site.created;

  assert.match(stdout, /^Created shop \(commerce, pt_PT_ao90\) in /u);
  for (const script of ["ploi:provision", "cf:media", "frontend:secrets", "ci:deploy"]) {
    assert.match(stdout, new RegExp(`^ {2}pnpm ${script} `, "mu"), script);
  }
  for (const script of ["ploi:events", "frontend:refresh", "site:check"]) {
    assert.doesNotMatch(stdout, new RegExp(`^ {2}pnpm ${script} `, "mu"), script);
  }
  assert.match(stdout, /no readiness check yet \(gq-site#26\)/u);
  assert.deepEqual(
    site.created.exec.calls.map(({ command }) => command),
    ["git"],
  );
});

test("a commerce manifest is monolingual, and records its rate-limit namespaces", async () => {
  const site = await newCommerceSite();
  const manifest = JSON.parse(await readSite(site.root, "gq.ops.json"));
  const write = (value) =>
    writeFile(join(site.root, "gq.ops.json"), `${JSON.stringify(value, null, 2)}\n`);

  await write({
    ...manifest,
    wordpress: { ...manifest.wordpress, languages: [{ locale: "pt_PT", slug: "pt" }] },
  });
  const languages = await site.run(["sync", "--check"]);
  assert.equal(languages.code, 1);
  assert.match(languages.stderr, /wordpress\.languages isn't supported on a commerce Site yet/u);

  await write({ ...manifest, cloudflare: { rateLimitNamespaces: { AUTH_IP_RATE_LIMITER: 0 } } });
  const invalid = await site.run(["sync", "--check"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /cloudflare\.rateLimitNamespaces/u);

  await write({ ...manifest, cloudflare: { rateLimitNamespaces: { AUTH_IP_RATE_LIMITER: 1004 } } });
  const valid = await site.run(["sync", "--check"]);
  assert.equal(valid.code, 0, valid.stderr);
});

// The storefront Runtime's declaration, shaped as @quick-release/storefront's
// infra.json is.
const STOREFRONT_INFRA = {
  d1Databases: [{ binding: "CART_SESSIONS", migrations: "migrations" }],
  rateLimits: [
    { binding: "AUTH_IDENTIFIER_RATE_LIMITER", simple: { limit: 8, period: 60 } },
    { binding: "AUTH_IP_RATE_LIMITER", simple: { limit: 80, period: 60 } },
  ],
  secrets: [
    { name: "GETQUICK_STOREFRONT_PROXY_SECRET", required: true },
    { name: "TURNSTILE_SECRET", required: "when sign-in is enabled" },
  ],
  vars: [
    { name: "GETQUICK_AUTH_UPSTREAM_URL", required: true },
    { name: "GETQUICK_ENVIRONMENT", required: true },
    { name: "GETQUICK_RELEASE", required: false },
  ],
};

// A commerce site whose Frontend depends on a stand-in storefront Runtime.
async function siteWithRuntime() {
  const site = await newCommerceSite();
  const runtime = join(site.root, "apps/frontend/node_modules/@quick-release/storefront");
  await mkdir(runtime, { recursive: true });
  await writeFile(
    join(runtime, "package.json"),
    JSON.stringify({ name: "@quick-release/storefront", version: "0.0.0-test" }),
  );
  await writeFile(join(runtime, "infra.json"), JSON.stringify(STOREFRONT_INFRA));
  const bindings = await import(pathToFileURL(join(site.root, "infra/storefront-bindings.ts")));
  const frontendPackage = pathToFileURL(join(site.root, "apps/frontend/package.json"));
  return { site, runtime, bindings, frontendPackage };
}

test("the storefront deploy applies the bindings the Runtime declares", async () => {
  const { runtime, bindings, frontendPackage } = await siteWithRuntime();
  const found = bindings.findStorefrontRuntime(frontendPackage);
  assert.equal(found.root, runtime);
  const ops = {
    project: "shop",
    domains: { admin: "shop-cms.example.test", frontend: "shop.example.test" },
    cloudflare: {
      rateLimitNamespaces: { AUTH_IDENTIFIER_RATE_LIMITER: 1004, AUTH_IP_RATE_LIMITER: 1005 },
    },
  };

  const production = bindings.storefrontBindings({
    ops,
    ...found,
    stage: "prod",
    env: { GETQUICK_STOREFRONT_PROXY_SECRET: "proxy-secret" },
  });
  assert.deepEqual(production, {
    databases: [
      {
        binding: "CART_SESSIONS",
        name: "shop-fe-cart-sessions",
        migrations: join(runtime, "migrations"),
      },
    ],
    rateLimits: [
      {
        binding: "AUTH_IDENTIFIER_RATE_LIMITER",
        namespaceId: 1004,
        simple: { limit: 8, period: 60 },
      },
      { binding: "AUTH_IP_RATE_LIMITER", namespaceId: 1005, simple: { limit: 80, period: 60 } },
    ],
    secrets: { GETQUICK_STOREFRONT_PROXY_SECRET: "proxy-secret" },
    vars: {
      GETQUICK_AUTH_UPSTREAM_URL:
        "https://shop-cms.example.test/wp-json/getquick-config/v1/woocommerce/auth",
      GETQUICK_ENVIRONMENT: "production",
    },
    missing: [],
  });

  const staging = bindings.storefrontBindings({ ops, ...found, stage: "staging", env: {} });
  assert.equal(staging.databases[0].name, "shop-fe-cart-sessions-staging");
  assert.equal(staging.vars.GETQUICK_ENVIRONMENT, "staging");
});

test("the storefront deploy names every binding it is missing, and none without the Runtime", async () => {
  const { bindings, frontendPackage } = await siteWithRuntime();
  const found = bindings.findStorefrontRuntime(frontendPackage);
  const { missing } = bindings.storefrontBindings({
    ops: { project: "shop", domains: { admin: "a.test", frontend: "f.test" } },
    ...found,
    stage: "prod",
    env: {},
  });
  assert.deepEqual(missing, [
    "gq.ops.json cloudflare.rateLimitNamespaces.AUTH_IDENTIFIER_RATE_LIMITER",
    "gq.ops.json cloudflare.rateLimitNamespaces.AUTH_IP_RATE_LIMITER",
    "GETQUICK_STOREFRONT_PROXY_SECRET",
  ]);

  // A storefront that doesn't depend on the Runtime yet gets no bindings.
  const plain = await newCommerceSite();
  const plainBindings = await import(
    pathToFileURL(join(plain.root, "infra/storefront-bindings.ts"))
  );
  const plainPackage = pathToFileURL(join(plain.root, "apps/frontend/package.json"));
  assert.equal(plainBindings.findStorefrontRuntime(plainPackage), undefined);
});

// The gated foundation FPA Shop and Bruaa started from: gq.ops.json, root
// tooling and an always-failing check, before any app.
const FOUNDATION = {
  "gq.ops.json": {
    $schema: "./node_modules/@getquick/site/schema/gq.ops.schema.json",
    schemaVersion: 1,
    project: "fpa-shop",
    variant: "commerce",
    github: { repository: "Quick-Release/fpa-shop" },
    wordpress: { plugins: [] },
    verify: { checks: [{ cmd: "sh", args: ["-c", "printf 'BLOCKED\\n'; exit 1"] }] },
  },
  "package.json": {
    name: "@fpa-shop/site",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: { prepare: "vp config --no-agent --hooks-dir .vite-hooks", format: "vp fmt" },
    devDependencies: { "@getquick/site": "0.18.1", "vite-plus": "1.1.0" },
    engines: { node: "24.21.0" },
    packageManager: "pnpm@12.6.0",
  },
  "pnpm-workspace.yaml": "packages: []\n",
  "vite.config.ts":
    'import { defineConfig } from "vite-plus";\n\nexport default defineConfig({});\n',
  ".vite-hooks/pre-commit": "#!/bin/sh\nvp staged\n",
  ".vite-hooks/pre-push": "#!/bin/sh\nvp run verify\n",
  "README.md": "# FPA Shop\n",
};

test("a gated commerce foundation adopts the commerce variant through gq sync", async () => {
  const root = await temporaryDirectory();
  for (const [path, content] of Object.entries(FOUNDATION)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
    await writeFile(join(root, path), text);
  }

  // As it stands, its own root tooling is in the way of the managed files.
  const refused = await runGq(["sync"], { cwd: root });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Local edits to managed files: /u);

  // Its adoption: remove what the blueprint now manages or creates, list the
  // commerce plugins, drop the blocked check, then sync.
  for (const path of ["vite.config.ts", ".vite-hooks", "pnpm-workspace.yaml"]) {
    await rm(join(root, path), { recursive: true });
  }
  const pkg = { ...FOUNDATION["package.json"] };
  delete pkg.engines;
  await writeFile(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const ops = { ...FOUNDATION["gq.ops.json"] };
  delete ops.verify;
  ops.wordpress = { plugins: COMMERCE_PLUGINS };
  await writeFile(join(root, "gq.ops.json"), `${JSON.stringify(ops, null, 2)}\n`);

  const adopted = await runGq(["sync"], { cwd: root });
  assert.equal(adopted.code, 0, adopted.stderr);
  for (const path of [
    "apps/cms/composer.json",
    "apps/frontend/vite.config.ts",
    "infra/frontend.run.ts",
    "pnpm-workspace.yaml",
  ]) {
    assert.ok(await exists(root, path), path);
  }
  assert.equal(await readSite(root, "README.md"), "# FPA Shop\n");
  const check = await runGq(["sync", "--check"], { cwd: root });
  assert.equal(check.code, 0, check.stderr);
});

// gq packages proposes and writes the content CMS's pins only (its catalogue
// reads one composer.json), so the commerce skeleton's must follow them: a
// requirement both install has the same constraint in both.
test("the commerce CMS skeleton pins every shared requirement as the content one does", async () => {
  const templates = new URL("../../blueprint/templates/", import.meta.url);
  const read = async (path) => JSON.parse(await readFile(new URL(path, templates), "utf8"));
  const content = await read("apps/cms/composer.json");
  const commerce = await read("commerce/apps/cms/composer.json");
  for (const section of ["require", "require-dev"]) {
    for (const [name, constraint] of Object.entries(commerce[section])) {
      if (Object.hasOwn(content[section], name)) {
        assert.equal(constraint, content[section][name], `${section} ${name}`);
      }
    }
  }
  assert.deepEqual(commerce.repositories, content.repositories);
  assert.deepEqual(commerce.config, content.config);
  // Only content installs WPGraphQL Blocks and its dependency patch.
  const {
    "patch:dependencies": patch,
    "post-autoload-dump": patchHook,
    ...sharedScripts
  } = content.scripts;
  assert.ok(patch);
  assert.deepEqual(patchHook, ["@patch:dependencies"]);
  assert.deepEqual(commerce.scripts, sharedScripts);
});
