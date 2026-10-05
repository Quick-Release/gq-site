// `gq offboard --archive` (phase 2: archive a cut Site's content, then delete
// its infrastructure) at the run() seam, against one in-memory account
// (test/support/offboarding.mjs) that phase 1 has already cut: the plan and
// its dry run, the archive and its verification, the deletions in order, the
// shared zone, resuming after a failure, and the gq.ops.json record.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { fakeClock, recordingExec, recordingFetch } from "../support/fixture-site.mjs";
import { access } from "node:fs/promises";

import {
  answering,
  ARTIFACTS_ONLY,
  ARTIFACTS_REFS,
  artifactsOnlyState,
  bundleOf,
  changes,
  CROWDED_HOOKS,
  CROWDED_TOKENS,
  DUMP,
  ENV,
  fakeAccount,
  HEAD_COMMIT,
  offboardingSite,
  OPS,
  PUBLICATIONS_SQL,
  publicationBinding,
  readZip,
  sha256,
} from "../support/offboarding.mjs";

async function readOps(fixture) {
  return JSON.parse(await readFile(fixture.path("gq.ops.json"), "utf8"));
}

// gq.ops.json as `change(ops)` leaves it.
async function rewriteOps(fixture, change) {
  const ops = await readOps(fixture);
  change(ops);
  await writeFile(fixture.path("gq.ops.json"), `${JSON.stringify(ops, null, 2)}\n`);
}

const today = () => new Date().toISOString().slice(0, 10);

// A Site phase 1 has cut, and the account it was cut in: `ops` is its
// gq.ops.json, `state` what the account holds besides exposedState().
async function cutSite({ ops = OPS, state = {} } = {}) {
  const fixture = await offboardingSite({ ops });
  const account = fakeAccount(state);
  const cut = await fixture.run(["offboard", "--yes"], { env: ENV, ...account });
  assert.equal(cut.code, 0, cut.stderr);
  account.state.log.length = 0;
  account.fetch.requests.length = 0;
  account.exec.calls.length = 0;
  return { fixture, account };
}

const planLines = (stdout) => stdout.split("\n").filter((line) => /^ {2}[-✓!] /u.test(line));

test("offboard --archive refuses a Site whose access isn't cut", async () => {
  const fixture = await offboardingSite();
  const { fetch, exec, state } = fakeAccount();

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /fixture isn't offboarded: run gq offboard first \(pnpm offboard\), which cuts its access and records it\./u,
  );
  assert.deepEqual(fetch.requests, []);
  assert.deepEqual(state.log, []);
});

test("offboard --archive --dry-run plans the archive and every deletion, and changes nothing", async () => {
  const { fixture, account } = await cutSite();
  const before = await readOps(fixture);

  const result = await fixture.run(["offboard", "--archive", "--dry-run"], {
    env: ENV,
    ...account,
  });

  assert.equal(result.code, 0, result.stderr);
  const prefix = `r2://offboarded-clients/fixture/${today()}/`;
  assert.deepEqual(planLines(result.stdout), [
    "  - Archive: create the private bucket offboarded-clients (no custom domain)",
    `  - Archive: ${prefix}uploads.zip ← the 3 objects of fixture-media, keys kept`,
    `  - Archive: ${prefix}database.sql.gz ← a fresh dump of fixture_db`,
    `  - Archive: ${prefix}publications.sql ← the D1 store fixture-fe-publications`,
    `  - Archive: ${prefix}backups/ ← the 2 database backups in r2://fixture-releases/db/`,
    `  - Archive: ${prefix}gq.ops.json, and manifest.json (each file's size and sha256, and the source resources)`,
    "  - Verify: re-read every archived file against manifest.json, and count uploads.zip's entries against fixture-media; nothing is deleted unless all match, then gq.ops.json records the archive",
    "  - Ploi: delete the site fixture-cms.example.test (34) and forget ploi.siteId in gq.ops.json",
    "  - Ploi: delete the database fixture_db (56)",
    "  - Ploi: delete the system user fixture (78)",
    "  - Frontend: delete the Worker fixture-fe",
    "  - Frontend: delete the D1 store fixture-fe-publications (d1-fixture)",
    "  - CI: delete the Worker fixture-ci",
    "  - CI: delete the Workflow fixture-ci",
    "  - CI: delete the Workflow fixture-mirror",
    "  - CI: delete the container application fixture-ci-cisandbox (c-fixture)",
    "  - Media: remove the custom domain fixture-media.example.test from fixture-media",
    "  - R2: empty fixture-media (with a key scoped to it) and delete it",
    "  - R2: empty fixture-releases (with a key scoped to it) and delete it",
    "  - R2: empty fixture-ci-backups (with a key scoped to it) and delete it",
    "  - Artifacts: delete the repository fixture/fixture",
    "  ! Artifacts: the empty namespace fixture stays; delete it in the dashboard if it should go",
    "  - DNS: delete A fixture-cms.example.test → 203.0.113.10",
    "  - DNS: delete AAAA fixture-fe.example.test → 100::",
    "  - DNS: delete CNAME fixture-media.example.test → public.r2.dev",
    "  ✓ DNS: the zone example.test and every other record in it stay",
    "  - Tokens: delete GETQUICK FIXTURE Staging Alchemy",
    "  - Tokens: delete GETQUICK FIXTURE Releases R2",
    "  - Tokens: delete GETQUICK FIXTURE Media R2",
    "  - Tokens: delete GETQUICK FIXTURE CI Deploy",
    "  - GitHub: delete the push webhook 99 on Example/fixture",
    '  - Record: offboarded.phase becomes "archived" in gq.ops.json',
    "  - Git: commit gq.ops.json and push it to origin/main",
    "  - GitHub: archive the repository Example/fixture (it stays readable)",
    "  ! Sigillo: the project PROJECT123 is kept, with the Site's secrets",
  ]);
  assert.match(result.stdout, /Dry run: nothing changed\./u);
  assert.deepEqual(account.state.log, []);
  assert.deepEqual(await readOps(fixture), before);
  assert.ok(
    account.state.tokens.every(({ id }) => !id.startsWith("temp-")),
    "every temporary token is deleted",
  );
});

// The deletions, in gq-smoke-down's order, with the project's tokens last on
// Cloudflare and GitHub's webhook after them; then the record, pushed before
// the repository turns read-only.
const DELETIONS = [
  "ploi site deleted",
  "ploi database 56 deleted",
  "ploi system user 78 deleted",
  "worker fixture-fe deleted",
  "d1 d1-fixture deleted",
  "worker fixture-ci deleted",
  "workflow fixture-ci deleted",
  "workflow fixture-mirror deleted",
  "container application c-fixture deleted",
  "media domain fixture-media.example.test removed",
  "object fixture-media/2026/01/a.jpg deleted",
  "object fixture-media/2026/02/b c.png deleted",
  "object fixture-media/uploads/ünïcode.txt deleted",
  "bucket fixture-media deleted",
  "object fixture-releases/admin/release-1.tar.gz deleted",
  "object fixture-releases/db/fixture_db/2026-09-30T10-00-00Z.sql.gz deleted",
  // The final backup phase 1 took.
  /^object fixture-releases\/db\/fixture_db\/\d{4}-\d\d-\d\dT[\d-]+Z\.sql\.gz deleted$/u,
  "bucket fixture-releases deleted",
  "object fixture-ci-backups/snapshots/1.tar deleted",
  "bucket fixture-ci-backups deleted",
  "artifacts repo fixture/fixture deleted",
  "dns record r-cms deleted",
  "dns record r-fe deleted",
  "dns record r-media deleted",
  "token t-alchemy deleted",
  "token t-releases deleted",
  "token t-media deleted",
  "token t-deploy deleted",
  "github hook 99 deleted",
  "gq.ops.json committed",
  "gq.ops.json pushed to origin/main",
  "github repo archived",
];

// `expected` lists object deletions by key: a bucket's objects are deleted
// several at a time, so each run of them is compared sorted.
function assertLog(log, expected) {
  assert.equal(log.length, expected.length, log.join("\n"));
  const sorted = [];
  for (const entry of log) {
    const run = sorted.at(-1);
    if (entry.startsWith("object ") && Array.isArray(run)) run.push(entry);
    else sorted.push(entry.startsWith("object ") ? [entry] : entry);
  }
  const actual = sorted.flatMap((entry) => (Array.isArray(entry) ? entry.sort() : [entry]));
  expected.forEach((entry, index) =>
    entry instanceof RegExp
      ? assert.match(actual[index], entry)
      : assert.equal(actual[index], entry),
  );
}

test("offboard --archive --yes archives everything, verifies it, then deletes in order and records it", async () => {
  const { fixture, account } = await cutSite();
  const { state } = account;
  const media = structuredClone(state.buckets["fixture-media"]);
  const backups = Object.entries(state.buckets["fixture-releases"]).filter(([key]) =>
    key.startsWith("db/"),
  );
  const opsBefore = await readFile(fixture.path("gq.ops.json"));

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assertLog(state.log, ["bucket offboarded-clients created", "database backed up", ...DELETIONS]);

  // The archive: every file under <project>/<UTC date>/, as manifest.json lists it.
  const prefix = `fixture/${today()}/`;
  const archived = state.buckets["offboarded-clients"];
  assert.deepEqual(
    Object.keys(archived).sort(),
    [
      `${prefix}backups/fixture_db/2026-09-30T10-00-00Z.sql.gz`,
      `${prefix}backups/${backups[1][0].slice("db/".length)}`,
      `${prefix}database.sql.gz`,
      `${prefix}gq.ops.json`,
      `${prefix}manifest.json`,
      `${prefix}publications.sql`,
      `${prefix}uploads.zip`,
    ].sort(),
  );
  const zip = readZip(archived[`${prefix}uploads.zip`].body);
  assert.deepEqual(
    zip.map(({ name, body }) => [name, body.toString()]),
    Object.entries(media).map(([key, { body }]) => [key, Buffer.from(body).toString()]),
    "every media object, keys kept",
  );
  assert.equal(archived[`${prefix}database.sql.gz`].body.toString(), DUMP);
  assert.equal(archived[`${prefix}publications.sql`].body.toString(), PUBLICATIONS_SQL);
  assert.deepEqual(archived[`${prefix}gq.ops.json`].body, opsBefore);
  for (const [key, { body }] of backups) {
    assert.deepEqual(archived[`${prefix}backups/${key.slice("db/".length)}`].body, body);
  }

  const manifestBody = archived[`${prefix}manifest.json`].body;
  const manifest = JSON.parse(manifestBody);
  assert.equal(manifest.project, "fixture");
  assert.equal(manifest.prefix, prefix);
  assert.match(manifest.gq, /^\d+\.\d+\.\d+/u);
  assert.ok(Math.abs(Date.parse(manifest.archivedAt) - Date.now()) < 60_000);
  for (const file of manifest.files) {
    const stored = archived[`${prefix}${file.path}`].body;
    assert.equal(file.size, stored.length, file.path);
    assert.equal(file.sha256, sha256(stored), file.path);
  }
  assert.equal(manifest.files.find(({ path }) => path === "uploads.zip").entries, 3);
  assert.deepEqual(manifest.sources, {
    media: { bucket: "fixture-media", domain: "fixture-media.example.test" },
    backups: { bucket: "fixture-releases", prefix: "db/" },
    releases: { bucket: "fixture-releases" },
    ciBackups: { bucket: "fixture-ci-backups" },
    ploi: {
      serverId: "12",
      siteId: "34",
      domain: "fixture-cms.example.test",
      database: { name: "fixture_db", id: 56 },
      systemUser: { name: "fixture", id: 78 },
    },
    frontend: {
      worker: "fixture-fe",
      domain: "fixture-fe.example.test",
      d1: { name: "fixture-fe-publications", id: "d1-fixture" },
      stages: [],
    },
    ci: {
      worker: "fixture-ci",
      workflows: ["fixture-ci", "fixture-mirror"],
      containerApplication: "fixture-ci-cisandbox",
    },
    artifacts: { namespace: "fixture", repo: "fixture" },
    github: { repository: "Example/fixture", head: HEAD_COMMIT },
    cloudflare: { accountId: "account-1", zoneId: "zone-1", zoneName: "example.test" },
    sigillo: { projectId: "PROJECT123" },
  });

  // gq.ops.json: archived, with the archive, and without the deleted Ploi site.
  const ops = await readOps(fixture);
  assert.deepEqual(ops.offboarded.archive, {
    bucket: "offboarded-clients",
    prefix,
    manifestSha256: sha256(manifestBody),
  });
  assert.equal(ops.offboarded.phase, "archived");
  assert.ok(Math.abs(Date.parse(ops.offboarded.at) - Date.now()) < 60_000);
  const { ploi, offboarded, ...rest } = ops;
  void offboarded;
  const { siteId, ...keptPloi } = OPS.ploi;
  void siteId;
  assert.deepEqual(ploi, keptPloi);
  const { ploi: _ploi, ...restBefore } = OPS;
  void _ploi;
  assert.deepEqual(rest, restBefore, "nothing else in gq.ops.json changes");

  assert.match(
    result.stdout,
    new RegExp(
      `r2://offboarded-clients/${prefix} \\(manifest\\.json sha256 ${sha256(manifestBody)}\\)`,
      "u",
    ),
  );
  assert.match(result.stdout, /https:\/\/github\.com\/Example\/fixture \(archived, read-only\)/u);
  assert.match(result.stdout, /Sigillo project PROJECT123, kept/u);
});

test("offboard --archive deletes nothing that isn't the Site's", async () => {
  const { fixture, account } = await cutSite();
  const { state } = account;

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(state.workers, ["other-fe"]);
  assert.deepEqual(
    state.d1.map(({ uuid }) => uuid),
    ["d1-other"],
  );
  assert.deepEqual(state.workflows, ["other-ci"]);
  assert.deepEqual(
    state.containers.map(({ id }) => id),
    ["c-other"],
  );
  assert.deepEqual(Object.keys(state.buckets).sort(), ["offboarded-clients", "other-media"]);
  assert.deepEqual(Object.keys(state.buckets["other-media"]), ["x.jpg"]);
  assert.deepEqual(state.artifacts, [{ namespace: "other", name: "other" }]);
  assert.deepEqual(
    state.databases.map(({ id }) => id),
    [57],
  );
  assert.deepEqual(
    state.systemUsers.map(({ id }) => id),
    [79],
  );
  assert.deepEqual(
    state.hooks.map(({ id }) => id),
    [100],
  );
  assert.deepEqual(
    state.tokens.map(({ id }) => id),
    ["manager", "other"],
    "the manager token, another project's, and no temporary token, are left",
  );
});

// --- what is the Site's own -----------------------------------------------------

const object = (body) => ({ body: Buffer.from(body), lastModified: "2026-09-29T10:00:00.000Z" });

test("a backups bucket shared with other Sites keeps everything but the Site's own backups", async () => {
  // Every client's backups in one team bucket, as Ekis's backups-sites.
  const { fixture, account } = await cutSite({
    ops: { ...OPS, backups: { bucket: "backups-sites", prefix: "db/" } },
    state: {
      stagingBucket: "backups-sites",
      buckets: {
        ...structuredClone(fakeAccount().state.buckets),
        "backups-sites": {
          "db/fixture_db/2026-09-29T10-00-00Z.sql.gz": object("fixture's backup"),
          "db/other_db/2026-09-29T10-00-00Z.sql.gz": object("another client's backup"),
          "ekis/db/ekis/2026-09-29T10-00-00Z.sql.gz": object("Ekis's backup"),
        },
      },
    },
  });
  const { state } = account;
  const ownBackups = Object.keys(state.buckets["backups-sites"]).filter((key) =>
    key.startsWith("db/fixture_db/"),
  );
  assert.equal(ownBackups.length, 2, "the old backup and phase 1's final one");

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /- Archive: r2:\/\/offboarded-clients\/fixture\/[\d-]+\/backups\/ ← the 2 database backups in r2:\/\/backups-sites\/db\/fixture_db\//u,
  );
  assert.match(
    result.stdout,
    /- R2: delete the 2 backups under r2:\/\/backups-sites\/db\/fixture_db\/ once archived; the bucket and everything else in it stay/u,
  );
  assert.doesNotMatch(result.stdout, /empty backups-sites/u);
  assert.deepEqual(Object.keys(state.buckets["backups-sites"]).sort(), [
    "db/other_db/2026-09-29T10-00-00Z.sql.gz",
    "ekis/db/ekis/2026-09-29T10-00-00Z.sql.gz",
  ]);
  const archived = Object.keys(state.buckets["offboarded-clients"]).filter((key) =>
    key.includes("/backups/"),
  );
  assert.deepEqual(
    archived.map((key) => key.replace(/^fixture\/[\d-]+\/backups\//u, "")).sort(),
    ownBackups.map((key) => key.slice("db/".length)).sort(),
    "only the Site's own backups are archived",
  );
  assert.ok(!state.log.includes("bucket backups-sites deleted"));
});

test("a backups bucket deleted whole has everything under its backups prefix archived first", async () => {
  // fixture's releases bucket is its backups bucket too.
  const exposed = fakeAccount().state;
  const { fixture, account } = await cutSite({
    state: {
      buckets: {
        ...structuredClone(exposed.buckets),
        "fixture-releases": {
          ...structuredClone(exposed.buckets["fixture-releases"]),
          "db/fixture_old/2025-01-01T10-00-00Z.sql.gz": object("a backup from before a rename"),
          "db/notes.txt": object("placed by hand"),
        },
      },
    },
  });
  const { state } = account;

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /- Archive: r2:\/\/offboarded-clients\/fixture\/[\d-]+\/backups\/ ← the 4 database backups in r2:\/\/fixture-releases\/db\/$/mu,
  );
  const archived = state.buckets["offboarded-clients"];
  const prefix = `fixture/${today()}/backups/`;
  assert.equal(
    archived[`${prefix}fixture_old/2025-01-01T10-00-00Z.sql.gz`].body.toString(),
    "a backup from before a rename",
  );
  assert.equal(archived[`${prefix}notes.txt`].body.toString(), "placed by hand");
  assert.equal(state.buckets["fixture-releases"], undefined);
});

test("offboard --archive leaves any bucket, Worker, Workflow, container or Artifacts repository not named as gq names the project's for the operator", async () => {
  const ops = {
    ...OPS,
    ci: { worker: "team-ci", backupBucket: "team-ci-backups" },
    artifacts: { namespace: "fixture", repo: "team-site" },
  };
  const exposed = fakeAccount().state;
  const { fixture, account } = await cutSite({
    ops,
    state: {
      subdomains: { ...exposed.subdomains, "team-ci": { enabled: true, previews_enabled: false } },
      workers: [...exposed.workers, "team-ci"],
      workflows: [...exposed.workflows, "team-ci"],
      containers: [...exposed.containers, { id: "c-team", name: "team-ci-cisandbox" }],
      buckets: { ...exposed.buckets, "team-ci-backups": { "snapshots/1.tar": object("team") } },
      artifacts: [...exposed.artifacts, { namespace: "fixture", name: "team-site" }],
    },
  });
  const { state } = account;

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  const lines = planLines(result.stdout);
  for (const expected of [
    "  ! CI: the Worker team-ci isn't fixture's own (gq names it fixture-ci); delete it by hand if it should go",
    "  ! CI: the Workflow team-ci isn't fixture's own (gq names it fixture-ci); delete it by hand if it should go",
    "  ! CI: the container application team-ci-cisandbox isn't fixture's own (gq names it fixture-ci-cisandbox); delete it by hand if it should go",
    "  ! R2: the bucket team-ci-backups isn't fixture's own (gq names it fixture-ci-backups); empty and delete it by hand if it should go",
    "  ! Artifacts: the repository fixture/team-site isn't fixture's own (gq names it fixture); delete it by hand if it should go",
  ]) {
    assert.ok(lines.includes(expected), `${expected}\n${lines.join("\n")}`);
  }
  assert.ok(state.workers.includes("team-ci"));
  assert.ok(state.workflows.includes("team-ci"));
  assert.ok(state.containers.some(({ id }) => id === "c-team"));
  assert.deepEqual(Object.keys(state.buckets["team-ci-backups"]), ["snapshots/1.tar"]);
  assert.ok(state.artifacts.some(({ name }) => name === "team-site"));
  // What is named as the project's own still goes.
  assert.ok(!state.workers.includes("fixture-fe"));
  assert.ok(!state.workflows.includes("fixture-mirror"));
  assert.equal(state.buckets["fixture-media"], undefined);
});

test("offboard --archive leaves a sibling project's buckets and CI Worker named in a copied gq.ops.json", async () => {
  // fixture's gq.ops.json, copied from its sibling Site fixture-shop's.
  const ops = {
    ...OPS,
    releases: { bucket: "fixture-shop-releases", prefix: "admin/" },
    ci: { worker: "fixture-shop-ci", backupBucket: "fixture-shop-ci-backups" },
  };
  const exposed = fakeAccount().state;
  const { fixture, account } = await cutSite({
    ops,
    state: {
      subdomains: {
        ...exposed.subdomains,
        "fixture-shop-ci": { enabled: true, previews_enabled: false },
      },
      workers: [...exposed.workers, "fixture-shop-ci"],
      workflows: [...exposed.workflows, "fixture-shop-ci"],
      containers: [...exposed.containers, { id: "c-shop", name: "fixture-shop-ci-cisandbox" }],
      buckets: {
        ...structuredClone(exposed.buckets),
        "fixture-shop-releases": { "admin/release-9.tar.gz": object("the shop's release") },
        "fixture-shop-ci-backups": { "snapshots/9.tar": object("the shop's snapshot") },
      },
    },
  });
  const { state } = account;

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  const lines = planLines(result.stdout);
  for (const expected of [
    "  ! CI: the Worker fixture-shop-ci isn't fixture's own (gq names it fixture-ci); delete it by hand if it should go",
    "  ! R2: the bucket fixture-shop-releases isn't fixture's own (gq names it fixture-releases); empty and delete it by hand if it should go",
    "  ! R2: the bucket fixture-shop-ci-backups isn't fixture's own (gq names it fixture-ci-backups); empty and delete it by hand if it should go",
  ]) {
    assert.ok(lines.includes(expected), `${expected}\n${lines.join("\n")}`);
  }
  assert.ok(state.workers.includes("fixture-shop-ci"));
  assert.ok(state.workflows.includes("fixture-shop-ci"));
  assert.ok(state.containers.some(({ id }) => id === "c-shop"));
  assert.deepEqual(Object.keys(state.buckets["fixture-shop-releases"]), ["admin/release-9.tar.gz"]);
  assert.deepEqual(Object.keys(state.buckets["fixture-shop-ci-backups"]), ["snapshots/9.tar"]);
});

test("offboard --archive neither archives nor detaches a media bucket that isn't the project's own", async () => {
  // One media bucket serving several clients.
  const ops = { ...OPS, media: { bucket: "team-media", domain: "team-media.example.test" } };
  const exposed = fakeAccount().state;
  const { fixture, account } = await cutSite({
    ops,
    state: {
      bucketDomains: { "team-media": [{ domain: "team-media.example.test", enabled: true }] },
      buckets: {
        ...structuredClone(exposed.buckets),
        "team-media": {
          "fixture/a.jpg": object("fixture's"),
          "other/b.jpg": object("another client's"),
        },
      },
      dnsRecords: [
        ...exposed.dnsRecords.filter(({ id }) => id !== "r-media"),
        { id: "r-team", type: "CNAME", name: "team-media.example.test", content: "public.r2.dev" },
      ],
    },
  });
  const { state } = account;

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  const lines = planLines(result.stdout);
  for (const expected of [
    "  ! Archive: the bucket team-media isn't fixture's own (gq names it fixture-media): none of its objects is archived; archive fixture's uploads by hand",
    "  ! Media: the custom domain team-media.example.test stays on team-media, which isn't fixture's own (gq names it fixture-media); remove it by hand if it should go",
    "  ! DNS: team-media.example.test stays: it serves team-media, which isn't fixture's own; delete its record by hand if it should go",
  ]) {
    assert.ok(lines.includes(expected), `${expected}\n${lines.join("\n")}`);
  }
  assert.ok(!lines.some((line) => line.includes("uploads.zip")), lines.join("\n"));
  const archived = Object.keys(state.buckets["offboarded-clients"]);
  assert.ok(!archived.some((key) => key.endsWith("uploads.zip")), archived.join("\n"));
  assert.deepEqual(Object.keys(state.buckets["team-media"]).sort(), [
    "fixture/a.jpg",
    "other/b.jpg",
  ]);
  assert.deepEqual(state.bucketDomains["team-media"], [
    { domain: "team-media.example.test", enabled: true },
  ]);
  assert.ok(state.dnsRecords.some(({ id }) => id === "r-team"));
  assert.equal((await readOps(fixture)).offboarded.phase, "archived");
});

test("offboard --archive keeps a Ploi system user another site on the server runs as", async () => {
  const { fixture, account } = await cutSite({
    state: {
      otherSites: [
        { id: 35, domain: "other-cms.example.test", system_user: "other" },
        { id: 36, domain: "fixture-shop.example.test", system_user: "fixture" },
      ],
    },
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    planLines(result.stdout).includes(
      "  ! Ploi: the system user fixture stays: fixture-shop.example.test runs as it too; delete it by hand once nothing does",
    ),
    result.stdout,
  );
  assert.deepEqual(
    account.state.systemUsers.map(({ id }) => id),
    [78, 79],
  );
  assert.ok(account.state.log.includes("ploi site deleted"));
});

test("offboard --archive refuses when ploi.siteId is another site than domains.admin", async () => {
  const { fixture, account } = await cutSite();
  account.state.site = { ...account.state.site, domain: "other-cms.example.test" };

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /The Ploi site 34 \(gq\.ops\.json ploi\.siteId\) is other-cms\.example\.test, not fixture-cms\.example\.test \(domains\.admin\): stopping before anything changes\./u,
  );
  assert.deepEqual(account.state.log, []);
  assert.ok(account.state.tokens.every(({ id }) => !id.startsWith("temp-")));
});

test("offboard --archive refuses when the Ploi site isn't the one its system user and database name", async () => {
  for (const [change, message] of [
    [
      (state) => {
        state.site = { ...state.site, system_user: "other" };
      },
      /The Ploi site 34 \(gq\.ops\.json ploi\.siteId\) runs as other, not fixture \(ploi\.systemUser\): stopping before anything changes\./u,
    ],
    [
      (state) => {
        state.siteEnv = "DB_NAME=other_db\n";
      },
      /The Ploi site fixture-cms\.example\.test's \.env has DB_NAME other_db, not fixture_db \(gq\.ops\.json ploi\.database\): stopping before anything changes\./u,
    ],
  ]) {
    const { fixture, account } = await cutSite();
    change(account.state);

    const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
    assert.deepEqual(account.state.log, []);
    assert.deepEqual(
      account.state.databases.map(({ id }) => id),
      [56, 57],
    );
    assert.equal(account.state.buckets["offboarded-clients"], undefined, "nothing is archived");
  }
});

test("offboard --archive archives and deletes the Frontend's other stages too", async () => {
  const exposed = fakeAccount().state;
  const { fixture, account } = await cutSite({
    state: {
      workers: [...exposed.workers, "fixture-fe-staging", "fixture-fe-shop-fe"],
      subdomains: {
        ...exposed.subdomains,
        "fixture-fe-staging": { enabled: true, previews_enabled: true },
        "fixture-fe-shop-fe": { enabled: true, previews_enabled: true },
      },
      d1: [...exposed.d1, { uuid: "d1-staging", name: "fixture-fe-publications-staging" }],
      d1Exports: { "d1-staging": "-- staging\n" },
      bindings: { "fixture-fe-staging": publicationBinding("d1-staging") },
    },
  });
  const { state } = account;

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  const prefix = `fixture/${today()}/`;
  const lines = planLines(result.stdout);
  for (const expected of [
    `  - Archive: r2://offboarded-clients/${prefix}publications-staging.sql ← the D1 store fixture-fe-publications-staging`,
    "  - Frontend: delete the Worker fixture-fe-staging",
    "  - Frontend: delete the D1 store fixture-fe-publications-staging (d1-staging)",
    "  ! Frontend: the Worker fixture-fe-shop-fe is named like one of fixture's Frontend stages, but no PUBLICATION_DB binding to fixture-fe-publications-<stage> ties it to fixture; check it by hand",
  ]) {
    assert.ok(lines.includes(expected), `${expected}\n${lines.join("\n")}`);
  }
  const archived = state.buckets["offboarded-clients"];
  assert.equal(archived[`${prefix}publications-staging.sql`].body.toString(), "-- staging\n");
  const manifest = JSON.parse(archived[`${prefix}manifest.json`].body);
  assert.ok(manifest.files.some(({ path }) => path === "publications-staging.sql"));
  assert.deepEqual(manifest.sources.frontend.stages, [
    {
      worker: "fixture-fe-staging",
      d1: { name: "fixture-fe-publications-staging", id: "d1-staging" },
    },
  ]);
  assert.deepEqual(state.workers, ["other-fe", "fixture-fe-shop-fe"]);
  assert.deepEqual(
    state.d1.map(({ uuid }) => uuid),
    ["d1-other"],
  );
});

test("offboard --archive deletes no Worker or D1 store named like a stage that nothing ties to the project", async () => {
  const exposed = fakeAccount().state;
  const { fixture, account } = await cutSite({
    state: {
      // Project fixture-fe's production Worker and store, a personal stage
      // without a store, and a store no stage Worker binds.
      workers: [...exposed.workers, "fixture-fe-fe", "fixture-fe-valeriovaz"],
      subdomains: {
        ...exposed.subdomains,
        "fixture-fe-fe": { enabled: true, previews_enabled: true },
        "fixture-fe-valeriovaz": { enabled: true, previews_enabled: true },
      },
      d1: [
        ...exposed.d1,
        { uuid: "d1-sibling", name: "fixture-fe-fe-publications" },
        { uuid: "d1-old", name: "fixture-fe-publications-old" },
      ],
      bindings: { "fixture-fe-fe": publicationBinding("d1-sibling") },
    },
  });
  const { state } = account;

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  const lines = planLines(result.stdout);
  for (const expected of [
    "  ! Frontend: the Worker fixture-fe-fe is named like one of fixture's Frontend stages, but no PUBLICATION_DB binding to fixture-fe-publications-<stage> ties it to fixture; check it by hand",
    "  ! Frontend: the Worker fixture-fe-valeriovaz is named like one of fixture's Frontend stages, but no PUBLICATION_DB binding to fixture-fe-publications-<stage> ties it to fixture; check it by hand",
    "  ! Frontend: the D1 store fixture-fe-publications-old is named like one of fixture's stages' publication stores, but no fixture-fe-<stage> Worker binds it; check it by hand",
  ]) {
    assert.ok(lines.includes(expected), `${expected}\n${lines.join("\n")}`);
  }
  assert.deepEqual(state.workers.sort(), ["fixture-fe-fe", "fixture-fe-valeriovaz", "other-fe"]);
  assert.deepEqual(state.d1.map(({ uuid }) => uuid).sort(), ["d1-old", "d1-other", "d1-sibling"]);
  const manifest = JSON.parse(
    state.buckets["offboarded-clients"][`fixture/${today()}/manifest.json`].body,
  );
  assert.deepEqual(manifest.sources.frontend.stages, []);
});

// --- verification ------------------------------------------------------------

// `account.fetch`, except that `override(request)` may answer first.
function intercepting(account, override) {
  return recordingFetch(
    async (request) => (await override(request)) ?? account.fetch(request.url, request),
  );
}

// A bucket's objects as they are now: key → { bytes, lastModified }.
const snapshot = (objects) =>
  Object.fromEntries(
    Object.entries(objects).map(([key, { body, lastModified }]) => [
      key,
      { bytes: body.toString("hex"), lastModified },
    ]),
  );

const isArchive = (url) => new URL(url).pathname.startsWith("/offboarded-clients/");

async function assertNothingDeleted(fixture, account) {
  assert.deepEqual(account.state.log, ["bucket offboarded-clients created", "database backed up"]);
  const ops = await readOps(fixture);
  assert.deepEqual(ops.offboarded.phase, "cut");
  assert.equal(ops.offboarded.archive, undefined, "no archive is recorded");
  assert.equal(ops.ploi.siteId, "34");
  assert.equal(account.state.site.status, "suspended");
  assert.deepEqual(
    account.state.tokens
      .filter(({ name }) => name.startsWith("GETQUICK FIXTURE "))
      .map(({ status }) => status),
    ["disabled", "disabled", "disabled", "disabled"],
  );
  assert.ok(
    account.state.tokens.every(({ id }) => !id.startsWith("temp-")),
    "every temporary token is deleted",
  );
}

test("an archived file that reads back differently stops the archive before anything is deleted", async () => {
  const { fixture, account } = await cutSite();
  const fetch = intercepting(account, async ({ method, url }) => {
    if (method === "GET" && isArchive(url) && url.includes("/database.sql.gz")) {
      return new Response("dumq");
    }
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    fetch,
    exec: account.exec,
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `The archive at r2://offboarded-clients/fixture/${today()}/ failed verification: database\\.sql\\.gz's sha256 differs\\. Nothing was deleted\\.`,
      "u",
    ),
  );
  await assertNothingDeleted(fixture, account);
});

test("uploads.zip holding fewer entries than the media bucket has objects stops the archive", async () => {
  const { fixture, account } = await cutSite();
  // An upload lands in the media bucket while uploads.zip is being written.
  const fetch = intercepting(account, async (request) => {
    const response = await account.fetch(request.url, request);
    if (
      request.method === "PUT" &&
      isArchive(request.url) &&
      request.url.includes("/uploads.zip")
    ) {
      account.state.buckets["fixture-media"]["late.jpg"] = {
        body: Buffer.from("late"),
        lastModified: new Date().toISOString(),
      };
    }
    return response;
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    fetch,
    exec: account.exec,
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /failed verification: uploads\.zip holds 3 entries, but fixture-media has 4 objects\. Nothing was deleted/u,
  );
  await assertNothingDeleted(fixture, account);
});

for (const [what, source, message] of [
  [
    "a media object",
    "/fixture-media/2026/01/a.jpg",
    "2026/01/a\\.jpg read 3 bytes, but r2://fixture-media lists 6",
  ],
  [
    "a backup",
    "/fixture-releases/db/fixture_db/2026-09-30T10-00-00Z.sql.gz",
    "db/fixture_db/2026-09-30T10-00-00Z\\.sql\\.gz read 3 bytes, but r2://fixture-releases lists 10",
  ],
]) {
  test(`${what} that reads back shorter than its listing stops the archive before anything is deleted`, async () => {
    const { fixture, account } = await cutSite();
    // A body cut short without an error.
    const fetch = intercepting(account, async ({ method, url }) => {
      if (
        method === "GET" &&
        new URL(url).pathname === source.split("/").map(encodeURIComponent).join("/")
      ) {
        return new Response("abc");
      }
    });

    const result = await fixture.run(["offboard", "--archive", "--yes"], {
      env: ENV,
      fetch,
      exec: account.exec,
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      new RegExp(
        `${message}: stopping before anything is deleted\\. Move what this run wrote under r2://offboarded-clients/fixture/${today()}/ aside, then run gq offboard --archive again\\.`,
        "u",
      ),
    );
    assert.ok(
      account.state.log.every((entry) => !/deleted$/u.test(entry)),
      account.state.log.join("\n"),
    );
    assert.equal((await readOps(fixture)).offboarded.archive, undefined, "no archive is recorded");
  });
}

test("offboard --archive refuses when the final backup the cut took is missing", async () => {
  const { fixture, account } = await cutSite();
  for (const key of Object.keys(account.state.buckets["fixture-releases"])) {
    if (key.startsWith("db/")) delete account.state.buckets["fixture-releases"][key];
  }

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /There is no database backup under r2:\/\/fixture-releases\/db\/fixture_db\/, though gq offboard took a final one there: stopping before anything is written or deleted\./u,
  );
  assert.deepEqual(account.state.log, []);
});

test("no deletion request is sent before the archive is read back", async () => {
  const { fixture, account } = await cutSite();

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  const requests = account.fetch.requests;
  const lastArchiveRead = requests.findLastIndex(
    ({ method, url }) => method === "GET" && isArchive(url),
  );
  const firstDeletion = requests.findIndex(
    ({ method, url }) => method === "DELETE" && !/\/tokens\/temp-/u.test(url),
  );
  assert.ok(
    lastArchiveRead > 0 && firstDeletion > lastArchiveRead,
    `${lastArchiveRead} < ${firstDeletion}`,
  );
  // Every file but manifest.json was written before; each is read back.
  const reads = requests
    .filter(({ method, url }) => method === "GET" && isArchive(url) && !url.includes("list-type"))
    .map(({ url }) => decodeURIComponent(new URL(url).pathname.split("/").slice(4).join("/")));
  assert.deepEqual(
    new Set(reads),
    new Set([
      "uploads.zip",
      "database.sql.gz",
      "publications.sql",
      "backups/fixture_db/2026-09-30T10-00-00Z.sql.gz",
      ...reads.filter((path) => /^backups\/fixture_db\/2026-1/u.test(path)),
      "gq.ops.json",
      "manifest.json",
    ]),
  );
});

// --- secrets -------------------------------------------------------------------

// What must never be printed: the injected and Sigillo values, every token the
// run mints, the S3 secret each scoped key derives from it, and a presigned
// URL's signature.
function assertNoSecret(result) {
  const output = `${result.stdout}${result.stderr}`;
  const minted = Array.from({ length: 30 }, (_, index) => `temp-value-${index + 1}`);
  for (const secret of [
    "manager-secret",
    "ploi-secret",
    "r2-secret",
    ...minted,
    ...minted.map((value) => sha256(value)),
    "X-Amz-Signature=",
  ]) {
    assert.ok(!output.includes(secret), `${secret} is printed`);
  }
}

test("offboard --archive prints no secret", async () => {
  const { fixture, account } = await cutSite();

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assertNoSecret(result);
});

test("offboard --archive redacts what R2 and gh echo back when they fail", async () => {
  const r2 = await cutSite();
  const signature = "deadbeefcafe";
  const failing = intercepting(r2.account, ({ method, url }) => {
    if (method === "PUT" && isArchive(url) && url.includes("/uploads.zip")) {
      return new Response(
        `<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided.</Message><AWSAccessKeyId>temp-2</AWSAccessKeyId><CanonicalRequest>PUT /offboarded-clients/x?X-Amz-Credential=temp-2&amp;X-Amz-Signature=${signature}</CanonicalRequest><SignatureProvided>${signature}</SignatureProvided></Error>`,
        { status: 403 },
      );
    }
  });
  // uploads.zip is the archive key's first request, so R2's 403 is waited
  // out as the key's propagation first.
  const clock = fakeClock();
  const r2Failure = await r2.fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    fetch: failing,
    exec: r2.account.exec,
    clock,
  });
  assert.equal(r2Failure.code, 1);
  assert.match(r2Failure.stderr, /R2 PUT .*uploads\.zip failed with 403: SignatureDoesNotMatch/u);
  assert.equal(
    clock.sleeps.reduce((sum, ms) => sum + ms, 0),
    90_000,
  );
  assert.ok(!r2Failure.stderr.includes(signature), r2Failure.stderr);
  assertNoSecret(r2Failure);

  const gh = await cutSite();
  const exec = recordingExec(({ command, args, ...options }) =>
    command === "gh" && args[0] === "repo"
      ? {
          code: 1,
          stderr:
            "HTTP 401: Bad credentials (https://api.github.com/repos/Example/fixture?access_token=ghs_leaked)",
        }
      : gh.account.exec(command, args, options),
  );
  const ghFailure = await gh.fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    fetch: gh.account.fetch,
    exec,
  });
  assert.equal(ghFailure.code, 1);
  assert.match(
    ghFailure.stderr,
    /gh repo archive Example\/fixture failed: HTTP 401: Bad credentials/u,
  );
  assert.ok(!ghFailure.stderr.includes("ghs_leaked"), ghFailure.stderr);
});

test("a scoped key that fails to delete doesn't hide why the archive stopped", async () => {
  const { fixture, account } = await cutSite();
  const fetch = intercepting(account, ({ method, url }) => {
    const failure = (message) =>
      new Response(JSON.stringify({ success: false, errors: [{ message }] }), { status: 500 });
    if (method === "DELETE" && url.endsWith("/dns_records/r-media")) return failure("boom");
    // The first scoped key the run minted (after its own token, temp-2).
    if (method === "DELETE" && url.endsWith("/tokens/temp-3")) return failure("key cleanup");
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    fetch,
    exec: account.exec,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /dns_records\/r-media failed: boom/u);
  assert.ok(
    account.state.tokens
      .filter(({ id }) => id.startsWith("temp-"))
      .map(({ id }) => id)
      .every((id) => id === "temp-3"),
    "every other temporary token is deleted",
  );
});

// --- freshly minted keys ------------------------------------------------------

// The access key an R2 request is signed with.
const r2AccessKey = ({ url, headers }) =>
  new URL(url).hostname.endsWith(".r2.cloudflarestorage.com")
    ? /Credential=([^/,]+)/u.exec(headers.authorization ?? headers.Authorization ?? "")?.[1]
    : undefined;

const unauthorized = () =>
  new Response(
    '<?xml version="1.0"?><Error><Code>Unauthorized</Code><Message>Unauthorized</Message></Error>',
    { status: 401 },
  );

// R2 answers 401 to the first `count` requests signed with the first key the
// run mints for a bucket (temp-2 is the run's own API token), as it does
// while a new token propagates.
function propagating(account, count) {
  let first;
  let rejected = 0;
  return intercepting(account, (request) => {
    const key = r2AccessKey(request);
    if (!key?.startsWith("temp-")) return;
    first ??= key;
    if (key === first && rejected < count) {
      rejected += 1;
      return unauthorized();
    }
  });
}

test("a freshly minted key R2 rejects at first is retried with backoff until it works", async () => {
  const { fixture, account } = await cutSite();
  const clock = fakeClock();

  const result = await fixture.run(["offboard", "--archive", "--dry-run"], {
    env: ENV,
    fetch: propagating(account, 3),
    exec: account.exec,
    clock,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(clock.sleeps, [2000, 4000, 8000]);
});

test("a freshly minted key R2 never accepts fails after 90 s, saying so", async () => {
  const { fixture, account } = await cutSite();
  const clock = fakeClock();

  const result = await fixture.run(["offboard", "--archive", "--dry-run"], {
    env: ENV,
    fetch: propagating(account, Infinity),
    exec: account.exec,
    clock,
  });

  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "gq: R2 listing fixture-releases failed with 401: Unauthorized: Unauthorized (the key was minted just now; gq waited 90 s for R2 to accept it)\n",
  );
  assert.deepEqual(
    clock.sleeps,
    [2000, 4000, 8000, 10000, 10000, 10000, 10000, 10000, 10000, 10000, 6000],
  );
  assertNoSecret(result);
});

test("a presigned URL goes to Ploi only once R2 accepts its freshly minted key", async () => {
  // Without the media bucket to archive, the database dump is the first
  // thing written with the archive's key, and Ploi's server writes it.
  const ops = { ...OPS, media: { bucket: "team-media", domain: "team-media.example.test" } };
  const { fixture, account } = await cutSite({ ops });
  const clock = fakeClock();
  const archiveBucket = (url) =>
    new URL(url).hostname.endsWith(".r2.cloudflarestorage.com") &&
    new URL(url).pathname.split("/")[1] === "offboarded-clients";
  let rejected = 0;
  const fetch = intercepting(account, ({ url }) => {
    if (archiveBucket(url) && rejected < 2) {
      rejected += 1;
      return unauthorized();
    }
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    fetch,
    exec: account.exec,
    clock,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(clock.sleeps, [2000, 4000]);
  const accepted = fetch.requests.filter(({ url }) => archiveBucket(url))[2];
  const dump = fetch.requests.find(
    ({ method, url }) => method === "POST" && url.endsWith("/scripts/run"),
  );
  assert.ok(accepted, "gq checks R2 accepts the archive's key");
  assert.ok(
    fetch.requests.indexOf(accepted) < fetch.requests.indexOf(dump),
    "before Ploi uploads the dump with it",
  );
});

test("a 401 for a key R2 has already accepted is not retried", async () => {
  const { fixture, account } = await cutSite();
  const clock = fakeClock();
  // R2 accepts the archive's key once, then rejects it.
  let accepted = false;
  const fetch = intercepting(account, ({ url }) => {
    if (!new URL(url).hostname.endsWith(".r2.cloudflarestorage.com") || !isArchive(url)) return;
    if (accepted) return unauthorized();
    accepted = true;
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    fetch,
    exec: account.exec,
    clock,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /^gq: R2 .* failed with 401: Unauthorized: Unauthorized\n$/u);
  assert.deepEqual(clock.sleeps, []);
});

// --- Ploi deletes a site in the background ---------------------------------------

test("the database and system user are deleted only once Ploi no longer shows the deleted site", async () => {
  const { fixture, account } = await cutSite({ state: { siteLingers: 3 } });
  const clock = fakeClock();

  const result = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    ...account,
    clock,
  });

  assert.equal(result.code, 0, result.stderr);
  const log = account.state.log;
  assert.deepEqual(
    log.slice(log.indexOf("ploi site deleted"), log.indexOf("ploi site deleted") + 4),
    [
      "ploi site deleted",
      "ploi site gone",
      "ploi database 56 deleted",
      "ploi system user 78 deleted",
    ],
  );
  assert.deepEqual(clock.sleeps, [2000, 4000, 8000]);
});

test("a deleted site Ploi still shows after 5 minutes stops the run before its database goes", async () => {
  const { fixture, account } = await cutSite({ state: { siteLingers: Infinity } });
  const clock = fakeClock();

  const result = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    ...account,
    clock,
  });

  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "gq: Ploi still shows the site 34 5 minutes after deleting it: run gq offboard --archive again once it is gone.\n",
  );
  assert.equal(
    clock.sleeps.reduce((sum, ms) => sum + ms, 0),
    5 * 60_000,
  );
  assert.equal(account.state.log.at(-1), "ploi site deleted");
  assert.equal((await readOps(fixture)).ploi.siteId, undefined, "the deleted site is forgotten");
});

test("a system user Ploi refuses to delete at first is retried with backoff until it goes", async () => {
  const { fixture, account } = await cutSite({ state: { systemUserRefusals: 2 } });
  const clock = fakeClock();

  const result = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    ...account,
    clock,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(account.state.log.includes("ploi system user 78 deleted"));
  assert.deepEqual(clock.sleeps, [2000, 4000]);
});

test("a system user Ploi never lets go fails after 5 minutes with Ploi's reasons", async () => {
  const { fixture, account } = await cutSite({ state: { systemUserRefusals: Infinity } });
  const clock = fakeClock();

  const result = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    ...account,
    clock,
  });

  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "gq: Ploi DELETE /system-users/78 failed with 422: The given data was invalid. (user: The system user still has sites.) Ploi still refused it after gq retried for 5 minutes.\n",
  );
  assert.deepEqual(clock.sleeps, [2000, 4000, 8000, ...Array(28).fill(10_000), 6000]);
  assert.ok(account.state.workers.includes("fixture-fe"), "nothing after it is deleted");
});

// --- the shared zone and the tokens -------------------------------------------

test("offboard --archive deletes only the Site's own hosts' records from the shared zone", async () => {
  const { fixture, account } = await cutSite();

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    account.state.dnsRecords.map(({ id }) => id),
    ["r-other", "r-sub", "r-apex"],
    "another Site's host, a host under the Site's and the apex stay",
  );
  const zoneChanges = changes(account.fetch).filter((change) => change.includes("/zones/"));
  assert.deepEqual(zoneChanges, [
    "DELETE /client/v4/zones/zone-1/dns_records/r-cms",
    "DELETE /client/v4/zones/zone-1/dns_records/r-fe",
    "DELETE /client/v4/zones/zone-1/dns_records/r-media",
  ]);
});

test("offboard --archive deletes only the A, AAAA and CNAME records serving the Site's hosts", async () => {
  const exposed = fakeAccount().state;
  const { fixture, account } = await cutSite({
    state: {
      dnsRecords: [
        ...exposed.dnsRecords,
        {
          id: "r-fe-mx",
          type: "MX",
          name: "fixture-fe.example.test",
          content: "mail.example.test",
        },
        { id: "r-fe-txt", type: "TXT", name: "fixture-fe.example.test", content: "v=spf1 -all" },
        { id: "r-fe-caa", type: "CAA", name: "fixture-fe.example.test", content: '0 issue "ca"' },
      ],
    },
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  const lines = planLines(result.stdout);
  for (const record of [
    "MX fixture-fe.example.test → mail.example.test",
    "TXT fixture-fe.example.test → v=spf1 -all",
  ]) {
    assert.ok(
      lines.includes(
        `  ! DNS: ${record} stays: only A, AAAA and CNAME records serve the Site; delete it by hand if it should go`,
      ),
      lines.join("\n"),
    );
  }
  assert.deepEqual(
    account.state.dnsRecords.map(({ id }) => id),
    ["r-other", "r-sub", "r-apex", "r-fe-mx", "r-fe-txt", "r-fe-caa"],
  );
});

test("offboard --archive deletes no record at the zone's apex", async () => {
  const { fixture, account } = await cutSite();
  await rewriteOps(fixture, (ops) => {
    ops.domains.frontend = "example.test";
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    planLines(result.stdout).includes(
      "  ! DNS: example.test is the zone's apex: gq deletes no record there; delete the Site's by hand",
    ),
    result.stdout,
  );
  assert.ok(account.state.dnsRecords.some(({ id }) => id === "r-apex"));
  assert.ok(!account.state.dnsRecords.some(({ id }) => id === "r-cms"));
});

test("the project's tokens are deleted after everything else on Cloudflare, and kept when that fails", async () => {
  const { fixture, account } = await cutSite();
  const fetch = intercepting(account, ({ method, url }) => {
    if (method === "DELETE" && url.endsWith("/dns_records/r-media")) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: "boom" }] }), {
        status: 500,
      });
    }
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    fetch,
    exec: account.exec,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /dns_records\/r-media failed: boom/u);
  assert.ok(
    !account.state.log.some((entry) => /^token t-/u.test(entry)),
    account.state.log.join("\n"),
  );
  assert.deepEqual(
    account.state.tokens.map(({ id }) => id),
    ["manager", "t-alchemy", "t-releases", "t-media", "t-deploy", "other"],
  );
  assert.equal(account.state.hooks.length, 2, "GitHub comes after the tokens");
});

test("offboard --archive deletes every project token however many pages list them", async () => {
  const exposed = fakeAccount().state;
  const { fixture, account } = await cutSite({
    state: {
      tokens: [exposed.tokens[0], ...structuredClone(CROWDED_TOKENS), ...exposed.tokens.slice(1)],
    },
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    account.state.tokens.filter(({ name }) => name.startsWith("GETQUICK FIXTURE ")),
    [],
  );
  assert.equal(account.state.tokens.length, 2 + CROWDED_TOKENS.length);
});

test("offboard --archive finds the CI webhook however many pages list the hooks", async () => {
  const exposed = fakeAccount().state;
  const { fixture, account } = await cutSite({
    state: { hooks: [...structuredClone(CROWDED_HOOKS), ...exposed.hooks] },
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(account.state.log.includes("github hook 99 deleted"), account.state.log.join("\n"));
  assert.equal(account.state.hooks.length, CROWDED_HOOKS.length + 1);
});

// --- rerunning ------------------------------------------------------------------

test("offboard --archive says something is deleted only once an exact lookup finds it gone", async () => {
  // The account's listings leave these out; each is still there.
  const { fixture, account } = await cutSite({
    state: { unlisted: ["fixture-ci", "fixture-mirror", "fixture-ci-backups"] },
  });
  const { state } = account;

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  const lines = planLines(result.stdout);
  for (const expected of [
    "  - CI: delete the Worker fixture-ci",
    "  - CI: delete the Workflow fixture-ci",
    "  - CI: delete the Workflow fixture-mirror",
    "  - R2: empty fixture-ci-backups (with a key scoped to it) and delete it",
  ]) {
    assert.ok(lines.includes(expected), `${expected}\n${lines.join("\n")}`);
  }
  assert.ok(!state.workers.includes("fixture-ci"));
  assert.ok(!state.workflows.includes("fixture-mirror"));
  assert.equal(state.buckets["fixture-ci-backups"], undefined);
});

test("offboard --archive finds the Site's container application however many pages list them", async () => {
  const exposed = fakeAccount().state;
  const crowded = Array.from({ length: 60 }, (_, index) => ({
    id: `c-client-${index}`,
    name: `client${index}-ci-cisandbox`,
  }));
  const { fixture, account } = await cutSite({
    state: { containers: [...crowded, ...exposed.containers] },
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    account.state.log.includes("container application c-fixture deleted"),
    account.state.log.join("\n"),
  );
  assert.equal(account.state.containers.length, 61);
});

test("offboard --archive stops when a Ploi listing runs past the pages gq reads", async () => {
  // More sites than 50 pages of 50 hold: the one sharing the user comes last.
  const otherSites = Array.from({ length: 2550 }, (_, index) => ({
    id: 1000 + index,
    domain: `client${index}.example.test`,
    system_user: `client${index}`,
  }));
  const { fixture, account } = await cutSite({
    state: {
      otherSites: [
        ...otherSites,
        { id: 36, domain: "fixture-shop.example.test", system_user: "fixture" },
      ],
    },
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Ploi GET \/sites has more than 50 pages/u);
  assert.deepEqual(account.state.log, []);
  assert.deepEqual(
    account.state.systemUsers.map(({ id }) => id),
    [78, 79],
  );
});

test("offboard --archive never writes over objects already under its prefix", async () => {
  const { fixture, account } = await cutSite();
  const prefix = `fixture/${today()}/`;
  // A verified archive whose gq.ops.json record was lost (never committed).
  account.state.buckets["offboarded-clients"] = {
    [`${prefix}uploads.zip`]: object("the complete uploads"),
    [`${prefix}manifest.json`]: object("{}"),
  };
  const before = snapshot(account.state.buckets["offboarded-clients"]);

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `r2://offboarded-clients/${prefix} already holds 2 objects, and gq\\.ops\\.json records no archive: gq never archives over them\\.`,
      "u",
    ),
  );
  assert.deepEqual(snapshot(account.state.buckets["offboarded-clients"]), before);
  assert.deepEqual(account.state.log, []);
});

for (const [gone, take] of [
  [
    "the Ploi site fixture-cms.example.test, the database fixture_db, the Frontend Worker fixture-fe, the D1 store fixture-fe-publications are",
    (state) => {
      state.site = null;
      state.databases = state.databases.filter(({ name }) => name !== "fixture_db");
      state.workers = state.workers.filter((name) => name !== "fixture-fe");
      state.d1 = state.d1.filter(({ name }) => name !== "fixture-fe-publications");
    },
  ],
  [
    "the D1 store fixture-fe-publications is",
    (state) => {
      state.d1 = state.d1.filter(({ name }) => name !== "fixture-fe-publications");
    },
  ],
]) {
  test(`offboard --archive starts no new archive once a source is gone: ${gone.split(",")[0]}…`, async () => {
    const { fixture, account } = await cutSite();
    take(account.state);

    const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

    assert.equal(result.code, 1);
    assert.ok(
      result.stderr.includes(
        `${gone} already gone, but gq.ops.json records no archive (offboarded.archive): a new archive would miss`,
      ),
      result.stderr,
    );
    assert.deepEqual(account.state.log, []);
    assert.equal(account.state.buckets["offboarded-clients"], undefined, "nothing is archived");
  });
}

test("offboard --archive after a failed deletion resumes where it stopped, without archiving again", async () => {
  const { fixture, account } = await cutSite();
  const failing = intercepting(account, ({ method, url }) => {
    if (method === "DELETE" && url.endsWith("/workers/scripts/fixture-ci")) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: "boom" }] }), {
        status: 500,
      });
    }
  });
  const first = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    fetch: failing,
    exec: account.exec,
  });
  assert.equal(first.code, 1);
  assert.deepEqual(account.state.log.slice(-3), [
    "ploi system user 78 deleted",
    "worker fixture-fe deleted",
    "d1 d1-fixture deleted",
  ]);
  const recorded = await readOps(fixture);
  assert.equal(recorded.offboarded.phase, "cut");
  assert.equal(recorded.offboarded.archive.prefix, `fixture/${today()}/`);
  assert.equal(recorded.ploi.siteId, undefined, "the deleted site is forgotten");
  const archived = snapshot(account.state.buckets["offboarded-clients"]);

  // Neither the cut nor the restore can run over a Site being archived.
  const cut = await fixture.run(["offboard", "--yes"], { env: ENV, ...account });
  assert.equal(cut.code, 1);
  assert.match(cut.stderr, /fixture is being archived .*finish it with gq offboard --archive/u);
  const restore = await fixture.run(["offboard", "--restore", "--yes"], { env: ENV, ...account });
  assert.equal(restore.code, 1);
  assert.match(restore.stderr, /fixture was archived .*nothing to restore/u);

  account.state.log.length = 0;
  account.fetch.requests.length = 0;
  const rerun = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(rerun.code, 0, rerun.stderr);
  assert.match(
    rerun.stdout,
    new RegExp(
      `✓ Archive: r2://offboarded-clients/fixture/${today()}/ is verified and recorded`,
      "u",
    ),
  );
  assert.match(rerun.stdout, /✓ Ploi: the site fixture-cms\.example\.test is deleted/u);
  assert.match(rerun.stdout, /✓ Frontend: the Worker fixture-fe is deleted/u);
  assert.ok(
    !account.fetch.requests.some(({ method, url }) => method !== "GET" && isArchive(url)),
    "nothing is written to the archive again",
  );
  assert.deepEqual(snapshot(account.state.buckets["offboarded-clients"]), archived);
  assertLog(account.state.log, DELETIONS.slice(DELETIONS.indexOf("worker fixture-ci deleted")));
  const ops = await readOps(fixture);
  assert.equal(ops.offboarded.phase, "archived");
  assert.deepEqual(ops.offboarded.archive, recorded.offboarded.archive);
});

test("offboard --archive refuses to go on when the recorded archive's manifest changed", async () => {
  const { fixture, account } = await cutSite();
  const failing = intercepting(account, ({ method, url }) => {
    if (method === "DELETE" && url.endsWith("/workers/scripts/fixture-ci")) {
      return new Response(JSON.stringify({ success: false, errors: [{ message: "boom" }] }), {
        status: 500,
      });
    }
  });
  assert.equal(
    (
      await fixture.run(["offboard", "--archive", "--yes"], {
        env: ENV,
        fetch: failing,
        exec: account.exec,
      })
    ).code,
    1,
  );
  const key = `fixture/${today()}/manifest.json`;
  account.state.buckets["offboarded-clients"][key].body = Buffer.from("{}");
  account.state.log.length = 0;

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `r2://offboarded-clients/${key} doesn't match gq\\.ops\\.json offboarded\\.archive: stopping before anything else is deleted\\.`,
      "u",
    ),
  );
  assert.deepEqual(account.state.log, []);
});

test("offboard --archive once archived has nothing left to do and reads only the repository and the checkout", async () => {
  const { fixture, account } = await cutSite();
  assert.equal(
    (await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account })).code,
    0,
  );
  account.fetch.requests.length = 0;
  account.exec.calls.length = 0;
  account.state.log.length = 0;

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(
      `Nothing left to archive: fixture was archived to r2://offboarded-clients/fixture/${today()}/\\.`,
      "u",
    ),
  );
  assert.deepEqual(account.fetch.requests, []);
  assert.deepEqual(
    [...new Set(account.exec.calls.map(({ command }) => command))].sort(),
    ["gh", "git"],
    "no secret is read from Sigillo",
  );
  assert.deepEqual(account.state.log, [], "nothing changes");
  const restore = await fixture.run(["offboard", "--restore", "--yes"], { env: ENV, ...account });
  assert.equal(restore.code, 1);
  assert.match(restore.stderr, /fixture was archived .*nothing to restore/u);
});

// --- the record reaches git before the repository turns read-only ---------------

test("offboard --archive commits and pushes the archived record, then archives the repository", async () => {
  const { fixture, account } = await cutSite();

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(account.state.log.slice(-4), [
    "github hook 99 deleted",
    "gq.ops.json committed",
    "gq.ops.json pushed to origin/main",
    "github repo archived",
  ]);
  const pushed = JSON.parse(account.state.git.pushed);
  assert.equal(pushed.offboarded.phase, "archived");
  assert.deepEqual(pushed, await readOps(fixture), "what is pushed is the final record");
  assert.match(result.stdout, /Archived fixture\. gq\.ops\.json's record is pushed\./u);
});

for (const [why, checkout, reason] of [
  ["on another branch", { branch: "offboard" }, "the checkout is on offboard, not main"],
  [
    "with other changes",
    { changes: ["src/app.ts", "notes.txt"] },
    "the checkout has other changes (src/app.ts, notes.txt)",
  ],
  [
    "behind its remote",
    { behind: 2 },
    "origin/main has 2 commits this checkout lacks, so the push wouldn't be a fast-forward",
  ],
  [
    "whose remote is another repository",
    { url: "https://github.com/Example/fixture-old.git" },
    "origin is https://github.com/Example/fixture-old.git, not Example/fixture",
  ],
]) {
  test(`offboard --archive from a checkout ${why} leaves the push to the operator and the repository unarchived`, async () => {
    const { fixture, account } = await cutSite();
    Object.assign(account.state.git, checkout);

    const result = await fixture.run(["offboard", "--archive", "--yes"], {
      env: ENV,
      ...account,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(planLines(result.stdout).slice(-3), [
      '  - Record: offboarded.phase becomes "archived" in gq.ops.json',
      `  ! Git: commit gq.ops.json and push it to main yourself (${reason}), then run gq offboard --archive again to archive the repository Example/fixture`,
      "  ! Sigillo: the project PROJECT123 is kept, with the Site's secrets",
    ]);
    assert.equal(account.state.log.at(-1), "github hook 99 deleted");
    assert.equal(account.state.repository.archived, false);
    assert.equal(account.state.git.pushed, null);
    assert.equal((await readOps(fixture)).offboarded.phase, "archived");
    assert.match(
      result.stdout,
      /Archived fixture, but not its repository yet: push gq\.ops\.json to main, then run gq offboard --archive again\./u,
    );
    assert.match(result.stdout, /https:\/\/github\.com\/Example\/fixture \(not archived yet\)/u);
  });
}

test("once the operator pushes the record, a rerun archives the repository, and the next has nothing to do", async () => {
  const { fixture, account } = await cutSite();
  const { state } = account;
  state.git.branch = "offboard";
  assert.equal(
    (await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account })).code,
    0,
  );
  // The operator commits gq.ops.json on main and pushes it.
  const record = await readFile(fixture.path("gq.ops.json"), "utf8");
  Object.assign(state.git, { branch: "main", committed: record, pushed: record });
  state.log.length = 0;
  account.fetch.requests.length = 0;

  const rerun = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(rerun.code, 0, rerun.stderr);
  assert.deepEqual(planLines(rerun.stdout), [
    "  ✓ Git: gq.ops.json's archived record is pushed to origin/main",
    "  - GitHub: archive the repository Example/fixture (it stays readable)",
  ]);
  assert.deepEqual(state.log, ["github repo archived"]);
  assert.deepEqual(account.fetch.requests, [], "nothing but git and gh is called");
  assert.match(rerun.stdout, /Archived Example\/fixture: it is read-only now\./u);

  const again = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(planLines(again.stdout), [
    "  ✓ Git: gq.ops.json's archived record is pushed to origin/main",
    "  ✓ GitHub: the repository Example/fixture is archived",
  ]);
  assert.match(
    again.stdout,
    new RegExp(
      `Nothing left to archive: fixture was archived to r2://offboarded-clients/fixture/${today()}/\\.`,
      "u",
    ),
  );
  assert.deepEqual(state.log, ["github repo archived"]);
  assert.deepEqual(account.fetch.requests, []);
});

test("a rerun pushes a record committed but not pushed, then archives the repository", async () => {
  const { fixture, account } = await cutSite();
  const { state } = account;
  // The push is refused at first: the remote moved on while the run deleted.
  const exec = recordingExec(({ command, args, ...options }) =>
    command === "git" && args[0] === "push"
      ? { code: 1, stderr: " ! [rejected]        HEAD -> main (fetch first)\n" }
      : account.exec(command, args, options),
  );
  const first = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    fetch: account.fetch,
    exec,
  });
  assert.equal(first.code, 1);
  assert.equal(
    first.stderr,
    "gq: git push --quiet origin HEAD:refs/heads/main failed: ! [rejected]        HEAD -> main (fetch first). gq.ops.json records fixture as archived but isn't pushed, so Example/fixture isn't archived: push it to main, then run gq offboard --archive again.\n",
  );
  assert.equal(state.repository.archived, false);
  state.log.length = 0;

  const rerun = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(rerun.code, 0, rerun.stderr);
  assert.deepEqual(planLines(rerun.stdout), [
    "  - Git: commit gq.ops.json and push it to origin/main",
    "  - GitHub: archive the repository Example/fixture (it stays readable)",
  ]);
  assert.deepEqual(state.log, ["gq.ops.json pushed to origin/main", "github repo archived"]);
  assert.equal(JSON.parse(state.git.pushed).offboarded.phase, "archived");
});

test("a record never pushed to a repository archived since is left to the operator", async () => {
  const { fixture, account } = await cutSite();
  // Archived by hand, its webhook deleted first.
  account.state.hooks = account.state.hooks.filter(({ id }) => id !== 99);
  account.state.repository.archived = true;

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(planLines(result.stdout).slice(-3), [
    "  ! Git: gq.ops.json's archived record isn't pushed (it isn't committed or pushed yet), and Example/fixture is archived, so it takes no push: unarchive it (gh repo unarchive Example/fixture), push gq.ops.json to main, then archive it again",
    "  ✓ GitHub: the repository Example/fixture is archived",
    "  ! Sigillo: the project PROJECT123 is kept, with the Site's secrets",
  ]);
  assert.equal(account.state.git.pushed, null, "no push is tried");
});

// --- confirmation and configuration ---------------------------------------------

test("offboard --archive without a terminal or --yes shows the plan and changes nothing", async () => {
  const { fixture, account } = await cutSite();

  const result = await fixture.run(["offboard", "--archive"], { env: ENV, ...account });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /- Ploi: delete the site fixture-cms\.example\.test/u);
  assert.match(result.stderr, /Not a TTY: re-run with --yes to apply, or --dry-run to inspect\./u);
  assert.deepEqual(account.state.log, []);
});

test("in a terminal, offboard --archive goes on only once the project's name is typed back", async () => {
  const { fixture, account } = await cutSite();

  const wrong = await fixture.run(["offboard", "--archive"], {
    env: ENV,
    ...account,
    stdin: answering(["other-site\r"]),
    interactive: true,
  });
  assert.equal(wrong.code, 0, wrong.stderr);
  assert.match(wrong.stdout, /Type fixture to go on/u);
  assert.match(wrong.stdout, /Nothing changed\./u);
  assert.deepEqual(account.state.log, []);

  const stdin = answering(["fixture\r"]);
  const right = await fixture.run(["offboard", "--archive"], {
    env: ENV,
    ...account,
    stdin,
    interactive: true,
  });
  assert.equal(right.code, 0, right.stderr);
  assert.equal(stdin.prompts, 1);
  assert.equal((await readOps(fixture)).offboarded.phase, "archived");
});

test("offboard --archive names the gq.ops.json keys the archive needs", async () => {
  const { artifacts, ci, ...ops } = OPS;
  void artifacts;
  const fixture = await offboardingSite({
    ops: {
      ...ops,
      ci: { worker: ci.worker },
      offboarded: { at: "2026-10-01T09:00:00.000Z", phase: "cut" },
    },
  });

  const result = await fixture.run(["offboard", "--archive", "--dry-run"], { env: ENV });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /gq\.ops\.json ci\.backupBucket, artifacts\.namespace, artifacts\.repo are required to archive\./u,
  );
});

test("--restore and --archive can't be combined", async () => {
  const fixture = await offboardingSite();

  const result = await fixture.run(["offboard", "--restore", "--archive"], { env: ENV });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--restore and --archive can't be combined\./u);
});

test("an uploads.zip larger than one part goes up as a multipart upload", async () => {
  const { fixture, account } = await cutSite();
  const large = Buffer.alloc(17 * 1024 * 1024, 7);
  account.state.buckets["fixture-media"]["video/large.mp4"] = {
    body: large,
    lastModified: "2026-09-01T10:00:00.000Z",
  };
  account.state.buckets["fixture-media"]["empty.txt"] = {
    body: Buffer.alloc(0),
    lastModified: "2026-09-01T10:00:00.000Z",
  };

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  const zipKey = `/offboarded-clients/fixture/${today()}/uploads.zip`;
  const uploads = account.fetch.requests
    .filter(({ method, url }) => method !== "GET" && new URL(url).pathname === zipKey)
    .map(({ method, url }) => {
      const query = new URL(url).searchParams;
      return `${method} ${["uploads", "partNumber", "uploadId"].filter((name) => query.has(name)).join(",")}`;
    });
  assert.deepEqual(uploads, [
    "POST uploads",
    "PUT partNumber,uploadId",
    "PUT partNumber,uploadId",
    "POST uploadId",
  ]);
  const archived =
    account.state.buckets["offboarded-clients"][zipKey.slice("/offboarded-clients/".length)];
  const entries = readZip(archived.body);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.find(({ name }) => name === "video/large.mp4").body, large);
  assert.equal(entries.find(({ name }) => name === "empty.txt").body.length, 0);
});

// --- an Artifacts-only Site: its code archived from Artifacts ------------------

// An Artifacts-only Site (no github.repository, ADR 0012) phase 1 has cut.
const artifactsOnlySite = ({ state = {} } = {}) =>
  cutSite({ ops: ARTIFACTS_ONLY, state: { ...artifactsOnlyState(), ...state } });

const calledGitHub = (exec) => exec.calls.some(({ command }) => command === "gh");

test("an Artifacts-only Site's archive plans code.bundle and checks it, with nothing to push or archive on GitHub", async () => {
  const { fixture, account } = await artifactsOnlySite();

  const result = await fixture.run(["offboard", "--archive", "--dry-run"], {
    env: ENV,
    ...account,
  });

  assert.equal(result.code, 0, result.stderr);
  const prefix = `r2://offboarded-clients/fixture/${today()}/`;
  const plan = planLines(result.stdout);
  assert.deepEqual(plan.slice(4, 8), [
    `  - Archive: ${prefix}backups/ ← the 2 database backups in r2://fixture-releases/db/`,
    `  - Archive: ${prefix}code.bundle ← the 2 refs of the Artifacts repository fixture/fixture (a git bundle of every ref)`,
    `  - Archive: ${prefix}gq.ops.json, and manifest.json (each file's size and sha256, and the source resources)`,
    "  - Verify: re-read every archived file against manifest.json, count uploads.zip's entries against fixture-media, and read the Artifacts repository fixture/fixture's refs again against code.bundle's; nothing is deleted unless all match, then gq.ops.json records the archive",
  ]);
  assert.ok(plan.includes("  - Artifacts: delete the repository fixture/fixture"));
  assert.deepEqual(plan.slice(-4), [
    "  - Tokens: delete GETQUICK FIXTURE Artifacts",
    '  - Record: offboarded.phase becomes "archived" in gq.ops.json',
    "  ! Git: commit gq.ops.json's archived record in this checkout: fixture is Artifacts-only, so its repository, deleted above, takes no push (code.bundle keeps its code)",
    "  ! Sigillo: the project PROJECT123 is kept, with the Site's secrets",
  ]);
  assert.doesNotMatch(result.stdout, /GitHub/u);
  assert.deepEqual(account.state.log, []);
  assert.ok(!calledGitHub(account.exec));
  assert.ok(everyMintedTokenRevoked(account.state));
});

// Whether every git token the run minted (to read the repository) is
// revoked once used.
const everyMintedTokenRevoked = (state) => {
  const minted = state.artifactsTokens.filter(({ id }) => id.startsWith("git-minted-"));
  return minted.length > 0 && minted.every((token) => token.state === "revoked");
};

test("an Artifacts-only Site's archive keeps every ref in code.bundle, checked before its repository is deleted", async () => {
  const { fixture, account } = await artifactsOnlySite();
  const { state } = account;

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  const deletions = DELETIONS.filter(
    (entry) => typeof entry !== "string" || !/^(github |gq\.ops\.json )/u.test(entry),
  );
  deletions.splice(deletions.indexOf("token t-deploy deleted") + 1, 0, "token t-artifacts deleted");
  assertLog(state.log, [
    "bucket offboarded-clients created",
    "database backed up",
    "code bundled",
    ...deletions,
  ]);

  const prefix = `fixture/${today()}/`;
  const archived = state.buckets["offboarded-clients"];
  assert.equal(archived[`${prefix}code.bundle`].body.toString(), bundleOf(ARTIFACTS_REFS));
  const manifestBody = archived[`${prefix}manifest.json`].body;
  const manifest = JSON.parse(manifestBody);
  const bundle = manifest.files.find(({ path }) => path === "code.bundle");
  assert.equal(bundle.sha256, sha256(archived[`${prefix}code.bundle`].body));
  assert.deepEqual(manifest.sources.artifacts, {
    namespace: "fixture",
    repo: "fixture",
    refs: ARTIFACTS_REFS,
  });
  assert.equal(manifest.sources.github, null);

  // Cloned with read-only git tokens; the clone and the bundle are gone.
  const minted = state.artifactsTokens.filter(({ id }) => id.startsWith("git-minted-"));
  assert.ok(minted.length > 0 && minted.every(({ scope }) => scope === "read"));
  assert.ok(everyMintedTokenRevoked(state));
  await assert.rejects(access(state.cloned), { code: "ENOENT" });
  assert.ok(
    account.exec.calls.every(({ args }) => !args.some((arg) => /git-secret/u.test(arg))),
    "no git token in git's arguments",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /git-secret/u);
  assert.ok(!calledGitHub(account.exec));

  const ops = await readOps(fixture);
  assert.equal(ops.offboarded.phase, "archived");
  assert.equal(ops.offboarded.archive.manifestSha256, sha256(manifestBody));
  assert.match(
    result.stdout,
    new RegExp(
      `Code: {7}r2://offboarded-clients/${prefix}code\\.bundle \\(every ref of the Artifacts repository fixture/fixture, which is deleted\\)`,
      "u",
    ),
  );
  assert.match(result.stdout, /Commit gq\.ops\.json in this checkout/u);

  // A rerun has nothing to do, and reaches nothing.
  account.fetch.requests.length = 0;
  account.exec.calls.length = 0;
  state.log.length = 0;
  const again = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });
  assert.equal(again.code, 0, again.stderr);
  assert.match(
    again.stdout,
    new RegExp(
      `Nothing left to archive: fixture was archived to r2://offboarded-clients/${prefix}\\.`,
      "u",
    ),
  );
  assert.deepEqual(account.fetch.requests, []);
  assert.deepEqual(account.exec.calls, []);
  assert.deepEqual(state.log, []);
});

test("a push to the Artifacts repository after code.bundle was made stops the archive before anything is deleted", async () => {
  const { fixture, account } = await artifactsOnlySite();
  const exec = recordingExec(async (call) => {
    const result = await account.exec(call.command, call.args, call);
    if (call.args[0] === "bundle" && call.args[1] === "create") {
      account.state.artifactsRefs["refs/heads/main"] = "a".repeat(40);
    }
    return result;
  });

  const result = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    fetch: account.fetch,
    exec,
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /failed verification: the Artifacts repository fixture\/fixture's refs differ from code\.bundle's \(refs\/heads\/main\)\. Nothing was deleted\./u,
  );
  assert.deepEqual(account.state.log, [
    "bucket offboarded-clients created",
    "database backed up",
    "code bundled",
  ]);
  assert.equal((await readOps(fixture)).offboarded.archive, undefined);
});

test("an Artifacts-only Site whose Artifacts repository is gone, with no archive recorded, isn't archived", async () => {
  const { fixture, account } = await artifactsOnlySite();
  account.state.artifacts = account.state.artifacts.filter(({ name }) => name !== "fixture");

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /the Artifacts repository fixture\/fixture is already gone, but gq\.ops\.json records no archive/u,
  );
  assert.deepEqual(account.state.log, []);
});

test("an Artifacts-only Site whose repository has no refs has no code to bundle", async () => {
  const { fixture, account } = await artifactsOnlySite({ state: { artifactsRefs: {} } });

  const result = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /✓ Archive: the Artifacts repository fixture\/fixture has no refs: there is no code to archive/u,
  );
  assert.ok(!account.state.log.includes("code bundled"));
  const prefix = `fixture/${today()}/`;
  const archived = account.state.buckets["offboarded-clients"];
  assert.equal(archived[`${prefix}code.bundle`], undefined);
  const manifest = JSON.parse(archived[`${prefix}manifest.json`].body);
  assert.deepEqual(manifest.sources.artifacts.refs, {});
  assert.ok(account.state.log.includes("artifacts repo fixture/fixture deleted"));
  assert.match(
    result.stdout,
    /Code: {7}none \(the Artifacts repository fixture\/fixture had no refs, so no bundle was created\)/u,
  );
  assert.doesNotMatch(result.stdout, /Code:.*code\.bundle/u);
});

for (const empty of [true, false]) {
  for (const repositoryDeleted of [true, false]) {
    test(`a resumed ${empty ? "empty" : "nonempty"} Artifacts archive reports its actual code with the repository ${repositoryDeleted ? "deleted" : "still present"}`, async () => {
      const { fixture, account } = await artifactsOnlySite({
        state: { artifactsRefs: empty ? {} : ARTIFACTS_REFS },
      });
      const failing = intercepting(account, ({ method, url }) => {
        if (
          method === "DELETE" &&
          (repositoryDeleted
            ? url.includes("/dns_records/")
            : url.endsWith("/artifacts/namespaces/fixture/repos/fixture"))
        ) {
          return new Response(JSON.stringify({ success: false, errors: [{ message: "busy" }] }), {
            status: 500,
          });
        }
      });
      const failed = await fixture.run(["offboard", "--archive", "--yes"], {
        env: ENV,
        fetch: failing,
        exec: account.exec,
      });
      assert.equal(failed.code, 1, failed.stdout);
      const recorded = (await readOps(fixture)).offboarded.archive;
      assert.ok(recorded, "the archive is recorded before deletion fails");
      assert.equal(
        account.state.log.includes("artifacts repo fixture/fixture deleted"),
        repositoryDeleted,
      );
      const archived = snapshot(account.state.buckets["offboarded-clients"]);
      account.fetch.requests.length = 0;

      const resumed = await fixture.run(["offboard", "--archive", "--yes"], {
        env: ENV,
        ...account,
      });

      assert.equal(resumed.code, 0, resumed.stderr);
      if (empty) {
        assert.match(
          resumed.stdout,
          /Code: {7}none \(the Artifacts repository fixture\/fixture had no refs, so no bundle was created\)/u,
        );
        assert.doesNotMatch(resumed.stdout, /Code:.*code\.bundle/u);
      } else {
        assert.ok(
          resumed.stdout.includes(
            `Code:       r2://${recorded.bucket}/${recorded.prefix}code.bundle (every ref of the Artifacts repository fixture/fixture, which is deleted)`,
          ),
          resumed.stdout,
        );
      }
      assert.deepEqual(snapshot(account.state.buckets["offboarded-clients"]), archived);
      assert.deepEqual((await readOps(fixture)).offboarded.archive, recorded);
      assert.ok(
        !account.fetch.requests.some(({ method, url }) => method !== "GET" && isArchive(url)),
        "nothing is written to the archive again",
      );
      assert.ok(!calledGitHub(account.exec));
    });
  }
}

test("a resumed archive deletes the Artifacts repository only while its refs are still the recorded code.bundle's", async () => {
  const { fixture, account } = await artifactsOnlySite();
  let refused = false;
  // The run stops at the repository's deletion, once the archive is recorded.
  const fetch = recordingFetch((request) => {
    if (
      !refused &&
      request.method === "DELETE" &&
      request.url.endsWith("/artifacts/namespaces/fixture/repos/fixture")
    ) {
      refused = true;
      return new Response(JSON.stringify({ success: false, errors: [{ message: "busy" }] }), {
        status: 500,
      });
    }
    return account.fetch(request.url, request);
  });
  const failed = await fixture.run(["offboard", "--archive", "--yes"], {
    env: ENV,
    fetch,
    exec: account.exec,
  });
  assert.equal(failed.code, 1);
  assert.ok((await readOps(fixture)).offboarded.archive, "the archive is recorded");

  account.state.artifactsRefs["refs/heads/hotfix"] = "b".repeat(40);
  account.state.log.length = 0;
  const changed = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });

  assert.equal(changed.code, 1);
  assert.match(
    changed.stderr,
    /The Artifacts repository fixture\/fixture's refs differ from those r2:\/\/offboarded-clients\/fixture\/[\d-]+\/manifest\.json records for code\.bundle \(refs\/heads\/hotfix\): stopping before anything else is deleted\./u,
  );
  assert.deepEqual(account.state.log, []);

  delete account.state.artifactsRefs["refs/heads/hotfix"];
  const resumed = await fixture.run(["offboard", "--archive", "--yes"], { env: ENV, ...account });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.ok(account.state.log.includes("artifacts repo fixture/fixture deleted"));
});
