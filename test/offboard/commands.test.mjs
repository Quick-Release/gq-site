// `gq offboard` (cut a Site's public access) and `gq offboard --restore` at
// the run() seam, against one in-memory account (test/support/offboarding.mjs):
// the plan and its dry run, cutting in order, idempotency, restoring, and the
// gq.ops.json record. The guards the record turns on are in guards.test.mjs.
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  ARTIFACTS_ONLY,
  artifactsOnlyState,
  changes,
  CROWDED_CRONTABS,
  CROWDED_HOOKS,
  CROWDED_TOKENS,
  ENV,
  fakeAccount,
  offboardingSite,
  OPS,
  publicationBinding,
  RETRY_CRONTAB,
  STAGING,
} from "../support/offboarding.mjs";
import { recordingExec, recordingFetch } from "../support/fixture-site.mjs";

async function readOps(fixture) {
  return JSON.parse(await readFile(fixture.path("gq.ops.json"), "utf8"));
}

test("offboard --dry-run plans every cut in order and changes nothing", async () => {
  const fixture = await offboardingSite();
  const { fetch, exec, state } = fakeAccount();

  const result = await fixture.run(["offboard", "--dry-run"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  const plan = result.stdout.split("\n").filter((line) => /^ {2}[-✓!] /u.test(line));
  assert.deepEqual(plan, [
    "  - Record: write offboarded to gq.ops.json first, so gq refuses to expose the Site from then on (commit it)",
    "  - Backup: back up fixture_db to r2://fixture-releases/db/ before anything is cut",
    "  - CI: deactivate the GitHub push webhook 99 on Example/fixture",
    "  - CI: switch the CI Worker fixture-ci's workers.dev off",
    "  - CMS: delete the retry crontab (fixture: wp gq-events retry-due)",
    '  - CMS: suspend the Ploi site fixture-cms.example.test (reason "offboarded"); its files, .env and database stay',
    "  ! CMS: Ploi's API can't disable the site's deploy webhook; the suspension is what stops it",
    "  ! CMS: the DNS record for fixture-cms.example.test was added by hand; remove it by hand if it should go",
    "  - Frontend: detach fixture-fe.example.test from the Worker fixture-fe",
    "  - Frontend: switch the Worker fixture-fe's workers.dev and preview URLs off (the Worker and its D1 store stay)",
    "  - Media: disable https://fixture-media.example.test on the bucket fixture-media (the bucket and its objects stay)",
    "  - Tokens: disable GETQUICK FIXTURE Staging Alchemy",
    "  - Tokens: disable GETQUICK FIXTURE Releases R2",
    "  - Tokens: disable GETQUICK FIXTURE Media R2",
    "  - Tokens: disable GETQUICK FIXTURE CI Deploy",
  ]);
  assert.match(result.stdout, /Dry run: nothing changed\./u);
  assert.deepEqual(state.log, []);
  // The only change a dry run makes is its own temporary token, deleted after.
  assert.deepEqual(changes(fetch), [
    "POST /client/v4/accounts/account-1/tokens",
    "DELETE /client/v4/accounts/account-1/tokens/temp-1",
  ]);
  assert.equal((await readOps(fixture)).offboarded, undefined);
  assert.deepEqual(await readOps(fixture), OPS);
});

test("offboard --yes cuts in order, tokens last, and records offboarded", async () => {
  const fixture = await offboardingSite();
  const { fetch, exec, state } = fakeAccount();

  const result = await fixture.run(["offboard", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(state.log, [
    "database backed up",
    "github hook 99 inactive",
    'workers.dev fixture-ci {"enabled":false,"previews_enabled":false}',
    "crontab 7 deleted",
    "ploi site suspended (offboarded)",
    "worker domain wd-1 detached",
    'workers.dev fixture-fe {"enabled":false,"previews_enabled":false}',
    "media domain fixture-media.example.test disabled",
    "token t-alchemy disabled",
    "token t-releases disabled",
    "token t-media disabled",
    "token t-deploy disabled",
  ]);
  // The final backup ran on the server as the site's user, into the backups bucket.
  assert.equal(state.scripts[0].user, "fixture");
  assert.match(state.scripts[0].content, /fixture-releases\/db\/fixture_db\//u);

  const { offboarded, ...rest } = await readOps(fixture);
  assert.deepEqual(rest, OPS, "nothing else in gq.ops.json changes");
  assert.equal(offboarded.phase, "cut");
  assert.ok(Math.abs(Date.parse(offboarded.at) - Date.now()) < 60_000, offboarded.at);
  // What the cut changed, which is all --restore brings back.
  assert.deepEqual(offboarded.cut, {
    backup: true,
    crontab: RETRY_CRONTAB,
    suspended: true,
    workerDomains: [
      { hostname: "fixture-fe.example.test", service: "fixture-fe", zoneId: "zone-1" },
    ],
    workersDev: {
      "fixture-fe": { enabled: false, previewsEnabled: true },
      "fixture-ci": { enabled: true, previewsEnabled: false },
    },
    mediaDomain: "fixture-media.example.test",
    webhook: 99,
    tokens: ["t-alchemy", "t-releases", "t-media", "t-deploy"],
  });
  assert.match(result.stdout, /Offboarded fixture\. Commit gq\.ops\.json/u);
});

test("offboard silences CI right after the backup, so no push mid-cut can deploy the Frontend again", async () => {
  const fixture = await offboardingSite();
  const account = fakeAccount();
  const { state } = account;
  let atDetach;
  const fetch = recordingFetch((request) => {
    if (request.method === "DELETE" && request.url.endsWith("/workers/domains/wd-1")) {
      atDetach = {
        hook: state.hooks.find(({ id }) => id === 99).active,
        ciWorkersDev: state.subdomains["fixture-ci"].enabled,
        backedUp: state.log.includes("database backed up"),
      };
    }
    return account.fetch(request.url, request);
  });

  const result = await fixture.run(["offboard", "--yes"], { env: ENV, fetch, exec: account.exec });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(atDetach, { hook: false, ciWorkersDev: false, backedUp: true });
  assert.deepEqual(state.log.slice(0, 3), [
    "database backed up",
    "github hook 99 inactive",
    'workers.dev fixture-ci {"enabled":false,"previews_enabled":false}',
  ]);
});

test("offboard leaves what isn't the Site's alone: other Workers, hooks, crontabs and tokens", async () => {
  const fixture = await offboardingSite();
  const { fetch, exec, state } = fakeAccount();

  const result = await fixture.run(["offboard", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    state.workerDomains.map(({ id }) => id),
    ["wd-other"],
  );
  assert.equal(state.hooks.find(({ id }) => id === 100).active, true);
  assert.deepEqual(
    state.crontabs.map(({ id }) => id),
    [8],
  );
  const statuses = Object.fromEntries(state.tokens.map(({ id, status }) => [id, status]));
  assert.equal(statuses.manager, "active", "the manager token is never disabled");
  assert.equal(statuses.other, "active", "another project's token is untouched");
  assert.ok(
    state.tokens.every(({ id }) => !id.startsWith("temp-")),
    "the temporary token is deleted",
  );
});

test("offboard leaves a CI Worker or media bucket that isn't the project's own for the operator", async () => {
  // One CI Worker and one media bucket serving several clients.
  const ops = {
    ...OPS,
    ci: { worker: "team-ci", backupBucket: "fixture-ci-backups" },
    media: { bucket: "team-media", domain: "team-media.example.test" },
  };
  const fixture = await offboardingSite({ ops });
  const exposed = fakeAccount().state;
  const { fetch, exec, state } = fakeAccount({
    subdomains: { ...exposed.subdomains, "team-ci": { enabled: true, previews_enabled: true } },
    bucketDomains: { "team-media": [{ domain: "team-media.example.test", enabled: true }] },
  });

  const result = await fixture.run(["offboard", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  const plan = result.stdout.split("\n").filter((line) => /^ {2}[-✓!] /u.test(line));
  for (const expected of [
    "  ! CI: the CI Worker team-ci isn't fixture's own (gq names it fixture-ci): its workers.dev stays on; switch it off by hand if only fixture uses it",
    "  ! Media: the bucket team-media isn't fixture's own (gq names it fixture-media): https://team-media.example.test stays enabled; disable it by hand if only fixture uses it",
  ]) {
    assert.ok(plan.includes(expected), `${expected}\n${plan.join("\n")}`);
  }
  assert.deepEqual(state.subdomains["team-ci"], { enabled: true, previews_enabled: true });
  assert.equal(state.bucketDomains["team-media"][0].enabled, true);
  const { cut } = (await readOps(fixture)).offboarded;
  assert.equal(cut.workersDev["team-ci"], undefined);
  assert.equal(cut.mediaDomain, undefined);
});

test("offboard again changes nothing once everything is cut", async () => {
  const fixture = await offboardingSite();
  const account = fakeAccount();
  const first = await fixture.run(["offboard", "--yes"], { env: ENV, ...account });
  assert.equal(first.code, 0, first.stderr);
  const recorded = await readOps(fixture);
  account.state.log.length = 0;
  account.fetch.requests.length = 0;

  const again = await fixture.run(["offboard", "--yes"], { env: ENV, ...account });

  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(account.state.log, []);
  assert.doesNotMatch(again.stdout, /^ {2}- /mu);
  assert.match(again.stdout, /Nothing left to cut: fixture is offboarded\./u);
  assert.deepEqual(await readOps(fixture), recorded, "the record keeps its date");
});

test("offboard after a failed run cuts only what is still exposed, without a new backup", async () => {
  const fixture = await offboardingSite();
  const { fetch, exec, state } = fakeAccount({
    site: {
      id: 34,
      domain: "fixture-cms.example.test",
      status: "suspended",
      system_user: "fixture",
    },
    crontabs: [],
  });

  const result = await fixture.run(["offboard", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /✓ Backup: the CMS is suspended, so the backup taken before is the final one/u,
  );
  assert.match(result.stdout, /✓ CMS: the Ploi site fixture-cms\.example\.test is suspended/u);
  assert.deepEqual(state.scripts, [], "no backup of a suspended CMS");
  assert.equal(state.log[0], "github hook 99 inactive");
  assert.equal(state.log.at(-1), "token t-deploy disabled");
  assert.equal((await readOps(fixture)).offboarded.phase, "cut");
});

test("offboard without a terminal or --yes shows the plan and changes nothing", async () => {
  const fixture = await offboardingSite();
  const { fetch, exec, state } = fakeAccount();

  const result = await fixture.run(["offboard"], { env: ENV, fetch, exec });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /- CMS: suspend the Ploi site/u);
  assert.match(result.stderr, /Not a TTY: re-run with --yes to apply, or --dry-run to inspect\./u);
  assert.deepEqual(state.log, []);
  assert.ok(
    state.tokens.every(({ id }) => !id.startsWith("temp-")),
    "the temporary token is deleted",
  );
});

test("offboard and --restore refuse when ploi.siteId is another site than domains.admin", async () => {
  const fixture = await offboardingSite();
  const { fetch, exec, state } = fakeAccount({
    site: { id: 34, domain: "other-cms.example.test", status: "active", system_user: "other" },
  });

  for (const argv of [
    ["offboard", "--yes"],
    ["offboard", "--restore", "--yes"],
  ]) {
    const result = await fixture.run(argv, { env: ENV, fetch, exec });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /The Ploi site 34 \(gq\.ops\.json ploi\.siteId\) is other-cms\.example\.test, not fixture-cms\.example\.test \(domains\.admin\): stopping before anything changes\./u,
    );
  }
  assert.deepEqual(state.log, []);
  assert.equal(state.site.status, "active");
  assert.equal((await readOps(fixture)).offboarded, undefined);
});

test("offboard refuses when the Ploi site runs as another system user than ploi.systemUser", async () => {
  const fixture = await offboardingSite();
  const { fetch, exec, state } = fakeAccount({
    site: { id: 34, domain: "fixture-cms.example.test", status: "active", system_user: "other" },
  });

  const result = await fixture.run(["offboard", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /The Ploi site 34 \(gq\.ops\.json ploi\.siteId\) runs as other, not fixture \(ploi\.systemUser\): stopping before anything changes\./u,
  );
  assert.deepEqual(state.log, []);
  assert.equal((await readOps(fixture)).offboarded, undefined);
});

test("offboard refuses when the site's .env names another database than ploi.database", async () => {
  const fixture = await offboardingSite();
  for (const [siteEnv, found] of [
    ["WP_ENV=production\nDB_NAME=other_db\n", "DB_NAME other_db"],
    ["WP_ENV=production\n", "no DB_NAME"],
  ]) {
    const { fetch, exec, state } = fakeAccount({ siteEnv });

    for (const argv of [
      ["offboard", "--dry-run"],
      ["offboard", "--yes"],
    ]) {
      const result = await fixture.run(argv, { env: ENV, fetch, exec });

      assert.equal(result.code, 1);
      assert.match(
        result.stderr,
        new RegExp(
          `The Ploi site fixture-cms\\.example\\.test's \\.env has ${found}, not fixture_db \\(gq\\.ops\\.json ploi\\.database\\): stopping before anything changes\\.`,
          "u",
        ),
      );
    }
    assert.deepEqual(state.log, []);
    assert.equal((await readOps(fixture)).offboarded, undefined);
  }
});

test("offboard disables, and --restore re-enables, every project token however many pages list them", async () => {
  const fixture = await offboardingSite();
  const exposed = fakeAccount().state;
  const account = fakeAccount({
    tokens: [exposed.tokens[0], ...structuredClone(CROWDED_TOKENS), ...exposed.tokens.slice(1)],
  });
  const own = () =>
    account.state.tokens
      .filter(({ name }) => name.startsWith("GETQUICK FIXTURE "))
      .map(({ status }) => status);

  const cut = await fixture.run(["offboard", "--yes"], { env: ENV, ...account });
  assert.equal(cut.code, 0, cut.stderr);
  assert.deepEqual(own(), ["disabled", "disabled", "disabled", "disabled"]);
  assert.ok(
    account.state.tokens
      .filter(({ id }) => id.startsWith("client-"))
      .every(({ status }) => status === "active"),
    "other clients' tokens are untouched",
  );

  const restore = await fixture.run(["offboard", "--restore", "--yes"], { env: ENV, ...account });
  assert.equal(restore.code, 0, restore.stderr);
  assert.deepEqual(own(), ["active", "active", "active", "active"]);
});

test("offboard reads every page of a listing that comes without page totals", async () => {
  const fixture = await offboardingSite();
  const exposed = fakeAccount().state;
  const account = fakeAccount({
    tokens: [exposed.tokens[0], ...structuredClone(CROWDED_TOKENS), ...exposed.tokens.slice(1)],
    bareListings: true,
  });

  const cut = await fixture.run(["offboard", "--yes"], { env: ENV, ...account });

  assert.equal(cut.code, 0, cut.stderr);
  assert.deepEqual(
    account.state.tokens
      .filter(({ name }) => name.startsWith("GETQUICK FIXTURE "))
      .map(({ status }) => status),
    ["disabled", "disabled", "disabled", "disabled"],
  );
});

test("offboard finds the CI webhook and the retry crontab however many pages list them", async () => {
  const fixture = await offboardingSite();
  const exposed = fakeAccount().state;
  const { fetch, exec, state } = fakeAccount({
    hooks: [...structuredClone(CROWDED_HOOKS), ...exposed.hooks],
    crontabs: [...structuredClone(CROWDED_CRONTABS), ...exposed.crontabs],
  });

  const result = await fixture.run(["offboard", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(state.log.includes("crontab 7 deleted"), state.log.join("\n"));
  assert.ok(state.log.includes("github hook 99 inactive"), state.log.join("\n"));
});

// --- gq offboard --restore ---------------------------------------------------

test("offboard --restore brings back everything the cut took, in reverse, and removes the record", async () => {
  const fixture = await offboardingSite();
  const account = fakeAccount();
  assert.equal((await fixture.run(["offboard", "--yes"], { env: ENV, ...account })).code, 0);
  account.state.log.length = 0;
  account.fetch.requests.length = 0;

  const result = await fixture.run(["offboard", "--restore", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(account.state.log, [
    "token t-alchemy active",
    "token t-releases active",
    "token t-media active",
    "token t-deploy active",
    "media domain fixture-media.example.test enabled",
    "worker domain fixture-fe.example.test attached to fixture-fe",
    'workers.dev fixture-fe {"enabled":false,"previews_enabled":true}',
    "ploi site resumed",
    `crontab added: ${RETRY_CRONTAB.command}`,
    'workers.dev fixture-ci {"enabled":true,"previews_enabled":false}',
    "github hook 99 active",
  ]);
  const attached = account.state.workerDomains.find(({ service }) => service === "fixture-fe");
  assert.deepEqual(
    { ...attached, id: undefined },
    {
      id: undefined,
      hostname: "fixture-fe.example.test",
      service: "fixture-fe",
      zone_id: "zone-1",
      environment: "production",
    },
  );
  assert.deepEqual(account.state.crontabs.at(-1), { id: 70, ...RETRY_CRONTAB });
  // Tokens are re-enabled, never created again (planToken would "create" a
  // disabled one): the only token created is the run's temporary one.
  assert.deepEqual(
    changes(account.fetch).filter(
      (change) => change.startsWith("POST") && change.endsWith("/tokens"),
    ),
    ["POST /client/v4/accounts/account-1/tokens"],
  );
  assert.deepEqual(await readOps(fixture), OPS);
  assert.match(result.stdout, /Restored fixture\./u);
});

// A Site cut with `state` (overrides of exposedState()), then restored.
async function cutAndRestore(state) {
  const fixture = await offboardingSite();
  const account = fakeAccount(state);
  const cut = await fixture.run(["offboard", "--yes"], { env: ENV, ...account });
  assert.equal(cut.code, 0, cut.stderr);
  account.state.log.length = 0;
  const restore = await fixture.run(["offboard", "--restore", "--yes"], { env: ENV, ...account });
  assert.equal(restore.code, 0, restore.stderr);
  return { fixture, account, restore };
}

test("offboard --restore re-enables only the tokens the cut disabled", async () => {
  const exposed = fakeAccount().state;
  const rotated = {
    ...exposed.tokens[1],
    id: "t-rotated",
    name: "GETQUICK FIXTURE Old R2",
    status: "disabled",
  };
  const { account, restore } = await cutAndRestore({ tokens: [...exposed.tokens, rotated] });

  assert.equal(account.state.tokens.find(({ id }) => id === "t-rotated").status, "disabled");
  assert.match(
    restore.stdout,
    /! Tokens: GETQUICK FIXTURE Old R2 stays disabled: gq offboard didn't disable it/u,
  );
  assert.ok(account.state.log.includes("token t-alchemy active"));
});

test("offboard --restore re-attaches every custom domain the cut detached", async () => {
  const exposed = fakeAccount().state;
  const www = {
    id: "wd-www",
    hostname: "www.fixture-fe.example.test",
    service: "fixture-fe",
    zone_id: "zone-1",
    environment: "production",
  };
  const { account } = await cutAndRestore({ workerDomains: [...exposed.workerDomains, www] });

  assert.deepEqual(
    account.state.workerDomains
      .filter(({ service }) => service === "fixture-fe")
      .map(({ hostname }) => hostname)
      .sort(),
    ["fixture-fe.example.test", "www.fixture-fe.example.test"],
  );
});

test("offboard --restore puts the CI Worker's workers.dev and preview URLs back as they were", async () => {
  const exposed = fakeAccount().state;
  const { account } = await cutAndRestore({
    subdomains: { ...exposed.subdomains, "fixture-ci": { enabled: true, previews_enabled: true } },
  });

  assert.ok(
    account.state.log.includes('workers.dev fixture-ci {"enabled":true,"previews_enabled":true}'),
    account.state.log.join("\n"),
  );
  assert.deepEqual(account.state.subdomains["fixture-ci"], {
    enabled: true,
    previews_enabled: true,
  });
});

test("offboard --restore adds no retry crontab the Site didn't have", async () => {
  const { account, restore } = await cutAndRestore({
    crontabs: [{ id: 8, user: "fixture", frequency: "0 3 * * *", command: "other job" }],
  });

  assert.doesNotMatch(restore.stdout, /retry crontab/u);
  assert.deepEqual(
    account.state.crontabs.map(({ id }) => id),
    [8],
  );
});

test("offboard cuts the Frontend's other stages too, and --restore brings them back", async () => {
  const exposed = fakeAccount().state;
  const fixture = await offboardingSite();
  const account = fakeAccount({
    workers: [...exposed.workers, "fixture-fe-staging", "fixture-fe-shop-fe", "other-fe-staging"],
    subdomains: {
      ...exposed.subdomains,
      "fixture-fe-staging": { enabled: true, previews_enabled: true },
      "fixture-fe-shop-fe": { enabled: true, previews_enabled: true },
      "other-fe-staging": { enabled: true, previews_enabled: true },
    },
    d1: [...exposed.d1, { uuid: "d1-staging", name: "fixture-fe-publications-staging" }],
    bindings: { "fixture-fe-staging": publicationBinding("d1-staging") },
  });

  const cut = await fixture.run(["offboard", "--yes"], { env: ENV, ...account });

  assert.equal(cut.code, 0, cut.stderr);
  assert.match(
    cut.stdout,
    /- Frontend: switch the Worker fixture-fe-staging's workers\.dev and preview URLs off/u,
  );
  assert.match(
    cut.stdout,
    /! Frontend: the Worker fixture-fe-shop-fe is named like one of fixture's Frontend stages, but no PUBLICATION_DB binding to fixture-fe-publications-<stage> ties it to fixture; check it by hand/u,
  );
  assert.deepEqual(account.state.subdomains["fixture-fe-staging"], {
    enabled: false,
    previews_enabled: false,
  });
  for (const untouched of ["fixture-fe-shop-fe", "other-fe-staging"]) {
    assert.deepEqual(account.state.subdomains[untouched], {
      enabled: true,
      previews_enabled: true,
    });
  }

  const restore = await fixture.run(["offboard", "--restore", "--yes"], { env: ENV, ...account });
  assert.equal(restore.code, 0, restore.stderr);
  assert.deepEqual(account.state.subdomains["fixture-fe-staging"], {
    enabled: true,
    previews_enabled: true,
  });
});

test("offboard leaves a Worker named like a stage alone unless its publication store ties it to the project", async () => {
  const exposed = fakeAccount().state;
  const fixture = await offboardingSite();
  const open = { enabled: true, previews_enabled: true };
  const account = fakeAccount({
    // Project fixture-fe's production Worker, a hand-deployed Worker, and a
    // stage bound to another project's store.
    workers: [...exposed.workers, "fixture-fe-fe", "fixture-fe-redirects", "fixture-fe-preview"],
    subdomains: {
      ...exposed.subdomains,
      "fixture-fe-fe": { ...open },
      "fixture-fe-redirects": { ...open },
      "fixture-fe-preview": { ...open },
    },
    workerDomains: [
      ...exposed.workerDomains,
      {
        id: "wd-sibling",
        hostname: "fixture-fe.example.org",
        service: "fixture-fe-fe",
        zone_id: "zone-2",
        environment: "production",
      },
    ],
    d1: [
      ...exposed.d1,
      { uuid: "d1-sibling", name: "fixture-fe-fe-publications" },
      { uuid: "d1-preview", name: "fixture-fe-publications-preview" },
    ],
    bindings: {
      "fixture-fe-fe": publicationBinding("d1-sibling"),
      "fixture-fe-preview": publicationBinding("d1-sibling"),
    },
  });

  const cut = await fixture.run(["offboard", "--yes"], { env: ENV, ...account });

  assert.equal(cut.code, 0, cut.stderr);
  for (const worker of ["fixture-fe-fe", "fixture-fe-redirects", "fixture-fe-preview"]) {
    assert.match(
      cut.stdout,
      new RegExp(
        `! Frontend: the Worker ${worker} is named like one of fixture's Frontend stages, but no PUBLICATION_DB binding to fixture-fe-publications-<stage> ties it to fixture; check it by hand`,
        "u",
      ),
    );
    assert.deepEqual(account.state.subdomains[worker], open, worker);
  }
  assert.ok(account.state.workerDomains.some(({ id }) => id === "wd-sibling"));
  assert.ok(!account.state.log.some((entry) => entry.includes("fixture-fe-")), account.state.log);
});

test("offboard --restore on a live Site has nothing to do", async () => {
  const fixture = await offboardingSite();
  const { fetch, exec, state } = fakeAccount();

  const result = await fixture.run(["offboard", "--restore", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(state.log, []);
  assert.match(result.stdout, /Nothing to restore: fixture is not offboarded\./u);
});

test("offboard --restore --dry-run plans the restore and changes nothing", async () => {
  const fixture = await offboardingSite();
  const account = fakeAccount();
  assert.equal((await fixture.run(["offboard", "--yes"], { env: ENV, ...account })).code, 0);
  const recorded = await readOps(fixture);
  account.state.log.length = 0;

  const result = await fixture.run(["offboard", "--restore", "--dry-run"], {
    env: ENV,
    ...account,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^ {2}\+ Tokens: re-enable GETQUICK FIXTURE Staging Alchemy$/mu);
  assert.match(
    result.stdout,
    /^ {2}\+ Frontend: attach fixture-fe\.example\.test to the Worker fixture-fe$/mu,
  );
  assert.match(result.stdout, /^ {2}\+ CMS: resume the Ploi site fixture-cms\.example\.test$/mu);
  assert.match(
    result.stdout,
    /^ {2}\+ Record: remove offboarded from gq\.ops\.json \(commit it\)$/mu,
  );
  assert.deepEqual(account.state.log, []);
  assert.deepEqual(await readOps(fixture), recorded);
});

test("offboard --restore refuses once the Site is archived", async () => {
  const fixture = await offboardingSite({
    ops: { ...OPS, offboarded: { at: "2026-10-01T09:00:00.000Z", phase: "archived" } },
  });
  const { fetch, exec } = fakeAccount();

  const result = await fixture.run(["offboard", "--restore", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /fixture was archived .*nothing to restore/u);
  assert.deepEqual(fetch.requests, []);
});

// --- credentials and failures ------------------------------------------------

test("a cut that fails leaves the tokens active and the guards on, so a rerun can finish", async () => {
  const fixture = await offboardingSite();
  const account = fakeAccount();
  const failing = recordingFetch((request) => {
    if (
      request.method === "POST" &&
      request.url.endsWith("/workers/scripts/fixture-ci/subdomain")
    ) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: "boom" }] }), {
        status: 500,
      });
    }
    return account.fetch(request.url, request);
  });

  const result = await fixture.run(["offboard", "--yes"], {
    env: ENV,
    fetch: failing,
    exec: account.exec,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /workers\/scripts\/fixture-ci\/subdomain failed: boom/u);
  assert.ok(
    account.state.tokens
      .filter(({ name }) => name.startsWith("GETQUICK FIXTURE "))
      .every(({ status }) => status === "active"),
    "no token is disabled before everything else is cut",
  );
  // The record went first: half cut, the Site already refuses to be exposed.
  assert.equal((await readOps(fixture)).offboarded.phase, "cut");
  const release = await fixture.run(["ploi", "release"], { env: ENV, ...account });
  assert.equal(release.code, 1);
  assert.match(release.stderr, /fixture is offboarded .*gq ploi release would expose it again/u);
  assert.ok(
    account.state.tokens.every(({ id }) => !id.startsWith("temp-")),
    "the temporary token is deleted",
  );

  const rerun = await fixture.run(["offboard", "--yes"], { env: ENV, ...account });
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.equal((await readOps(fixture)).offboarded.phase, "cut");
});

test("a change the cut failed to make isn't recorded, so --restore never undoes it", async () => {
  const fixture = await offboardingSite();
  const account = fakeAccount();
  const failing = recordingFetch((request) => {
    if (request.method === "PUT" && request.url.endsWith("/tokens/t-releases")) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: "boom" }] }), {
        status: 500,
      });
    }
    return account.fetch(request.url, request);
  });
  const cut = await fixture.run(["offboard", "--yes"], {
    env: ENV,
    fetch: failing,
    exec: account.exec,
  });
  assert.equal(cut.code, 1);
  assert.deepEqual((await readOps(fixture)).offboarded.cut.tokens, ["t-alchemy"]);

  // The token leaked meanwhile: someone disables it on purpose.
  account.state.tokens.find(({ id }) => id === "t-releases").status = "disabled";
  const restore = await fixture.run(["offboard", "--restore", "--yes"], { env: ENV, ...account });

  assert.equal(restore.code, 0, restore.stderr);
  assert.equal(account.state.tokens.find(({ id }) => id === "t-releases").status, "disabled");
  assert.equal(account.state.tokens.find(({ id }) => id === "t-alchemy").status, "active");
  assert.match(
    restore.stdout,
    /! Tokens: GETQUICK FIXTURE Releases R2 stays disabled: gq offboard didn't disable it/u,
  );
});

test("offboard reads Ploi's token and the R2 key from Sigillo staging and prints no secret", async () => {
  const fixture = await offboardingSite();
  const { fetch, exec } = fakeAccount();

  const result = await fixture.run(["offboard", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  const reads = exec.calls
    .filter(({ args }) => args[0] === "secrets")
    .map(({ args }) => args.slice(0, 3).join(" "));
  assert.deepEqual([...new Set(reads)].sort(), [
    "secrets get PLOI_API_TOKEN",
    "secrets get R2_ACCESS_KEY_ID",
    "secrets get R2_SECRET_ACCESS_KEY",
  ]);
  const ploi = fetch.requests.filter(({ url }) => url.startsWith("https://ploi.io/"));
  assert.ok(ploi.every(({ headers }) => headers.Authorization === "Bearer ploi-secret"));
  for (const secret of ["manager-secret", "ploi-secret", "r2-secret", "temp-value-1"]) {
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret), secret);
  }
});

test("offboard refuses until the managed deploy files are current, before any provider call", async () => {
  const fixture = await offboardingSite();
  // A deploy script from before the offboarding guards, and a missing one.
  await writeFile(fixture.path("infra/scripts/deploy-frontend.mjs"), "// deploys, unguarded\n");
  await rm(fixture.path("scripts/ci-release.mjs"));
  const { fetch, exec, state } = fakeAccount();

  const result = await fixture.run(["offboard", "--dry-run"], { env: ENV, fetch, exec });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /The managed deploy files aren't current: infra\/scripts\/deploy-frontend\.mjs \(edited since gq last wrote it\), scripts\/ci-release\.mjs \(missing\)\. A deploy from them could expose fixture again: run gq sync first \(gq sync --check shows what it changes\), then gq offboard\./u,
  );
  assert.deepEqual(fetch.requests, []);
  assert.deepEqual(exec.calls, []);
  assert.deepEqual(state.log, []);
});

test("offboard tells a Sigillo secret that is missing from one it couldn't read", async () => {
  const fixture = await offboardingSite();
  const { PLOI_API_TOKEN, ...rest } = STAGING;
  void PLOI_API_TOKEN;
  const missing = fakeAccount({ staging: rest });
  const withoutToken = await fixture.run(["offboard", "--dry-run"], { env: ENV, ...missing });
  assert.equal(withoutToken.code, 1);
  assert.match(withoutToken.stderr, /PLOI_API_TOKEN is missing in Sigillo stage\./u);

  const account = fakeAccount();
  const exec = recordingExec(({ command, args, input }) =>
    args.slice(0, 3).join(" ") === "secrets get PLOI_API_TOKEN"
      ? { code: 1, stderr: "error: 401 Unauthorized" }
      : account.exec(command, args, { input }),
  );
  const unreadable = await fixture.run(["offboard", "--dry-run"], {
    env: ENV,
    fetch: account.fetch,
    exec,
  });
  assert.equal(unreadable.code, 1);
  assert.match(
    unreadable.stderr,
    /Reading PLOI_API_TOKEN from Sigillo stage failed: sigillo secrets failed: error: 401 Unauthorized/u,
  );
  assert.doesNotMatch(unreadable.stderr, /is missing/u);
});

test("offboard needs the token-manager token and names the gq.ops.json keys it lacks", async () => {
  const fixture = await offboardingSite();
  const withoutManager = await fixture.run(["offboard", "--dry-run"], { env: {} });
  assert.equal(withoutManager.code, 1);
  assert.match(withoutManager.stderr, /CLOUDFLARE_TOKEN_MANAGER_API_TOKEN is missing/u);

  const { media, ...ops } = OPS;
  void media;
  const partial = await offboardingSite({ ops });
  const result = await partial.run(["offboard", "--dry-run"], { env: ENV });
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /gq\.ops\.json media\.bucket, media\.domain are required to offboard\./u,
  );

  // An Artifacts-only Site needs its Artifacts repository instead.
  const { artifacts, ...withoutArtifacts } = ARTIFACTS_ONLY;
  void artifacts;
  const artifactsOnly = await offboardingSite({ ops: withoutArtifacts });
  const unnamed = await artifactsOnly.run(["offboard", "--restore", "--dry-run"], { env: ENV });
  assert.equal(unnamed.code, 1);
  assert.match(
    unnamed.stderr,
    /gq\.ops\.json artifacts\.namespace, artifacts\.repo are required to offboard\./u,
  );
});

// An Artifacts-only Site (no github.repository, ADR 0012): pushes to its
// Artifacts repository start CI, with no GitHub webhook to deactivate.
async function artifactsOnlySite() {
  const fixture = await offboardingSite({ ops: ARTIFACTS_ONLY });
  const account = fakeAccount(artifactsOnlyState());
  return { fixture, account };
}

test("an Artifacts-only Site's cut takes every push credential away right after the backup, instead of a webhook", async () => {
  const { fixture, account } = await artifactsOnlySite();

  const dryRun = await fixture.run(["offboard", "--dry-run"], { env: ENV, ...account });

  assert.equal(dryRun.code, 0, dryRun.stderr);
  const plan = dryRun.stdout.split("\n").filter((line) => /^ {2}[-✓!] /u.test(line));
  assert.deepEqual(plan.slice(1, 5), [
    "  - Backup: back up fixture_db to r2://fixture-releases/db/ before anything is cut",
    "  - CI: disable GETQUICK FIXTURE Artifacts, so no git token for the Artifacts repository fixture/fixture can be minted (fixture is Artifacts-only: a push there starts CI)",
    "  - CI: revoke every active git token for the Artifacts repository fixture/fixture (1 now)",
    "  - CI: switch the CI Worker fixture-ci's workers.dev off",
  ]);
  assert.deepEqual(
    plan.filter((line) => line.includes("Tokens:")),
    [
      "  - Tokens: disable GETQUICK FIXTURE Staging Alchemy",
      "  - Tokens: disable GETQUICK FIXTURE Releases R2",
      "  - Tokens: disable GETQUICK FIXTURE Media R2",
      "  - Tokens: disable GETQUICK FIXTURE CI Deploy",
    ],
  );
  assert.doesNotMatch(dryRun.stdout, /GitHub/u);

  const result = await fixture.run(["offboard", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(account.state.log, [
    "database backed up",
    "token t-artifacts disabled",
    "artifacts token git-1 revoked",
    'workers.dev fixture-ci {"enabled":false,"previews_enabled":false}',
    "crontab 7 deleted",
    "ploi site suspended (offboarded)",
    "worker domain wd-1 detached",
    'workers.dev fixture-fe {"enabled":false,"previews_enabled":false}',
    "media domain fixture-media.example.test disabled",
    "token t-alchemy disabled",
    "token t-releases disabled",
    "token t-media disabled",
    "token t-deploy disabled",
  ]);
  // Another repository's git tokens stay.
  assert.equal(account.state.artifactsTokens.find(({ id }) => id === "git-other").state, "active");
  assert.ok(
    account.exec.calls.every(({ command }) => command !== "gh"),
    "an Artifacts-only Site's cut never calls GitHub",
  );
  const { offboarded, ...rest } = await readOps(fixture);
  assert.deepEqual(rest, ARTIFACTS_ONLY);
  assert.equal(offboarded.cut.webhook, undefined);
  assert.deepEqual(offboarded.cut.tokens, [
    "t-artifacts",
    "t-alchemy",
    "t-releases",
    "t-media",
    "t-deploy",
  ]);

  account.state.log.length = 0;
  const again = await fixture.run(["offboard", "--dry-run"], { env: ENV, ...account });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /✓ CI: GETQUICK FIXTURE Artifacts is disabled/u);
  assert.match(
    again.stdout,
    /✓ CI: no active git token for the Artifacts repository fixture\/fixture/u,
  );
  assert.doesNotMatch(again.stdout, /^ {2}- /mu);
});

test("an Artifacts-only Site's cut revokes git tokens minted before its Artifacts token was disabled", async () => {
  const { fixture, account } = await artifactsOnlySite();
  account.state.tokens.find(({ id }) => id === "t-artifacts").status = "disabled";
  account.state.artifactsTokens.push({
    id: "git-3",
    repo: "fixture",
    scope: "read",
    state: "active",
  });

  const result = await fixture.run(["offboard", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /✓ CI: GETQUICK FIXTURE Artifacts is disabled/u);
  assert.match(
    result.stdout,
    /- CI: revoke every active git token for the Artifacts repository fixture\/fixture \(2 now\)/u,
  );
  assert.deepEqual(account.state.log.slice(0, 3), [
    "database backed up",
    "artifacts token git-1 revoked",
    "artifacts token git-3 revoked",
  ]);
  // The cut didn't disable it, so --restore won't enable it.
  assert.ok(!(await readOps(fixture)).offboarded.cut.tokens.includes("t-artifacts"));
});

test("an Artifacts-only Site's --restore re-enables its Artifacts token with the others, and calls no GitHub", async () => {
  const { fixture, account } = await artifactsOnlySite();
  assert.equal((await fixture.run(["offboard", "--yes"], { env: ENV, ...account })).code, 0);
  account.state.log.length = 0;
  account.exec.calls.length = 0;

  const result = await fixture.run(["offboard", "--restore", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(account.state.log, [
    "token t-alchemy active",
    "token t-releases active",
    "token t-media active",
    "token t-deploy active",
    "token t-artifacts active",
    "media domain fixture-media.example.test enabled",
    "worker domain fixture-fe.example.test attached to fixture-fe",
    'workers.dev fixture-fe {"enabled":false,"previews_enabled":true}',
    "ploi site resumed",
    `crontab added: ${RETRY_CRONTAB.command}`,
    'workers.dev fixture-ci {"enabled":true,"previews_enabled":false}',
  ]);
  assert.ok(account.exec.calls.every(({ command }) => command !== "gh"));
  assert.deepEqual(await readOps(fixture), ARTIFACTS_ONLY);
});

test("an Artifacts-only Site's cut also revokes a git token minted after its plan was read", async () => {
  const { fixture, account } = await artifactsOnlySite();
  const fetch = recordingFetch((request) => {
    // Minted with the Artifacts token just before the cut disables it.
    if (request.method === "PUT" && request.url.endsWith("/tokens/t-artifacts")) {
      account.state.artifactsTokens.push({
        id: "git-late",
        repo: "fixture",
        scope: "write",
        state: "active",
      });
    }
    return account.fetch(request.url, request);
  });

  const result = await fixture.run(["offboard", "--yes"], { env: ENV, fetch, exec: account.exec });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(account.state.log.slice(1, 4), [
    "token t-artifacts disabled",
    "artifacts token git-1 revoked",
    "artifacts token git-late revoked",
  ]);
});

test("an Artifacts-only Site whose Artifacts repository is gone has nothing to revoke", async () => {
  const { fixture, account } = await artifactsOnlySite();
  account.state.artifacts = account.state.artifacts.filter(({ name }) => name !== "fixture");

  const result = await fixture.run(["offboard", "--dry-run"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /✓ CI: the Artifacts repository fixture\/fixture is gone, so nothing can be pushed to it/u,
  );
});
