import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import ownCatalogue from "../../blueprint/packages.json" with { type: "json" };
import ownComposer from "../../blueprint/templates/apps/cms/composer.json" with { type: "json" };
import { catalogueProblems } from "../../src/packages/catalogue.mjs";
import { compareVersions, parseCaret, parseVersion } from "../../src/packages/versions.mjs";
import { json, recordingFetch, runGq, temporaryDirectory } from "../support/fixture-site.mjs";

const REGISTRY = "https://proxy.composer.example";
const LOGIN = { username: "fixture-site", password: "s3cret-registry-password" };
const COMPOSER_AUTH = JSON.stringify({
  "http-basic": { "proxy.composer.example": LOGIN },
});
const GITHUB_TOKEN = "ghp_fixture-token";
const ENV = { COMPOSER_AUTH, GITHUB_TOKEN };

// Deliberately uneven formatting and site-like keys, which --write keeps.
const COMPOSER_TEXT = `{
  "name": "getquick/{{project}}-cms",
  "repositories": [
    { "name": "getquick", "type": "composer", "url": "${REGISTRY}", "only": ["getquick/*"] },
    { "name": "wp-packages", "type": "composer", "url": "https://repo.example" }
  ],
  "require": {
    "php": ">=8.3",
    "getquick/alpha":   "^0.3.1",
    "getquick/beta": "^1.2.0",
    "roots/wordpress": "7.1.2",
    "wp-plugin/site-specific": "^4.0"
  },
  "require-dev": { "getquick/alpha": "^0.3.1" },
  "extra": { "custom": { "keep": true } }
}
`;

const CATALOGUE = {
  schemaVersion: 1,
  composerFile: "templates/apps/cms/composer.json",
  packages: [
    {
      name: "getquick/alpha",
      upstream: { repository: "Quick-Release/alpha", discovery: "tags" },
      install: { registry: "getquick" },
      variants: ["content"],
      requirement: "blueprint",
      policy: "caret",
      formerNames: ["getquick/old-alpha"],
    },
    {
      name: "getquick/beta",
      upstream: { repository: "Quick-Release/beta", discovery: "tags" },
      install: { registry: "getquick" },
      variants: ["content"],
      requirement: "blueprint",
      policy: "caret",
    },
    {
      name: "getquick/gamma-theme",
      upstream: {
        repository: "Quick-Release/gamma-theme",
        discovery: "releases",
        asset: "gamma-theme-{version}.zip",
      },
      install: { registry: "getquick" },
      variants: [],
      requirement: "none",
      policy: "manual",
      migrations: [
        {
          kind: "replace",
          from: "getquick/beta",
          status: "unplanned",
          reason: "beta registers the menu location the Frontend reads.",
        },
      ],
    },
  ],
};

// A world where every package is current except alpha (0.3.3 is out).
function defaultWorld() {
  return {
    github: {
      "Quick-Release/alpha": { tags: ["v0.3.3", "v0.3.1", "v0.3.2"], name: "getquick/alpha" },
      "Quick-Release/beta": { tags: ["v1.2.0"], name: "getquick/beta" },
      "Quick-Release/gamma-theme": {
        releases: [{ tag: "v0.1.0", assets: ["gamma-theme-0.1.0.zip"] }],
        name: "getquick/gamma-theme",
      },
    },
    registry: {
      "getquick/alpha": ["0.3.1", "0.3.2", "0.3.3"],
      "getquick/beta": ["1.2.0"],
      "getquick/gamma-theme": [{ version: "0.1.0", require: { php: ">=8.4.1" } }],
    },
  };
}

// A fetch serving `world`: GitHub tags/releases/composer.json and the
// registry's Composer v2 metadata (minified, as Satis serves it).
function worldFetch(world) {
  return recordingFetch((request) => {
    const url = new URL(request.url);
    if (url.origin === "https://api.github.com") {
      const [, , owner, repo, kind] = url.pathname.split("/");
      const repository = world.github[`${owner}/${repo}`];
      if (!repository) return json({ message: "Not Found" }, 404);
      if (typeof repository.respond === "function") return repository.respond(kind, url);
      if (kind === "tags") {
        return json(
          page(url, repository.tags ?? []).map((name) => ({
            name,
            commit: { sha: sha(`${repo}@${name}`) },
          })),
        );
      }
      if (kind === "releases") {
        return json(
          page(url, repository.releases ?? []).map((release) => ({
            tag_name: release.tag,
            draft: release.draft ?? false,
            prerelease: release.prerelease ?? false,
            assets: (release.assets ?? []).map((name) => ({ name, digest: `sha256:${sha(name)}` })),
          })),
        );
      }
      if (kind === "contents") {
        return json({
          encoding: "base64",
          content: Buffer.from(JSON.stringify({ name: repository.name })).toString("base64"),
        });
      }
    }
    if (url.origin === REGISTRY) {
      const name = url.pathname.replace(/^\/p2\//u, "").replace(/\.json$/u, "");
      if (typeof world.registryRespond === "function") return world.registryRespond(name);
      const versions = world.registry[name];
      if (!versions) return json({ status: "not found" }, 404);
      const repo = name.split("/")[1];
      const entries = versions.map((entry) => {
        const { version, ...rest } = typeof entry === "string" ? { version: entry } : entry;
        const tag = /^\d/u.test(version) ? `v${version}` : version;
        return {
          name,
          version,
          dist: {
            type: "zip",
            reference: rest.reference ?? sha(`${repo}@${tag}`),
            shasum: sha(`zip:${name}@${version}`),
          },
          ...rest,
        };
      });
      return json({ minified: "composer/2.0", packages: { [name]: minify(entries) } });
    }
    throw new Error(`Unexpected request: ${request.url}`);
  });
}

function page(url, items) {
  const number = Number(url.searchParams.get("page") ?? 1);
  const size = Number(url.searchParams.get("per_page") ?? 100);
  return items.slice((number - 1) * size, number * size);
}

function minify(entries) {
  let previous = {};
  return entries.map((entry) => {
    const minified = {};
    for (const [key, value] of Object.entries(entry)) {
      if (JSON.stringify(previous[key]) !== JSON.stringify(value)) minified[key] = value;
    }
    for (const key of Object.keys(previous)) if (!(key in entry)) minified[key] = "__unset";
    previous = entry;
    return minified;
  });
}

function sha(text) {
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0").repeat(5);
}

// A temporary gq-site checkout: package.json, blueprint/packages.json and the
// CMS composer.json template.
async function checkout({ catalogue = CATALOGUE, composerText = COMPOSER_TEXT } = {}) {
  const root = await temporaryDirectory();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  execFileSync("git", ["init", "--quiet", root], { env });
  const files = {
    "package.json": JSON.stringify({ name: "@getquick/site" }),
    "blueprint/packages.json": JSON.stringify(catalogue, null, 2),
    "blueprint/templates/apps/cms/composer.json": composerText,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const composerPath = join(root, "blueprint/templates/apps/cms/composer.json");
  return {
    root,
    composer: () => readFile(composerPath, "utf8"),
    run: (argv, { world = defaultWorld(), env = ENV, fetch = worldFetch(world) } = {}) =>
      runGq(argv, { cwd: root, env, fetch }).then((result) => ({ ...result, fetch })),
  };
}

async function checkJson(site, options) {
  const result = await site.run(["packages", "check", "--json"], options);
  return { ...result, report: JSON.parse(result.stdout) };
}

function row(report, name) {
  return report.packages.find((entry) => entry.name === name);
}

test("versions order semantically, prereleases before their release", () => {
  const sorted = [
    "0.10.0",
    "0.9.0",
    "0.2.0",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
  ]
    .map(parseVersion)
    .sort(compareVersions)
    .map((version) => version.text);
  assert.deepEqual(sorted, [
    "0.2.0",
    "0.9.0",
    "0.10.0",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ]);
  assert.equal(parseVersion("dev-main"), null);
  assert.equal(parseVersion("plugin-v0.1.4"), null);
  assert.equal(parseVersion("v0.1.4").text, "0.1.4");
  assert.equal(parseCaret("^0.3.1").ceiling.text, "0.4.0");
  assert.equal(parseCaret("^1.2").ceiling.text, "2.0.0");
  assert.equal(parseCaret("7.1.2"), null);
});

test("gq packages check reports constraint, upstream, registry and target, sorted semantically", async () => {
  const site = await checkout();
  const world = defaultWorld();
  world.github["Quick-Release/alpha"].tags = ["v0.3.10", "v0.3.9", "v0.3.2", "plugin-v0.3.11"];
  world.registry["getquick/alpha"] = ["0.3.10", "0.3.9", "0.3.2"];
  const { code, report, stderr } = await checkJson(site, { world });

  assert.equal(code, 0, stderr);
  const alpha = row(report, "getquick/alpha");
  assert.equal(alpha.current, "^0.3.1");
  assert.equal(alpha.upstream.latest.version, "0.3.10");
  assert.equal(alpha.upstream.latest.tag, "v0.3.10");
  assert.equal(alpha.upstream.latest.commit, sha("alpha@v0.3.10"));
  assert.deepEqual(alpha.upstream.ignored, ["plugin-v0.3.11"]);
  assert.equal(alpha.registry.latest.version, "0.3.10");
  assert.equal(alpha.registry.latest.reference, sha("alpha@v0.3.10"));
  assert.equal(alpha.registry.latest.shasum, sha("zip:getquick/alpha@0.3.10"));
  assert.equal(alpha.action, "upgrade");
  assert.equal(alpha.proposed, "^0.3.10");
  assert.equal(row(report, "getquick/beta").action, "none");
  assert.equal(await site.composer(), COMPOSER_TEXT, "check never writes");
});

test("drafts, prereleases and dev versions are never proposed", async () => {
  const site = await checkout();
  const world = defaultWorld();
  world.github["Quick-Release/alpha"].tags = ["v0.3.1", "v0.3.4-rc.1"];
  world.registry["getquick/alpha"] = ["0.3.1", "0.3.4-RC1", "dev-main"];
  world.github["Quick-Release/gamma-theme"].releases = [
    { tag: "v0.3.0", draft: true, assets: ["gamma-theme-0.3.0.zip"] },
    { tag: "v0.2.0", prerelease: true, assets: ["gamma-theme-0.2.0.zip"] },
    { tag: "v0.1.1", assets: ["something-else.zip"] },
    { tag: "v0.1.0", assets: ["gamma-theme-0.1.0.zip"] },
  ];
  const { report } = await checkJson(site, { world });

  const alpha = row(report, "getquick/alpha");
  assert.equal(alpha.upstream.latest.version, "0.3.1");
  assert.deepEqual(alpha.upstream.prereleases, ["0.3.4-rc.1"]);
  assert.deepEqual(alpha.registry.prereleases, ["0.3.4-RC1"]);
  assert.deepEqual(alpha.registry.ignored, ["dev-main"]);
  assert.equal(alpha.action, "none");
  const gamma = row(report, "getquick/gamma-theme");
  assert.equal(gamma.upstream.latest.version, "0.1.0");
  assert.equal(gamma.upstream.latest.asset, "gamma-theme-0.1.0.zip");
  assert.equal(gamma.upstream.latest.digest, `sha256:${sha("gamma-theme-0.1.0.zip")}`);
  assert.deepEqual(gamma.upstream.ignored, ["v0.1.1", "v0.2.0", "v0.3.0"]);
});

test("an upstream release the registry doesn't serve yet is flagged and not proposed", async () => {
  const site = await checkout();
  const world = defaultWorld();
  world.registry["getquick/alpha"] = ["0.3.1", "0.3.2"];
  const { report } = await checkJson(site, { world });

  const alpha = row(report, "getquick/alpha");
  assert.equal(alpha.upstream.latest.version, "0.3.3");
  assert.equal(alpha.registry.latest.version, "0.3.2");
  assert.equal(alpha.proposed, "^0.3.2");
  const lag = alpha.notes.find((note) => note.code === "registry-lag");
  assert.match(lag.message, /0\.3\.3/u);
});

test("without COMPOSER_AUTH the registry isn't requested and nothing falls back to GitHub", async () => {
  const site = await checkout();
  const { code, report, fetch } = await checkJson(site, { env: { GITHUB_TOKEN } });

  assert.equal(code, 1);
  const alpha = row(report, "getquick/alpha");
  assert.equal(alpha.registry.status, "error");
  assert.equal(alpha.registry.error.code, "missing-credentials");
  assert.equal(alpha.target, null);
  assert.equal(alpha.action, "blocked");
  assert.ok(fetch.requests.every((request) => !request.url.startsWith(REGISTRY)));
  assert.ok(fetch.requests.every((request) => !/zipball|archive/u.test(request.url)));
});

test("credentials go only into request headers, never into output", async () => {
  const site = await checkout();
  const world = defaultWorld();
  world.registryRespond = () => json({ message: "Unauthorized" }, 401);
  for (const argv of [
    ["packages", "check"],
    ["packages", "check", "--json"],
    ["packages", "propose", "--latest", "--json"],
  ]) {
    const result = await site.run(argv, { world });
    const output = result.stdout + result.stderr;
    for (const secret of [
      LOGIN.password,
      GITHUB_TOKEN,
      Buffer.from(`${LOGIN.username}:${LOGIN.password}`).toString("base64"),
    ]) {
      assert.ok(!output.includes(secret), `${argv.join(" ")} printed a credential`);
    }
    const registryRequest = result.fetch.requests.find((request) =>
      request.url.startsWith(REGISTRY),
    );
    assert.match(registryRequest.headers.Authorization, /^Basic /u);
  }
  const { report } = await checkJson(site, { world });
  assert.equal(row(report, "getquick/alpha").registry.error.code, "permission-denied");
});

test("failures are classified: no token, permission, malformed, unavailable", async () => {
  const site = await checkout();
  const world = defaultWorld();
  world.github["Quick-Release/beta"].respond = () => new Response("not json", { status: 200 });
  world.github["Quick-Release/gamma-theme"].respond = () => json({ message: "Forbidden" }, 403);
  world.registryRespond = (name) =>
    name === "getquick/alpha"
      ? new Response("<html>", { status: 200 })
      : name === "getquick/beta"
        ? json({ packages: {} })
        : new Response("", { status: 502 });
  const { code, report } = await checkJson(site, { world });

  assert.equal(code, 1);
  assert.equal(row(report, "getquick/alpha").registry.error.code, "malformed");
  assert.equal(row(report, "getquick/beta").registry.error.code, "malformed");
  assert.equal(row(report, "getquick/beta").upstream.error.code, "malformed");
  assert.equal(row(report, "getquick/gamma-theme").upstream.error.code, "permission-denied");
  assert.equal(row(report, "getquick/gamma-theme").registry.error.code, "unavailable");

  const anonymous = await checkJson(site, { env: { COMPOSER_AUTH } });
  const hidden = { ...defaultWorld(), github: {} };
  const unseen = await checkJson(site, { env: { COMPOSER_AUTH }, world: hidden });
  assert.equal(anonymous.code, 0);
  assert.equal(row(unseen.report, "getquick/alpha").upstream.error.code, "missing-credentials");

  const timeout = await checkJson(site, {
    fetch: recordingFetch(() => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }),
  });
  assert.equal(row(timeout.report, "getquick/alpha").upstream.error.code, "unavailable");
  assert.match(row(timeout.report, "getquick/alpha").upstream.error.message, /timed out/u);
});

test("a renamed package needs a migration and is never proposed", async () => {
  const site = await checkout();
  const world = defaultWorld();
  world.github["Quick-Release/alpha"].name = "getquick/alpha-next";
  const { report } = await checkJson(site, { world });
  const alpha = row(report, "getquick/alpha");
  assert.equal(alpha.action, "blocked");
  assert.equal(alpha.proposed, null);
  assert.match(
    alpha.blockers.find((blocker) => blocker.code === "identity").message,
    /alpha-next/u,
  );

  // A former name back in require is uncatalogued, so the catalogue refuses it.
  const formerName = await checkout({
    composerText: COMPOSER_TEXT.replace(
      '"getquick/beta": "^1.2.0",',
      '"getquick/beta": "^1.2.0",\n    "getquick/old-alpha": "^0.2.0",',
    ),
  });
  const result = await formerName.run(["packages", "check"]);
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /getquick\/old-alpha is required from a catalogued registry but isn't catalogued/u,
  );
});

test("a version outside the caret range is a breaking upgrade, pending review", async () => {
  const site = await checkout();
  const world = defaultWorld();
  world.github["Quick-Release/alpha"].tags = ["v0.4.0", "v0.3.3"];
  world.registry["getquick/alpha"] = ["0.3.1", "0.3.3", "0.4.0"];
  world.github["Quick-Release/beta"].tags = ["v2.0.0", "v1.2.0"];
  world.registry["getquick/beta"] = ["1.2.0", "2.0.0"];
  const result = await site.run(["packages", "propose", "--latest", "--json"], { world });
  const proposal = JSON.parse(result.stdout);

  assert.deepEqual(proposal.changes, [{ name: "getquick/alpha", from: "^0.3.1", to: "^0.3.3" }]);
  const beta = proposal.blocked.find((entry) => entry.name === "getquick/beta");
  assert.equal(beta.action, "blocked");
  assert.match(beta.blockers[0].message, /2\.0\.0 is outside \^1\.2\.0/u);
  const alpha = proposal.blocked.find((entry) => entry.name === "getquick/alpha");
  assert.equal(alpha.blockers[0].code, "breaking");
  assert.equal(proposal.written, false);
});

test("holds, PHP floors and registry/upstream reference mismatches block a target", async () => {
  const held = structuredClone(CATALOGUE);
  held.packages[0].holds = [{ from: "0.3.3", reason: "0.3.3 drops the legacy settings page." }];
  const site = await checkout({ catalogue: held });
  const world = defaultWorld();
  world.registry["getquick/beta"] = ["1.2.0", { version: "1.3.0", require: { php: ">=8.5" } }];
  world.github["Quick-Release/beta"].tags = ["v1.3.0", "v1.2.0"];
  const { report } = await checkJson(site, { world });

  const alpha = row(report, "getquick/alpha");
  assert.equal(alpha.proposed, "^0.3.2");
  assert.equal(alpha.blockers[0].code, "hold");
  const beta = row(report, "getquick/beta");
  assert.equal(beta.action, "blocked");
  assert.equal(beta.blockers[0].code, "php");
  const gamma = row(report, "getquick/gamma-theme");
  assert.deepEqual(gamma.blockers.map((blocker) => blocker.code).sort(), [
    "migration-required",
    "not-required",
    "php",
  ]);
  assert.equal(gamma.proposed, null);

  const mismatch = defaultWorld();
  mismatch.registry["getquick/alpha"] = [
    "0.3.1",
    "0.3.2",
    { version: "0.3.3", reference: "f".repeat(40) },
  ];
  const moved = await checkJson(site, { world: mismatch });
  assert.ok(
    row(moved.report, "getquick/alpha").blockers.some(
      (blocker) => blocker.code === "reference-mismatch",
    ),
  );
  assert.equal(row(moved.report, "getquick/alpha").action, "blocked");
});

test("gq packages propose is read-only unless --write", async () => {
  const site = await checkout();
  const result = await site.run(["packages", "propose", "--latest"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Proposed \(not applied; --write applies them\)/u);
  assert.match(result.stdout, /getquick\/alpha {2}\^0\.3\.1 → \^0\.3\.3/u);
  assert.match(result.stdout, /getquick\/gamma-theme {2}migration-required/u);
  assert.match(result.stdout, /Applying a proposal doesn't approve it/u);
  assert.equal(await site.composer(), COMPOSER_TEXT);
  assert.ok(result.fetch.requests.every((request) => (request.method ?? "GET") === "GET"));
});

test("--write changes only the proposed require values, and again changes nothing", async () => {
  const site = await checkout();
  const first = await site.run(["packages", "propose", "--latest", "--write"]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /^Wrote: blueprint\/templates\/apps\/cms\/composer\.json/mu);
  const written = await site.composer();
  assert.equal(
    written,
    COMPOSER_TEXT.replace('"getquick/alpha":   "^0.3.1"', '"getquick/alpha":   "^0.3.3"'),
  );
  assert.match(
    written,
    /"require-dev": \{ "getquick\/alpha": "\^0\.3\.1" \}/u,
    "require-dev is untouched",
  );

  const second = await site.run(["packages", "propose", "--latest", "--write"]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /^No safe upgrades to propose/mu);
  assert.equal(await site.composer(), written);
});

test("--write refuses outside a gq-site checkout, and propose states its strategy", async () => {
  const elsewhere = await temporaryDirectory();
  const refused = await runGq(["packages", "propose", "--latest", "--write"], { cwd: elsewhere });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /only runs in a gq-site checkout/u);
  assert.equal(refused.fetch.requests.length, 0);
  const site = await checkout();
  const result = await site.run(["packages", "propose"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /gq packages propose --latest/u);
});

test("the shipped catalogue agrees with the blueprint's composer.json and holds no constraints", () => {
  assert.deepEqual(catalogueProblems(ownCatalogue, ownComposer), []);
  assert.ok(!JSON.stringify(ownCatalogue).includes('"^'), "constraints live only in composer.json");
  const gqTheme = ownCatalogue.packages.find((pkg) => pkg.name === "getquick/gq-theme");
  assert.equal(gqTheme.requirement, "none");
  assert.equal(gqTheme.policy, "manual");
  assert.ok(!Object.hasOwn(ownComposer.require, "getquick/gq-theme"));
  assert.ok(Object.hasOwn(ownComposer.require, "getquick/getquick-theme"));
});
