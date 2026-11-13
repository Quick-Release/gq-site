import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  checkPlan,
  compareWorkerSettings,
  droppedSecrets,
  guardedFrontendDeploy,
  parseDeployArguments,
  stateStoreVersion,
  storeProtocolOf,
} from "../../src/frontend/deploy-guards.mjs";

const fixture = (name) =>
  readFile(new URL(`../fixtures/alchemy-plan/${name}`, import.meta.url), "utf8");
const ACCOUNT = "0123456789abcdef0123456789abcdef";

test("the wrapper's flags are taken out; the rest goes to Alchemy", () => {
  const parsed = parseDeployArguments([
    "--dry-run",
    "--drop-secret",
    "OLD_TOKEN",
    "--drop-secret=OTHER",
    "--upgrade-state-store",
    "--detailed",
  ]);
  assert.deepEqual(parsed.alchemyArgs, ["--dry-run", "--detailed"]);
  assert.deepEqual([...parsed.dropSecrets], ["OLD_TOKEN", "OTHER"]);
  assert.equal(parsed.upgradeStateStore, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.detailed, true);
  assert.throws(() => parseDeployArguments(["--drop-secret"]), /needs the secret's name/u);
  assert.throws(() => parseDeployArguments(["--drop-secret", "--yes"]), /needs the secret's name/u);
  // --yes would let Alchemy upgrade the store, a plan included: only the
  // wrapper passes it.
  for (const yes of ["--yes", "-y", "--yes=true"]) {
    assert.throws(() => parseDeployArguments(["--dry-run", yes]), /--upgrade-state-store/u);
  }
});

test("a bound secret whose variable is unset is dropped unless --drop-secret names it", () => {
  const bound = ["CONSENT_READ_TOKEN", "FRONTEND_REFRESH_TOKEN", "PUBLICATION_EVENT_SECRET"];
  const env = { CONSENT_READ_TOKEN: "x".repeat(32), FRONTEND_REFRESH_TOKEN: "  " };
  assert.deepEqual(droppedSecrets({ bound, env }), [
    "FRONTEND_REFRESH_TOKEN",
    "PUBLICATION_EVENT_SECRET",
  ]);
  assert.deepEqual(droppedSecrets({ bound, env, allowed: new Set(["PUBLICATION_EVENT_SECRET"]) }), [
    "FRONTEND_REFRESH_TOKEN",
  ]);
});

test("the store protocol follows the installed @alchemy.run/cloudflare", () => {
  assert.equal(storeProtocolOf("2.0.0-beta.84"), 7);
  assert.equal(storeProtocolOf("2.0.0-beta.85"), 8);
  assert.equal(storeProtocolOf("2.0.0-beta.86"), 8);
  assert.throws(() => storeProtocolOf("2.0.0"), /protocol/u);
});

test("the plan check refuses replacements, deletions, unbinds and removed env entries", async () => {
  const plan = checkPlan(await fixture("blocking.beta86.txt"));
  assert.equal(plan.blocking, true);
  assert.equal(plan.detailed, true);
  assert.match(plan.summary, /1 to replace, 1 to delete/u);
  assert.deepEqual(plan.replaced, ["DemoPublications"]);
  assert.deepEqual(plan.deleted, ["DemoOld"]);
  assert.deepEqual(plan.unbound, ["DemoFrontend/CONSENT_DB"]);
  // A changed value (PUBLIC_WORDPRESS_GRAPHQL_URL) is not a removal.
  assert.deepEqual(plan.removedEnv, [
    "DemoFrontend.env.CONSENT_READ_TOKEN",
    "DemoFrontend.env.OLD_PLAIN",
  ]);
  assert.deepEqual(plan.compatibility, [
    { resource: "DemoFrontend", removed: [], added: ["new_module_registry"] },
  ]);
});

test("a plan of updates and no-ops passes the check", async () => {
  const plan = checkPlan(await fixture("clean.beta86.txt"));
  assert.equal(plan.blocking, false);
  assert.equal(plan.summary, "Plan: 2 to update, 1 binding changes");
  assert.deepEqual(plan.removedEnv, []);
  assert.deepEqual(plan.compatibility, []);
  assert.deepEqual(
    plan.resources.map(({ fqn, action }) => `${fqn} ${action}`),
    [
      "ExampleConsent noop",
      "ExampleConsentPurge update",
      "ExampleFrontend update",
      "ExamplePublications noop",
    ],
  );
});

test("an orphaned resource blocks too", () => {
  const plan = checkPlan("Plan: 1 to orphaned\n[ExamplePublications] orphaned\n");
  assert.deepEqual(plan.orphaned, ["ExamplePublications"]);
  assert.equal(plan.blocking, true);
});

test("before and after a deploy: removed bindings and flag changes", () => {
  const before = {
    bindings: [{ name: "CONSENT_DB" }, { name: "CONSENT_READ_TOKEN" }],
    compatibilityDate: "2026-08-31",
    compatibilityFlags: [],
  };
  const after = {
    bindings: [{ name: "CONSENT_DB" }, { name: "ASSETS" }],
    compatibilityDate: "2026-08-31",
    compatibilityFlags: ["new_module_registry"],
  };
  assert.deepEqual(compareWorkerSettings(before, after), {
    removedBindings: ["CONSENT_READ_TOKEN"],
    addedBindings: ["ASSETS"],
    flagsRemoved: [],
    flagsAdded: ["new_module_registry"],
    dateBefore: "2026-08-31",
    dateAfter: "2026-08-31",
  });
});

// A fake Cloudflare API: the state store's Worker and the Frontend's.
function cloudflare({ store = [], worker, afterDeploy }) {
  const calls = [];
  let deployed = false;
  const fetch = async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.authorization, "Bearer token");
    const settings = url.endsWith("/alchemy-state-store/settings")
      ? store && { bindings: store }
      : deployed && afterDeploy
        ? afterDeploy
        : worker;
    if (!settings) return new Response(JSON.stringify({ success: false }), { status: 404 });
    return new Response(JSON.stringify({ success: true, result: settings }));
  };
  return { fetch, calls, markDeployed: () => (deployed = true) };
}

const V8 = [{ name: "ALCHEMY_STATE_STORE_VERSION", type: "plain_text", text: "8" }];
const WORKER = {
  bindings: [
    { name: "CONSENT_DB", type: "d1" },
    { name: "CONSENT_READ_TOKEN", type: "secret_text" },
  ],
  compatibility_date: "2026-08-31",
  compatibility_flags: ["new_module_registry"],
};

async function deploy({ argv, env = {}, api, output = "", status = 0 }) {
  const messages = { log: [], error: [] };
  const runs = [];
  const code = await guardedFrontendDeploy({
    argv,
    env: { CLOUDFLARE_API_TOKEN: "token", ...env },
    accountId: ACCOUNT,
    scriptName: "example-fe",
    cloudflareVersion: "2.0.0-beta.86",
    fetch: api.fetch,
    log: (line) => messages.log.push(line),
    error: (line) => messages.error.push(line),
    runAlchemy: async (args) => {
      runs.push(args);
      api.markDeployed();
      return { status, output };
    },
  });
  return { code, runs, ...messages };
}

test("the store version is read from its Worker's version binding", async () => {
  assert.equal(
    await stateStoreVersion({ accountId: ACCOUNT, token: "token", ...cloudflare({ store: V8 }) }),
    8,
  );
  assert.equal(
    await stateStoreVersion({ accountId: ACCOUNT, token: "token", ...cloudflare({}) }),
    7,
  );
  assert.equal(
    await stateStoreVersion({ accountId: ACCOUNT, token: "token", ...cloudflare({ store: null }) }),
    undefined,
  );
});

test("a v7 store is never upgraded without --upgrade-state-store, a plan included", async () => {
  for (const argv of [["--dry-run", "--detailed"], []]) {
    const result = await deploy({
      argv,
      env: { CONSENT_READ_TOKEN: "x" },
      api: cloudflare({ worker: WORKER }),
    });
    assert.equal(result.code, 1);
    assert.deepEqual(result.runs, []);
    assert.match(result.error.join("\n"), /runs v7.*can't be undone.*--upgrade-state-store/su);
  }
  const upgrade = await deploy({
    argv: ["--dry-run", "--detailed", "--upgrade-state-store"],
    env: { CONSENT_READ_TOKEN: "x" },
    api: cloudflare({ worker: WORKER }),
    output: await fixture("clean.beta86.txt"),
  });
  assert.equal(upgrade.code, 0, upgrade.error.join("\n"));
  // The upgrade needs --yes; the flag itself never reaches Alchemy.
  assert.deepEqual(upgrade.runs[0], [
    "deploy",
    "--stage",
    "prod",
    "--config",
    "frontend.run.ts",
    "--yes",
    "--no-input",
    "--dry-run",
    "--detailed",
  ]);
});

test("a store newer than the installed Alchemy is refused", async () => {
  const result = await deploy({
    argv: [],
    api: cloudflare({
      store: [{ name: "ALCHEMY_STATE_STORE_VERSION", text: "9" }],
      worker: WORKER,
    }),
  });
  assert.equal(result.code, 1);
  assert.match(result.error[0], /runs v9, newer than the v8/u);
});

test("on a v8 store a plan runs without --yes and passes the plan check", async () => {
  const result = await deploy({
    argv: ["--dry-run", "--detailed"],
    env: { CONSENT_READ_TOKEN: "x" },
    api: cloudflare({ store: V8, worker: WORKER }),
    output: await fixture("clean.beta86.txt"),
  });
  assert.equal(result.code, 0, result.error.join("\n"));
  assert.deepEqual(result.runs[0], [
    "deploy",
    "--stage",
    "prod",
    "--config",
    "frontend.run.ts",
    "--no-input",
    "--dry-run",
    "--detailed",
  ]);
  assert.match(result.log.join("\n"), /flags \[new_module_registry\]; 1 secret\(s\) bound/u);
  assert.match(result.log.join("\n"), /✓ no replacement, deletion or removed binding/u);
});

test("a plan that replaces or unbinds fails, and reports the flag change", async () => {
  const result = await deploy({
    argv: ["--dry-run", "--detailed"],
    env: { CONSENT_READ_TOKEN: "x" },
    api: cloudflare({ store: V8, worker: WORKER }),
    output: await fixture("blocking.beta86.txt"),
  });
  assert.equal(result.code, 1);
  assert.match(result.error.join("\n"), /replaced: DemoPublications/u);
  assert.match(result.error.join("\n"), /unbound: DemoFrontend\/CONSENT_DB/u);
  assert.match(
    result.log.join("\n"),
    /compatibility flags of DemoFrontend: \+new_module_registry/u,
  );
});

test("a deploy that would unbind a secret is refused unless --drop-secret names it", async () => {
  const refused = await deploy({ argv: [], api: cloudflare({ store: V8, worker: WORKER }) });
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.runs, []);
  assert.match(refused.error[0], /CONSENT_READ_TOKEN bound.*--drop-secret CONSENT_READ_TOKEN/su);
  assert.doesNotMatch(refused.error[0], /token/u, "no value is printed");

  const allowed = await deploy({
    argv: ["--drop-secret", "CONSENT_READ_TOKEN"],
    api: cloudflare({
      store: V8,
      worker: WORKER,
      afterDeploy: { ...WORKER, bindings: [WORKER.bindings[0]] },
    }),
  });
  // Dropped on purpose, so the post-deploy comparison still names it.
  assert.equal(allowed.runs.length, 1);
  assert.match(allowed.error.join("\n"), /removed CONSENT_READ_TOKEN/u);
});

test("after a deploy, a removed binding fails and a flag change is reported", async () => {
  const result = await deploy({
    argv: [],
    env: { CONSENT_READ_TOKEN: "x" },
    api: cloudflare({
      store: V8,
      worker: { ...WORKER, compatibility_flags: [] },
      afterDeploy: { ...WORKER, bindings: [WORKER.bindings[1]] },
    }),
  });
  assert.equal(result.code, 1);
  assert.match(result.log.join("\n"), /compatibility flags changed: \+new_module_registry/u);
  assert.match(result.error.join("\n"), /removed CONSENT_DB from example-fe/u);
});

test("a first deploy (no Worker yet) runs, and an unchanged one passes", async () => {
  const first = await deploy({ argv: [], api: cloudflare({ store: V8, afterDeploy: WORKER }) });
  assert.equal(first.code, 0, first.error.join("\n"));
  assert.equal(first.runs.length, 1);
  const again = await deploy({
    argv: [],
    env: { CONSENT_READ_TOKEN: "x" },
    api: cloudflare({ store: V8, worker: WORKER }),
  });
  assert.equal(again.code, 0, again.error.join("\n"));
});

test("without CLOUDFLARE_API_TOKEN nothing runs", async () => {
  const messages = [];
  const code = await guardedFrontendDeploy({
    argv: [],
    env: {},
    accountId: ACCOUNT,
    scriptName: "example-fe",
    cloudflareVersion: "2.0.0-beta.86",
    error: (line) => messages.push(line),
    runAlchemy: () => assert.fail("Alchemy ran"),
  });
  assert.equal(code, 1);
  assert.match(messages[0], /CLOUDFLARE_API_TOKEN/u);
});

test("an Alchemy failure is passed through without a plan check", async () => {
  const result = await deploy({
    argv: ["--dry-run", "--detailed"],
    env: { CONSENT_READ_TOKEN: "x" },
    api: cloudflare({ store: V8, worker: WORKER }),
    status: 3,
  });
  assert.equal(result.code, 3);
});
