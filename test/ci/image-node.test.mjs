// The Node the Sites' Cloudflare CI image runs (blueprint/templates/infra/ci/
// Dockerfile), read from the template: it must be the Node every Site pins
// locally (.nvmrc, .mise.toml), so a check that passes locally passes in CI,
// and new enough for every package template's engines and the Frontend
// frameworks' own. The base image's bundled Node (22.22.3) passed local
// checks and failed Astro 7.4.2+'s (>=22.23.4) in CI. The image itself is
// built and run by scripts/smoke/ci-node.sh; nothing here reaches the network.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TEMPLATES = fileURLToPath(new URL("../../blueprint/templates/", import.meta.url));
const read = (path) => readFile(join(TEMPLATES, path), "utf8");

const DOCKERFILE = await read("infra/ci/Dockerfile");

// engines.node of each Frontend framework a skeleton depends on, at the newest
// release its range allows, as npm served it on 2026-11-12. Astro raised its
// floor within 7.x (7.4.0 >=22.22.0, 7.4.2 >=22.23.4), which a caret range
// takes without a pin changing; record a new floor when one is published.
const FRAMEWORK_ENGINES = {
  astro: ">=22.23.4",
  "@tanstack/react-start": ">=22.12.0",
  "vite-plus": "^20.19.0 || ^22.18.0 || >=24.11.0",
};

const FRONTENDS = [
  "apps/frontend/package.json",
  "tanstack/apps/frontend/package.json",
  "commerce/apps/frontend/package.json",
];

function parse(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  assert.ok(match, `${version} isn't an x.y.z version`);
  return match.slice(1).map(Number);
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Whether `version` satisfies an npm engines range made of `>=x.y.z` and
// `^x.y.z` comparators joined by `||`, the forms these packages use.
function satisfies(version, range) {
  const parsed = parse(version);
  return range.split("||").some((alternative) => {
    const comparator = alternative.trim();
    if (comparator.startsWith(">=")) return compare(parsed, parse(comparator.slice(2))) >= 0;
    if (comparator.startsWith("^")) {
      const floor = parse(comparator.slice(1));
      return parsed[0] === floor[0] && compare(parsed, floor) >= 0;
    }
    throw new Error(`The test can't read the engines range ${range}.`);
  });
}

function imageNode() {
  const version = /^ARG NODE_VERSION=(\S+)$/mu.exec(DOCKERFILE)?.[1];
  assert.ok(version, "infra/ci/Dockerfile declares no NODE_VERSION");
  return version;
}

async function packageTemplates(dir = TEMPLATES) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await packageTemplates(path)));
    else if (entry.name === "package.json" || entry.name === "package.keys.json") {
      found.push(relative(TEMPLATES, path));
    }
  }
  return found.sort();
}

test("the CI image runs the Node every Site pins locally", async () => {
  const node = imageNode();
  assert.equal(node, (await read("nvmrc")).trim(), "the CI image's Node isn't .nvmrc's");
  assert.equal(
    /^node = "(.+)"$/mu.exec(await read("mise.toml"))?.[1],
    node,
    "the CI image's Node isn't .mise.toml's",
  );
});

test("the CI image installs its Node, verified, before any step uses npm", () => {
  parse(imageNode());
  const sha = /^ARG NODE_SHA256=([0-9a-f]{64})$/mu.exec(DOCKERFILE)?.[1];
  assert.ok(sha, "infra/ci/Dockerfile pins no NODE_SHA256");
  const install = DOCKERFILE.indexOf(
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz",
  );
  assert.notEqual(install, -1, "infra/ci/Dockerfile doesn't download the official Node build");
  assert.match(DOCKERFILE, /echo "\$\{NODE_SHA256\} {2}\/tmp\/node\.tar\.gz" \| sha256sum -c -/u);
  // Into /usr/local, over the base image's node, npm and npx: one node on PATH.
  assert.match(DOCKERFILE, /tar -xzf \/tmp\/node\.tar\.gz -C \/usr\/local --strip-components=1/u);
  assert.ok(
    install < DOCKERFILE.indexOf("RUN npm install -g {{packageManager}}"),
    "pnpm is installed with the base image's Node",
  );
});

test("the CI image's Node satisfies every package template's engines", async () => {
  const node = imageNode();
  const templates = await packageTemplates();
  for (const frontend of FRONTENDS) assert.ok(templates.includes(frontend), frontend);
  for (const path of templates) {
    const range = JSON.parse(await read(path)).engines?.node;
    if (range === undefined || range.includes("{{")) continue;
    assert.ok(satisfies(node, range), `${path} needs Node ${range}; the CI image runs ${node}`);
  }
});

test("the CI image's Node satisfies each Frontend skeleton's framework engines", async () => {
  const node = imageNode();
  for (const path of FRONTENDS) {
    const { dependencies = {}, devDependencies = {} } = JSON.parse(await read(path));
    const frameworks = Object.keys(FRAMEWORK_ENGINES).filter(
      (name) => name in dependencies || name in devDependencies,
    );
    assert.ok(frameworks.length > 0, `${path} depends on no framework this test knows`);
    for (const name of frameworks) {
      assert.ok(
        satisfies(node, FRAMEWORK_ENGINES[name]),
        `${path}'s ${name} needs Node ${FRAMEWORK_ENGINES[name]}; the CI image runs ${node}`,
      );
    }
  }
});

test("the engines reader accepts and refuses what npm does", () => {
  assert.equal(satisfies("22.22.3", FRAMEWORK_ENGINES.astro), false);
  assert.equal(satisfies("22.23.4", FRAMEWORK_ENGINES.astro), true);
  assert.equal(satisfies("24.21.0", FRAMEWORK_ENGINES.astro), true);
  assert.equal(satisfies("22.17.0", FRAMEWORK_ENGINES["vite-plus"]), false);
  assert.equal(satisfies("24.10.0", FRAMEWORK_ENGINES["vite-plus"]), false);
  assert.equal(satisfies("24.11.0", FRAMEWORK_ENGINES["vite-plus"]), true);
});
