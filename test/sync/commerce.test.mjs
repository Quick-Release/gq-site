// gq new and gq sync on a commerce site (ADR 0017), driven through run(): the
// variant alone selects the CMS and Frontend skeletons and the managed
// deploy, a second sync writes nothing, a managed edit is refused, and the
// content site's wiring (Astro, WPGraphQL, the publication store) is absent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { deploy } from "../support/deploy-script.mjs";
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
  assert.equal(composer.require["getquick/getquick-ecommerce"], "0.4.3");
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

test("a commerce CMS deploy updates WooCommerce's database and patches no content dependency", async () => {
  const site = await newCommerceSite();
  const script = await readSite(site.root, "deploy/ploi/admin.sh");
  for (const composerOnly of [false, true]) {
    const result = await deploy(script, { composerOnly });
    assert.equal(result.code, 0, result.output);
    assert.ok(
      !result.calls.some(([tool, arg]) => tool === "php" && /patch-dependencies/u.test(arg)),
    );
    const updates = result.calls.filter(
      ([tool, ...args]) => tool === "wp" && args.join(" ") === "wc update",
    );
    assert.equal(updates.length, composerOnly ? 0 : 1);
    // Pretty permalinks, so the storefront's Store API and auth upstreams
    // reach /wp-json/ instead of GQ Config's redirect to the Frontend.
    const structure = result.calls.filter(
      ([tool, ...args]) =>
        tool === "wp" && args.join(" ") === "rewrite structure /%postname%/ --quiet",
    );
    assert.equal(structure.length, composerOnly ? 0 : 1);
  }
});

test("gq new refuses an Astro commerce Frontend", async () => {
  const parent = await temporaryDirectory();
  const result = await runGq(
    ["new", "shop", "--project", "shop", "--variant", "commerce", "--framework", "astro"],
    { cwd: parent },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--framework astro is for content Sites/u);
  assert.ok(!(await exists(parent, "shop")));
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
    "apps/frontend/src/storefront.server.ts",
    "apps/frontend/src/routes/api.auth.$.ts",
    "apps/frontend/src/routes/api.store.$.ts",
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
    // The content Runtime's wiring: consent, its purge Worker, the
    // TanStack content routes and the wpgraphql-blocks patch.
    "infra/consent.ts",
    "apps/frontend/workers",
    "apps/frontend/src/routes/gq.events.ts",
    "apps/frontend/src/routes/gq.refresh.ts",
    "apps/frontend/src/lib/content.ts",
    "apps/cms/scripts/patch-dependencies.php",
    "apps/cms/patches",
  ]) {
    assert.ok(!(await exists(site.root, path)), path);
  }
  const ops = JSON.parse(await readSite(site.root, "gq.ops.json"));
  assert.equal(ops.framework, "tanstack");
  assert.equal(ops.contentRuntime, undefined);

  const frontend = JSON.parse(await readSite(site.root, "apps/frontend/package.json"));
  assert.equal(frontend.name, "@shop/frontend");
  assert.ok(frontend.dependencies["@tanstack/react-start"]);
  assert.equal(frontend.dependencies.astro, undefined);
  // The storefront Runtime and its auth contract, pinned exactly, from
  // GitHub Packages (#89 slice 6); nothing from Ekis.
  assert.equal(frontend.dependencies["@quick-release/storefront"], "0.2.2");
  assert.equal(frontend.dependencies["@quick-release/auth-contract"], "0.1.9");
  assert.ok(frontend.dependencies["@tanstack/react-query"]);
  assert.doesNotMatch(JSON.stringify(frontend), /ekis|github:|git\+|file:|link:/iu);
  // GQ Design's npm packages, as managed keys, at its plugin's version (ADR 0018).
  const plugin = JSON.parse(await readSite(site.root, "apps/cms/composer.json")).require[
    "getquick/gq-design"
  ];
  assert.equal(plugin, "0.9.4");
  assert.equal(frontend.dependencies["@quick-release/design-contract"], plugin);
  assert.equal(frontend.dependencies["@quick-release/design-renderer"], plugin);
  assert.equal(frontend.scripts.build, "vp build");
  // Mounted at /api/auth/* and /api/store/*, with the Runtime's Query client.
  for (const [route, handler] of [
    ["api.auth.$.ts", "handleAuthRequest"],
    ["api.store.$.ts", "handleStoreApiRequest"],
  ]) {
    const source = await readSite(site.root, `apps/frontend/src/routes/${route}`);
    assert.match(source, new RegExp(`\\(await storefront\\(\\)\\)\\.${handler}\\(request\\)`, "u"));
  }
  assert.match(
    await readSite(site.root, "apps/frontend/src/storefront.server.ts"),
    /createStorefrontRuntime\(\{/u,
  );
  assert.match(
    await readSite(site.root, "apps/frontend/src/router.tsx"),
    /const queryClient = createStorefrontQueryClient\(\);/u,
  );
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

// The Site's formatter (vp fmt, sortPackageJson) keeps dependencies in
// order, so gq sync adds a managed dependency where it sorts; appended, the
// pre-commit hook would move it and the next sync would see an edit.
test("gq sync adds GQ Design's packages where they sort in a sorted dependency map", async () => {
  const site = await newCommerceSite();
  const path = join(site.root, "apps/frontend/package.json");
  const designless = (dependencies) =>
    Object.fromEntries(
      Object.entries(dependencies).filter(([name]) => !name.startsWith("@quick-release/design-")),
    );
  const frontend = JSON.parse(await readFile(path, "utf8"));
  const generated = Object.keys(frontend.dependencies);
  assert.deepEqual(generated, generated.toSorted());

  await writeFile(
    path,
    `${JSON.stringify({ ...frontend, dependencies: designless(frontend.dependencies) }, null, 2)}\n`,
  );
  const sorted = await site.run(["sync"]);
  assert.equal(sorted.code, 0, sorted.stderr);
  const text = await readFile(path, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(text).dependencies), generated);
  assert.match(
    text,
    /\n {4}"@quick-release\/auth-contract": "0\.1\.9",\n {4}"@quick-release\/design-contract": "0\.9\.4",\n {4}"@quick-release\/design-renderer": "0\.9\.4",\n {4}"@quick-release\/storefront"/u,
  );

  // A map the site keeps in its own order gets them after its siblings.
  const { react, ...rest } = designless(frontend.dependencies);
  await writeFile(
    path,
    `${JSON.stringify({ ...frontend, dependencies: { react, ...rest } }, null, 2)}\n`,
  );
  const appended = await site.run(["sync"]);
  assert.equal(appended.code, 0, appended.stderr);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8")).dependencies), [
    "react",
    ...Object.keys(rest),
    "@quick-release/design-contract",
    "@quick-release/design-renderer",
  ]);
});

test("gq new --variant commerce prints its provisioning, with no events or refresh, ending at readiness", async () => {
  const site = await newCommerceSite(["--locale", "pt_PT_ao90"]);
  const { stdout } = site.created;

  assert.match(stdout, /^Created shop \(commerce, pt_PT_ao90\) in /u);
  for (const script of ["ploi:provision", "cf:media", "frontend:secrets", "ci:deploy"]) {
    assert.match(stdout, new RegExp(`^ {2}pnpm ${script} `, "mu"), script);
  }
  for (const script of ["ploi:events", "frontend:refresh"]) {
    assert.doesNotMatch(stdout, new RegExp(`^ {2}pnpm ${script} `, "mu"), script);
  }
  assert.match(stdout, /^ {2}pnpm site:check {11}# gq site check$/mu);
  assert.match(stdout, /Ready only when every part holds \(ADR 0021\)/u);
  assert.doesNotMatch(stdout, /#26/u);
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

test("a deploy before provisioning names the domain the auth upstream needs", async () => {
  const { bindings, frontendPackage } = await siteWithRuntime();
  const found = bindings.findStorefrontRuntime(frontendPackage);
  const { missing, vars } = bindings.storefrontBindings({
    ops: { project: "shop" },
    ...found,
    stage: "prod",
    env: { GETQUICK_STOREFRONT_PROXY_SECRET: "proxy-secret" },
  });
  assert.ok(missing.includes("gq.ops.json domains.admin"), missing.join(", "));
  assert.equal(vars.GETQUICK_AUTH_UPSTREAM_URL, undefined);
});

test("a commerce site's CI installs @quick-release packages with the packages token and deploys the storefront's secrets", async () => {
  const site = await newCommerceSite();
  const ci = await readSite(site.root, "infra/ci/cloudflare.ci.ts");
  const env = await readSite(site.root, "infra/ci/env.ts");
  for (const name of [
    "GETQUICK_STOREFRONT_PROXY_SECRET",
    "GETQUICK_AUTH_COOKIE_SECRET",
    "GETQUICK_CART_SESSION_SECRET",
    "TURNSTILE_SECRET",
  ]) {
    assert.match(ci, new RegExp(`^ {2}"${name}",$`, "mu"), name);
    assert.match(env, new RegExp(`^ {2}${name}\\?: string;$`, "mu"), name);
  }
  assert.match(env, /^ {2}GITHUB_PACKAGES_TOKEN\?: string;$/mu);
  // The content Frontend's secrets aren't a storefront's.
  assert.doesNotMatch(ci, /PUBLICATION_EVENT_SECRET|FRONTEND_REFRESH_TOKEN/u);
  assert.match(
    ci,
    /secrets: \["COMPOSER_AUTH", \.\.\.\(packagesToken \? \["GITHUB_PACKAGES_TOKEN"\] : \[\]\)\]/u,
  );
  assert.match(ci, /`\$\{packagesLogin\} && ` \+\n\s+"pnpm install --frozen-lockfile && "/u);

  // The install step's login, run as the step's shell would.
  const [, expression] = /const packagesLogin =([\s\S]*?);\n/u.exec(ci);
  const login = new Function(`return (${expression});`)();
  const home = await temporaryDirectory();
  const shell = (extra) =>
    spawnSync("sh", ["-c", login], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, ...extra },
    });
  const refused = shell({});
  assert.equal(refused.status, 1);
  assert.match(
    refused.stderr,
    /GITHUB_PACKAGES_TOKEN is missing: .*Run pnpm ci:deploy, which gives this Worker the fleet token from GQ Platform ops/u,
  );
  assert.ok(!(await exists(home, ".npmrc")));
  const token = "ghp_fixture-packages-token";
  const written = shell({ GITHUB_PACKAGES_TOKEN: token });
  assert.equal(written.status, 0, written.stderr);
  assert.equal(
    await readFile(join(home, ".npmrc"), "utf8"),
    `//npm.pkg.github.com/:_authToken=${token}\n`,
  );
  assert.equal((await stat(join(home, ".npmrc"))).mode & 0o777, 0o600);
  assert.ok(
    !login.includes(token) && !written.stdout.includes(token) && !written.stderr.includes(token),
  );

  // A content site's CI is unchanged: none of this.
  const content = await newSite();
  assert.doesNotMatch(
    await readSite(content.root, "infra/ci/cloudflare.ci.ts"),
    /GITHUB_PACKAGES_TOKEN|GETQUICK_/u,
  );
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

  // Installing the bumped @getquick/site, to run its gq, makes pnpm write a
  // pnpm-workspace.yaml of its own, with no packages.
  const stub = "allowBuilds:\n  esbuild: true\n";
  await writeFile(join(root, "pnpm-workspace.yaml"), stub);

  const adopted = await runGq(["sync"], { cwd: root });
  assert.equal(adopted.code, 0, adopted.stderr);
  for (const path of [
    "apps/cms/composer.json",
    "apps/frontend/vite.config.ts",
    "infra/frontend.run.ts",
  ]) {
    assert.ok(await exists(root, path), path);
  }
  assert.equal(await readSite(root, "README.md"), "# FPA Shop\n");
  // Sync keeps both files it doesn't own, and names what each lacks.
  assert.equal(await readSite(root, "pnpm-workspace.yaml"), stub);
  const missing = [
    "scripts.dev",
    "scripts.frontend:dev",
    "scripts.build",
    "scripts.check",
    "scripts.lint",
    "scripts.test",
    "devDependencies.sigillo",
    "devDependencies.vite",
  ];
  assert.equal(
    adopted.stderr,
    "warning: pnpm-workspace.yaml lists no workspace packages, so pnpm installs none of the " +
      "Site's apps (pnpm writes such a file when it installs before gq sync creates the " +
      "blueprint's, and gq sync never replaces a file it creates once). " +
      "Run gq sync --recreate pnpm-workspace.yaml.\n" +
      `warning: package.json lacks keys a new Site's package.json starts with: ${missing.join(", ")}. ` +
      "Run gq sync --recreate package.json (adds them, and changes no key package.json has).\n",
  );
  const pending = await runGq(["sync", "--check"], { cwd: root });
  assert.equal(pending.code, 0, pending.stderr);
  assert.match(pending.stderr, /warning: pnpm-workspace\.yaml lists no workspace packages/u);

  const recreated = await runGq(
    ["sync", "--recreate", "pnpm-workspace.yaml", "--recreate", "package.json"],
    { cwd: root },
  );
  assert.equal(recreated.code, 0, recreated.stderr);
  assert.equal(recreated.stderr, "");
  assert.match(
    recreated.stdout,
    new RegExp(`^package\\.json: updated \\(initial keys ${missing.join(", ")}\\)\\.$`, "mu"),
  );
  assert.match(await readSite(root, "pnpm-workspace.yaml"), /^packages:\n {2}- "apps\/\*"$/mu);
  const merged = JSON.parse(await readSite(root, "package.json"));
  // What the file had stays: its name, its format script, its vite-plus pin.
  assert.equal(merged.name, "@fpa-shop/site");
  assert.equal(merged.scripts.format, "vp fmt");
  assert.equal(merged.scripts.check, "pnpm --filter @fpa-shop/frontend check");
  assert.equal(merged.devDependencies["vite-plus"], "1.1.0");
  assert.equal(merged.devDependencies.vite, "catalog:");
  assert.deepEqual(Object.keys(merged.devDependencies), [
    "@getquick/site",
    "sigillo",
    "vite",
    "vite-plus",
  ]);
  // The added keys are the Site's: the lock doesn't record them.
  const lock = JSON.parse(await readSite(root, "gq.lock.json"));
  assert.equal(lock.keys["package.json"]["scripts.check"], undefined);
  const check = await runGq(["sync", "--check"], { cwd: root });
  assert.equal(check.code, 0, check.stderr);
  assert.equal(check.stderr, "");
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
  // Less the wpgraphql-blocks patch, a dependency commerce doesn't install.
  const shared = { ...content.scripts };
  delete shared["patch:dependencies"];
  delete shared["post-autoload-dump"];
  assert.deepEqual(commerce.scripts, shared);
});
