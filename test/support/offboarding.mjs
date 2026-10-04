// An exposed Site for the offboarding commands at the run() seam: a fixture
// site with every block `gq offboard` reads, and one in-memory account behind
// a recording fetch (Cloudflare, R2's S3 API and Ploi) and a recording exec
// (Sigillo, gh and git). `state` holds what each provider would report, and
// `state.log` every change in the order it was made, so a test can tell what
// was cut, restored, archived or deleted, and when. Nothing here reaches the
// network or a real account.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { crc32 } from "node:zlib";

import { createFixtureSite, json, recordingExec, recordingFetch } from "./fixture-site.mjs";

export const OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  sigillo: {
    apiUrl: "https://secrets.example.test",
    projectId: "PROJECT123",
    environments: { operations: "ops", staging: "stage" },
  },
  domains: { admin: "fixture-cms.example.test", frontend: "fixture-fe.example.test" },
  ploi: { serverId: "12", siteId: "34", systemUser: "fixture", database: "fixture_db" },
  releases: { bucket: "fixture-releases", prefix: "admin/" },
  backups: { bucket: "fixture-releases", prefix: "db/" },
  media: { bucket: "fixture-media", domain: "fixture-media.example.test" },
  artifacts: { namespace: "fixture", repo: "fixture" },
  ci: { worker: "fixture-ci", backupBucket: "fixture-ci-backups" },
  cloudflare: { accountId: "account-1", zoneId: "zone-1", zoneName: "example.test" },
  github: { repository: "Example/fixture" },
});

// What `gq sigillo run operations` injects: only the token-manager token.
export const ENV = Object.freeze({ CLOUDFLARE_TOKEN_MANAGER_API_TOKEN: "manager-secret" });

// What Sigillo staging holds for the Ploi and R2 calls.
export const STAGING = Object.freeze({
  PLOI_API_TOKEN: "ploi-secret",
  R2_ACCESS_KEY_ID: "r2-key",
  R2_SECRET_ACCESS_KEY: "r2-secret",
});

const SIGILLO_BIN = "node_modules/.bin/sigillo";
export const WEBHOOK_URL = "https://fixture-ci.fixture-sub.workers.dev/github/webhook";
export const RETRY_CRONTAB = Object.freeze({
  user: "fixture",
  frequency: "* * * * *",
  command:
    'cd /home/fixture/fixture-cms.example.test/apps/cms && PATH="/usr/local/bin:$PATH" wp gq-events retry-due --quiet',
});

// What the live database dumps to, and the D1 store exports.
export const DUMP = "dump";
export const PUBLICATIONS_SQL =
  "CREATE TABLE publications (id TEXT);\nINSERT INTO publications VALUES ('home');\n";
export const HEAD_COMMIT = "0123456789abcdef0123456789abcdef01234567";

// An Artifacts-only Site (ADR 0012): no github.repository, its code in its
// Artifacts repository, and the "GETQUICK FIXTURE Artifacts" token that
// mints git tokens for it besides the other project tokens.
export const ARTIFACTS_ONLY = Object.freeze(
  Object.fromEntries(Object.entries(OPS).filter(([key]) => key !== "github")),
);
export const ARTIFACTS_REMOTE =
  "https://account-1.artifacts.cloudflare.net/git/fixture/fixture.git";
export const ARTIFACTS_REFS = Object.freeze({
  "refs/heads/main": HEAD_COMMIT,
  "refs/tags/v1.0.0": "fedcba9876543210fedcba9876543210fedcba98",
});
export function artifactsOnlyState() {
  const { tokens } = exposedState();
  return { tokens: [...tokens, projectToken("t-artifacts", "Artifacts")] };
}

// What `git bundle create` writes for `refs`: the bundle's header (its refs),
// then a stand-in for the pack.
export function bundleOf(refs) {
  const heads = Object.entries(refs).map(([ref, sha]) => `${sha} ${ref}\n`);
  return `# v2 git bundle\n${heads.join("")}\nPACK ${Object.keys(refs).length}\n`;
}

// Synced with this blueprint, as `gq offboard` requires of the deploy files.
export async function offboardingSite({ ops = OPS } = {}) {
  const fixture = await createFixtureSite({
    ops,
    files: {
      "package.json": `${JSON.stringify({ devDependencies: { sigillo: "0.13.0" } })}\n`,
      [SIGILLO_BIN]: "#!/bin/sh\n",
    },
  });
  const synced = await fixture.run(["sync"]);
  assert.equal(synced.code, 0, synced.stderr);
  return fixture;
}

const PERMISSION_GROUPS = [
  "Workers Scripts Read",
  "Workers Scripts Write",
  "Workers Routes Write",
  "Workers R2 Storage Write",
  "Workers R2 Storage Bucket Item Read",
  "Workers R2 Storage Bucket Item Write",
  "D1 Read",
  "D1 Write",
  "Workers Containers Read",
  "Workers Containers Write",
  "Artifacts Read",
  "Artifacts Write",
  "Zone Read",
  "DNS Write",
].map((name, index) => ({ id: `group-${index}`, name }));

const projectToken = (id, purpose) => ({
  id,
  name: `GETQUICK FIXTURE ${purpose}`,
  status: "active",
  policies: [{ effect: "allow", resources: {}, permission_groups: [{ id: "g", name: "Some" }] }],
});

// Other clients' tokens enough to fill the first page of a listing: the
// project's own come after them.
export const CROWDED_TOKENS = Object.freeze(
  Array.from({ length: 60 }, (_, index) => ({
    id: `client-${index}`,
    name: `GETQUICK CLIENT${index} Staging Alchemy`,
    status: "active",
    policies: [],
  })),
);

// Other hooks and crontabs enough to fill a first page: the Site's own come
// after them.
export const CROWDED_HOOKS = Object.freeze(
  Array.from({ length: 105 }, (_, index) => ({
    id: 1000 + index,
    active: true,
    config: { url: `https://hooks.example.test/${index}` },
  })),
);
export const CROWDED_CRONTABS = Object.freeze(
  Array.from({ length: 55 }, (_, index) => ({
    id: 1000 + index,
    user: "other",
    frequency: "0 * * * *",
    command: `job ${index}`,
  })),
);

const object = (body, lastModified = "2026-09-01T10:00:00.000Z") => ({
  body: Buffer.from(body),
  lastModified,
});

// A Frontend stage Worker's binding to its publication store `uuid`.
export const publicationBinding = (uuid) => [
  { type: "d1", name: "PUBLICATION_DB", database_id: uuid },
];

// A Site with everything still exposed, unless `overrides` says otherwise.
export function exposedState() {
  return {
    tokens: [
      { id: "manager", name: "GETQUICK token manager", status: "active", policies: [] },
      projectToken("t-alchemy", "Staging Alchemy"),
      projectToken("t-releases", "Releases R2"),
      projectToken("t-media", "Media R2"),
      projectToken("t-deploy", "CI Deploy"),
      { id: "other", name: "GETQUICK OTHER Staging Alchemy", status: "active", policies: [] },
    ],
    workerDomains: [
      {
        id: "wd-1",
        hostname: "fixture-fe.example.test",
        service: "fixture-fe",
        zone_id: "zone-1",
        environment: "production",
      },
      {
        id: "wd-other",
        hostname: "other-fe.example.test",
        service: "other-fe",
        zone_id: "zone-1",
        environment: "production",
      },
    ],
    subdomains: {
      "fixture-fe": { enabled: false, previews_enabled: true },
      "fixture-ci": { enabled: true, previews_enabled: false },
    },
    bucketDomains: {
      "fixture-media": [{ domain: "fixture-media.example.test", enabled: true }],
    },
    site: {
      id: 34,
      domain: "fixture-cms.example.test",
      status: "active",
      system_user: "fixture",
    },
    // The site's .env, as Ploi hands it out.
    siteEnv: "WP_ENV=production\nDB_NAME=fixture_db\nDB_USER=fixture\n",
    // The server's other sites, besides `site`.
    otherSites: [{ id: 35, domain: "other-cms.example.test", system_user: "other" }],
    crontabs: [
      { id: 7, ...RETRY_CRONTAB },
      { id: 8, user: "fixture", frequency: "0 3 * * *", command: "other job" },
    ],
    hooks: [
      { id: 99, active: true, config: { url: WEBHOOK_URL } },
      { id: 100, active: true, config: { url: "https://elsewhere.example.test/hook" } },
    ],
    scripts: [],
    staging: { ...STAGING },
    // What the archive (phase 2) reads and deletes.
    workers: ["fixture-fe", "fixture-ci", "other-fe"],
    // Each Worker's bindings (its settings), by name.
    bindings: {},
    // Names the account's listings leave out (an exact lookup still finds
    // them), and whether its token listings come bare (20 at most, without
    // result_info).
    unlisted: [],
    bareListings: false,
    d1: [
      { uuid: "d1-fixture", name: "fixture-fe-publications" },
      { uuid: "d1-other", name: "other-fe-publications" },
    ],
    workflows: ["fixture-ci", "fixture-mirror", "other-ci"],
    containers: [
      { id: "c-fixture", name: "fixture-ci-cisandbox" },
      { id: "c-other", name: "other-ci-cisandbox" },
    ],
    buckets: {
      "fixture-media": {
        "2026/01/a.jpg": object("jpeg a"),
        "2026/02/b c.png": object("png b c", "2025-12-31T23:59:58.000Z"),
        "uploads/ünïcode.txt": object("text ü"),
      },
      "fixture-releases": {
        "admin/release-1.tar.gz": object("release 1"),
        "db/fixture_db/2026-09-30T10-00-00Z.sql.gz": object("old backup"),
      },
      "fixture-ci-backups": { "snapshots/1.tar": object("snapshot") },
      "other-media": { "x.jpg": object("someone else's") },
    },
    artifacts: [
      { namespace: "fixture", name: "fixture" },
      { namespace: "other", name: "other" },
    ],
    dnsRecords: [
      { id: "r-cms", type: "A", name: "fixture-cms.example.test", content: "203.0.113.10" },
      { id: "r-fe", type: "AAAA", name: "fixture-fe.example.test", content: "100::" },
      {
        id: "r-media",
        type: "CNAME",
        name: "fixture-media.example.test",
        content: "public.r2.dev",
      },
      { id: "r-other", type: "A", name: "other-cms.example.test", content: "203.0.113.11" },
      { id: "r-sub", type: "A", name: "x.fixture-cms.example.test", content: "203.0.113.12" },
      { id: "r-apex", type: "A", name: "example.test", content: "203.0.113.1" },
    ],
    databases: [
      { id: 56, name: "fixture_db" },
      { id: 57, name: "other_db" },
    ],
    systemUsers: [
      { id: 78, name: "fixture" },
      { id: 79, name: "other" },
    ],
    // Ploi deletes a site in the background: for how many reads of it the
    // deleted site still shows (in its listing too), and how many times a
    // system user's deletion is refused (422) besides while a site runs as it.
    siteLingers: 0,
    systemUserRefusals: 0,
    repository: { archived: false, head: HEAD_COMMIT, defaultBranch: "main" },
    // The Artifacts repositories' git tokens (minted ones too, with their
    // plaintext) and the Site's repository's refs.
    artifactsTokens: [
      { id: "git-1", repo: "fixture", scope: "write", state: "active" },
      { id: "git-2", repo: "fixture", scope: "read", state: "expired" },
      { id: "git-other", repo: "other", scope: "write", state: "active" },
    ],
    artifactsRefs: { ...ARTIFACTS_REFS },
    // The operator's checkout: its branch and that branch's remote, the
    // paths changed besides gq.ops.json, how many commits the remote branch
    // and the checkout each have that the other lacks, and gq.ops.json as
    // last committed (null: not since the cut) and as pushed.
    git: {
      branch: "main",
      remote: "origin",
      url: "git@github.com:Example/fixture.git",
      changes: [],
      behind: 0,
      ahead: 0,
      committed: null,
      pushed: null,
    },
    // The bucket Sigillo staging's R2 key belongs to: the backups bucket.
    stagingBucket: "fixture-releases",
    log: [],
  };
}

const DUMP_SHA = createHash("sha256").update(DUMP).digest("hex");
const ACCOUNT = "/client/v4/accounts/account-1";
const ZONE = "/client/v4/zones/zone-1";

// The R2 resource a bucket-scoped token's policy names.
const bucketResource = (bucket) => `com.cloudflare.edge.r2.bucket.account-1_default_${bucket}`;

// `state` is exposedState() with `overrides` applied. Every Cloudflare call
// under the account checks its bearer token: tokens are managed with the
// manager token, everything else with a temporary token. Every R2 (S3) call
// checks that its key belongs to a live token scoped to that bucket.
export function fakeAccount(overrides = {}) {
  const state = { ...exposedState(), ...overrides };
  let next = 1;
  const temporary = new Map();
  const uploads = new Map();

  const fetch = recordingFetch(({ method, url, body, headers }) => {
    const { hostname, pathname, search } = new URL(url);
    if (hostname === "ploi.io") {
      const data = body === undefined ? undefined : JSON.parse(body);
      return ploi(method, pathname.replace("/api/servers/12", ""), data, new URL(url).searchParams);
    }
    if (hostname === "account-1.r2.cloudflarestorage.com") return s3(method, url, headers, body);
    if (hostname === "d1-export.example.test") {
      const id = pathname.slice(1);
      return new Response(state.d1Exports?.[id] ?? PUBLICATIONS_SQL);
    }

    const data = body === undefined ? undefined : JSON.parse(body);
    const bearer = headers.Authorization.replace("Bearer ", "");
    const ok = (result) => ({ success: true, result });
    const notFound = () =>
      json({ success: false, errors: [{ code: 10000, message: "not found" }] }, 404);

    if (pathname.startsWith(ZONE)) {
      assert.ok(temporary.has(bearer), `${method} ${pathname} uses the temporary token`);
      const path = `${pathname.slice(ZONE.length)}${search}`;
      if (method === "GET" && path === "") return ok({ id: "zone-1", name: "example.test" });
      const name = /^\/dns_records\?name=(.+)$/u.exec(path)?.[1];
      if (method === "GET" && name) {
        return ok(state.dnsRecords.filter((record) => record.name === decodeURIComponent(name)));
      }
      const record = /^\/dns_records\/([^/?]+)$/u.exec(path)?.[1];
      if (method === "DELETE" && record) {
        if (!state.dnsRecords.some(({ id }) => id === record)) return notFound();
        state.dnsRecords = state.dnsRecords.filter(({ id }) => id !== record);
        state.log.push(`dns record ${record} deleted`);
        return ok({ id: record });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }

    assert.ok(pathname.startsWith(ACCOUNT), `outside the account: ${url}`);
    const path = `${pathname.slice(ACCOUNT.length)}${search}`;

    if (path.startsWith("/tokens")) {
      assert.equal(bearer, "manager-secret", `${method} ${path} uses the manager token`);
      const tokenPage = /^\/tokens\?(.*)$/u.exec(path)?.[1];
      if (method === "GET" && tokenPage) {
        return paged(state.tokens, new URLSearchParams(tokenPage), state.bareListings);
      }
      if (method === "GET" && path === "/tokens/verify") return ok({ id: "manager" });
      if (method === "GET" && path === "/tokens/permission_groups") return ok(PERMISSION_GROUPS);
      if (method === "POST" && path === "/tokens") {
        const token = {
          id: `temp-${next}`,
          value: `temp-value-${next}`,
          status: "active",
          ...data,
        };
        next += 1;
        temporary.set(token.value, token);
        state.tokens.push(token);
        return ok(token);
      }
      const id = /^\/tokens\/([^/]+)$/u.exec(path)?.[1];
      const token = state.tokens.find((candidate) => candidate.id === id);
      if (method === "PUT" && token) {
        assert.equal(data.name, token.name, "an update keeps the token's name");
        assert.deepEqual(data.policies, token.policies, "an update keeps its policies");
        token.status = data.status;
        state.log.push(`token ${id} ${data.status}`);
        return ok(token);
      }
      if (method === "DELETE" && token) {
        state.tokens = state.tokens.filter((candidate) => candidate.id !== id);
        if (temporary.has(token.value)) temporary.delete(token.value);
        else state.log.push(`token ${id} deleted`);
        return ok({});
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }

    assert.ok(temporary.has(bearer), `${method} ${path} uses the temporary token`);
    if (method === "GET" && path === "/workers/subdomain") return ok({ subdomain: "fixture-sub" });
    const service = /^\/workers\/domains\?service=(.+)$/u.exec(path)?.[1];
    if (method === "GET" && service) {
      return ok(state.workerDomains.filter((domain) => domain.service === service));
    }
    const domainId = /^\/workers\/domains\/(.+)$/u.exec(path)?.[1];
    if (method === "DELETE" && domainId) {
      state.workerDomains = state.workerDomains.filter((domain) => domain.id !== domainId);
      state.log.push(`worker domain ${domainId} detached`);
      return ok(null);
    }
    if (method === "PUT" && path === "/workers/domains") {
      const domain = { id: `wd-${next}`, ...data };
      next += 1;
      state.workerDomains.push(domain);
      state.log.push(`worker domain ${data.hostname} attached to ${data.service}`);
      return ok(domain);
    }
    const script = /^\/workers\/scripts\/([^/]+)\/subdomain$/u.exec(path)?.[1];
    if (script && state.subdomains[script]) {
      if (method === "GET") return ok(state.subdomains[script]);
      if (method === "POST") {
        state.subdomains[script] = { ...state.subdomains[script], ...data };
        state.log.push(`workers.dev ${script} ${JSON.stringify(data)}`);
        return ok(state.subdomains[script]);
      }
    }
    const settings = /^\/workers\/scripts\/([^/?]+)\/settings$/u.exec(path)?.[1];
    if (method === "GET" && settings) {
      if (!state.workers.includes(settings)) return notFound();
      return ok({ bindings: state.bindings[settings] ?? [] });
    }
    // Cloudflare lists every Worker at once, whatever page is asked for,
    // without result_info.
    if (method === "GET" && /^\/workers\/scripts(?:\?.*)?$/u.test(path)) {
      return ok(listed(state.workers).map((name) => ({ id: name })));
    }
    const worker = /^\/workers\/scripts\/([^/?]+)$/u.exec(path)?.[1];
    if (method === "DELETE" && worker) {
      if (!state.workers.includes(worker)) return notFound();
      state.workers = state.workers.filter((name) => name !== worker);
      state.log.push(`worker ${worker} deleted`);
      return ok(null);
    }
    const d1Query = /^\/d1\/database\?(.+)$/u.exec(path)?.[1];
    if (method === "GET" && d1Query) {
      const query = new URLSearchParams(d1Query);
      return paged(
        state.d1.filter(({ name }) => name.includes(query.get("name"))),
        query,
      );
    }
    const d1Export = /^\/d1\/database\/([^/]+)\/export$/u.exec(path)?.[1];
    if (method === "POST" && d1Export && state.d1.some(({ uuid }) => uuid === d1Export)) {
      assert.equal(data.output_format, "polling");
      return ok({
        at_bookmark: "bookmark-1",
        status: "complete",
        result: {
          filename: `${d1Export}.sql`,
          signed_url: `https://d1-export.example.test/${d1Export}`,
        },
      });
    }
    const d1 = /^\/d1\/database\/([^/]+)$/u.exec(path)?.[1];
    if (method === "DELETE" && d1) {
      if (!state.d1.some(({ uuid }) => uuid === d1)) return notFound();
      state.d1 = state.d1.filter(({ uuid }) => uuid !== d1);
      state.log.push(`d1 ${d1} deleted`);
      return ok(null);
    }
    const workflow = /^\/workflows\/([^/?]+)$/u.exec(path)?.[1];
    if (method === "GET" && workflow) {
      return state.workflows.includes(workflow) ? ok({ name: workflow }) : notFound();
    }
    if (method === "DELETE" && workflow) {
      if (!state.workflows.includes(workflow)) return notFound();
      state.workflows = state.workflows.filter((name) => name !== workflow);
      state.log.push(`workflow ${workflow} deleted`);
      return ok(null);
    }
    const containerPage = /^\/containers\/applications(?:\?(.*))?$/u.exec(path);
    if (method === "GET" && containerPage) {
      const containers = state.containers.filter(({ name }) => !state.unlisted.includes(name));
      return paged(containers, new URLSearchParams(containerPage[1] ?? ""));
    }
    const container = /^\/containers\/applications\/([^/]+)$/u.exec(path)?.[1];
    if (method === "DELETE" && container) {
      state.containers = state.containers.filter(({ id }) => id !== container);
      state.log.push(`container application ${container} deleted`);
      return ok(null);
    }
    if (method === "POST" && path === "/r2/buckets") {
      assert.equal(state.buckets[data.name], undefined, "the bucket is created once");
      state.buckets[data.name] = {};
      state.log.push(`bucket ${data.name} created`);
      return ok({ name: data.name });
    }
    const bucket = /^\/r2\/buckets\/([^/?]+)$/u.exec(path)?.[1];
    if (method === "GET" && bucket)
      return state.buckets[bucket] ? ok({ name: bucket }) : notFound();
    if (method === "DELETE" && bucket) {
      if (!state.buckets[bucket]) return notFound();
      if (Object.keys(state.buckets[bucket]).length > 0) {
        return json({ success: false, errors: [{ message: "The bucket is not empty" }] }, 409);
      }
      delete state.buckets[bucket];
      state.log.push(`bucket ${bucket} deleted`);
      return ok(null);
    }
    const custom = /^\/r2\/buckets\/([^/]+)\/domains\/custom(?:\/(.+))?$/u.exec(path);
    if (custom) {
      const list = state.bucketDomains[custom[1]] ?? [];
      if (method === "GET") return ok({ domains: list });
      const domain = list.find((entry) => entry.domain === custom[2]);
      if (method === "PUT" && domain) {
        domain.enabled = data.enabled;
        state.log.push(`media domain ${custom[2]} ${data.enabled ? "enabled" : "disabled"}`);
        return ok(domain);
      }
      if (method === "DELETE" && domain) {
        state.bucketDomains[custom[1]] = list.filter((entry) => entry !== domain);
        state.log.push(`media domain ${custom[2]} removed`);
        return ok(null);
      }
    }
    const gitTokens = /^\/artifacts\/namespaces\/fixture\/repos\/([^/]+)\/tokens\?(.+)$/u.exec(
      path,
    );
    if (method === "GET" && gitTokens) {
      if (
        !state.artifacts.some(
          ({ namespace, name }) => namespace === "fixture" && name === gitTokens[1],
        )
      ) {
        return notFound();
      }
      const query = new URLSearchParams(gitTokens[2]);
      const wanted = query.get("state") ?? "active";
      return paged(
        state.artifactsTokens
          .filter(({ repo, state: status }) => repo === gitTokens[1] && status === wanted)
          // A listing never hands out a token's plaintext.
          .map((token) => ({ ...token, plaintext: undefined })),
        query,
      );
    }
    if (method === "POST" && path === "/artifacts/namespaces/fixture/tokens") {
      const token = {
        id: `git-minted-${next}`,
        repo: data.repo,
        scope: data.scope,
        state: "active",
        plaintext: `git-secret-${next}`,
      };
      next += 1;
      state.artifactsTokens.push(token);
      return ok({ id: token.id, plaintext: token.plaintext });
    }
    const revoked = /^\/artifacts\/namespaces\/fixture\/tokens\/([^/]+)$/u.exec(path)?.[1];
    if (method === "DELETE" && revoked) {
      const token = state.artifactsTokens.find(({ id }) => id === revoked);
      if (!token) return notFound();
      token.state = "revoked";
      // Those gq mints for a run are its own, like its temporary tokens.
      if (!token.plaintext) state.log.push(`artifacts token ${revoked} revoked`);
      return ok({ id: revoked });
    }
    const repo = /^\/artifacts\/namespaces\/([^/]+)\/repos\/([^/]+)$/u.exec(path);
    if (repo) {
      const found = state.artifacts.find(
        ({ namespace, name }) => namespace === repo[1] && name === repo[2],
      );
      if (!found) return notFound();
      if (method === "GET") return ok(found);
      if (method === "DELETE") {
        state.artifacts = state.artifacts.filter((entry) => entry !== found);
        state.log.push(`artifacts repo ${repo[1]}/${repo[2]} deleted`);
        return ok(null);
      }
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });

  // What a listing shows of `names`.
  function listed(names) {
    return names.filter((name) => !state.unlisted.includes(name));
  }

  // R2's S3 API: a key reaches a bucket only through a live token scoped to
  // it (Sigillo staging's R2 key is `state.stagingBucket`'s own).
  function s3(method, url, headers, body) {
    const { pathname, searchParams } = new URL(url);
    const [, bucket, ...segments] = pathname.split("/");
    const key = segments.map(decodeURIComponent).join("/");
    const credential =
      searchParams.get("X-Amz-Credential") ??
      /Credential=([^,]+)/u.exec(headers.authorization ?? headers.Authorization ?? "")?.[1];
    const accessKey = credential?.split("/")[0];
    const scoped =
      accessKey === STAGING.R2_ACCESS_KEY_ID
        ? bucket === state.stagingBucket
        : state.tokens.some(
            (token) =>
              token.id === accessKey &&
              token.status === "active" &&
              token.policies?.some((policy) => bucketResource(bucket) in policy.resources),
          );
    assert.ok(scoped, `${method} ${bucket}/${key} uses a key scoped to ${bucket}`);
    const objects = state.buckets[bucket];
    if (!objects) return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });

    if (method === "GET" && key === "" && searchParams.get("list-type") === "2") {
      return listObjects(objects, searchParams);
    }
    if (method === "POST" && searchParams.has("uploads")) {
      const id = `upload-${next}`;
      next += 1;
      uploads.set(id, { bucket, key, parts: new Map() });
      return xml(
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    const uploadId = searchParams.get("uploadId");
    if (uploadId) {
      const upload = uploads.get(uploadId);
      assert.ok(upload && upload.bucket === bucket && upload.key === key, "a known upload");
      if (method === "PUT") {
        const number = Number(searchParams.get("partNumber"));
        upload.parts.set(number, Buffer.from(body));
        return new Response(null, { status: 200, headers: { ETag: `"etag-${number}"` } });
      }
      if (method === "POST") {
        const numbers = [...String(body).matchAll(/<PartNumber>(\d+)<\/PartNumber>/gu)].map(
          (match) => Number(match[1]),
        );
        assert.deepEqual(
          numbers,
          [...upload.parts.keys()].sort((a, b) => a - b),
          "every part is completed, in order",
        );
        objects[key] = object(Buffer.concat(numbers.map((number) => upload.parts.get(number))));
        objects[key].lastModified = new Date().toISOString();
        uploads.delete(uploadId);
        return xml("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>");
      }
      if (method === "DELETE") {
        uploads.delete(uploadId);
        return new Response(null, { status: 204 });
      }
    }
    if (method === "PUT") {
      objects[key] = object(Buffer.from(body ?? ""));
      objects[key].lastModified = new Date().toISOString();
      return new Response(null, { status: 200 });
    }
    if (method === "GET" || method === "HEAD") {
      const found = objects[key];
      if (!found) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      return new Response(method === "HEAD" ? null : found.body, {
        status: 200,
        headers: { "content-length": String(found.body.length) },
      });
    }
    if (method === "DELETE") {
      if (objects[key]) state.log.push(`object ${bucket}/${key} deleted`);
      delete objects[key];
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }

  // One page of ListObjectsV2, at most max-keys long, continued by index.
  function listObjects(objects, query) {
    const prefix = query.get("prefix") ?? "";
    const keys = Object.keys(objects)
      .filter((key) => key.startsWith(prefix))
      .sort();
    const start = Number(query.get("continuation-token") ?? 0);
    const max = Number(query.get("max-keys") ?? 1000);
    const page = keys.slice(start, start + max);
    const truncated = start + max < keys.length;
    const contents = page
      .map(
        (key) =>
          `<Contents><Key>${escapeXml(key)}</Key><LastModified>${objects[key].lastModified}</LastModified><Size>${objects[key].body.length}</Size></Contents>`,
      )
      .join("");
    return xml(
      `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${
        truncated ? `<NextContinuationToken>${start + max}</NextContinuationToken>` : ""
      }</ListBucketResult>`,
    );
  }

  // Ploi lists a page at a time (at most 50), linking the next.
  function ploiPage(path, items, query) {
    const size = Math.min(Number(query.get("per_page") ?? 10), 50);
    const page = Number(query.get("page") ?? 1);
    const more = page * size < items.length;
    return {
      data: items.slice((page - 1) * size, page * size),
      links: {
        next: more
          ? `https://ploi.io/api/servers/12${path}?per_page=${size}&page=${page + 1}`
          : null,
      },
    };
  }

  function ploi(method, path, data, query) {
    const route = `${method} ${path}`;
    if (route === "GET /sites/34") {
      if (!state.site) return json({ message: "Not found" }, 404);
      const response = { data: state.site };
      if (state.site.status === "deleting") {
        state.siteLingers -= 1;
        if (state.siteLingers <= 0) {
          state.site = null;
          state.log.push("ploi site gone");
        }
      }
      return response;
    }
    if (route === "GET /sites/34/env") {
      return state.site ? { data: state.siteEnv } : json({ message: "Not found" }, 404);
    }
    if (route === "POST /sites/34/suspend") {
      state.site = { ...state.site, status: "suspended" };
      state.log.push(`ploi site suspended (${data.reason})`);
      return { data: state.site };
    }
    if (route === "POST /sites/34/resume") {
      state.site = { ...state.site, status: "active" };
      state.log.push("ploi site resumed");
      return { data: state.site };
    }
    if (route === "DELETE /sites/34") {
      state.site = state.siteLingers > 0 ? { ...state.site, status: "deleting" } : null;
      state.log.push("ploi site deleted");
      return {};
    }
    if (route === "GET /sites") {
      return ploiPage(path, [...(state.site ? [state.site] : []), ...state.otherSites], query);
    }
    if (route === "GET /crontabs") return ploiPage(path, state.crontabs, query);
    const crontab = /^DELETE \/crontabs\/(\d+)$/u.exec(route)?.[1];
    if (crontab) {
      state.crontabs = state.crontabs.filter((entry) => String(entry.id) !== crontab);
      state.log.push(`crontab ${crontab} deleted`);
      return {};
    }
    if (route === "POST /crontabs") {
      state.crontabs = [...state.crontabs, { id: 70, ...data }];
      state.log.push(`crontab added: ${data.command}`);
      return { data: state.crontabs.at(-1) };
    }
    if (route === "GET /databases") return ploiPage(path, state.databases, query);
    const database = /^DELETE \/databases\/(\d+)$/u.exec(route)?.[1];
    if (database) {
      state.databases = state.databases.filter(({ id }) => String(id) !== database);
      state.log.push(`ploi database ${database} deleted`);
      return {};
    }
    if (route === "GET /system-users") return ploiPage(path, state.systemUsers, query);
    const user = /^DELETE \/system-users\/(\d+)$/u.exec(route)?.[1];
    if (user) {
      const name = state.systemUsers.find(({ id }) => String(id) === user)?.name;
      const inUse = state.site?.system_user === name;
      if (inUse || state.systemUserRefusals > 0) {
        if (!inUse) state.systemUserRefusals -= 1;
        return json(
          {
            message: "The given data was invalid.",
            errors: { user: ["The system user still has sites."] },
          },
          422,
        );
      }
      state.systemUsers = state.systemUsers.filter(({ id }) => String(id) !== user);
      state.log.push(`ploi system user ${user} deleted`);
      return {};
    }
    if (route === "POST /scripts/run") {
      state.scripts.push(data);
      // The server dumps the database and uploads it through the presigned URL.
      const upload = /curl [^\n]* '([^']+)'/u.exec(data.content)?.[1];
      if (upload) s3("PUT", upload, {}, Buffer.from(DUMP));
      state.log.push("database backed up");
      return { data: { id: 9 } };
    }
    if (route === "GET /scripts/run/9") {
      return {
        data: {
          status: "finished",
          exit_code: 0,
          output: `FIXTURE_DB_EXPORT=success PREFIX=wp_ WORDPRESS=7.1.2 BYTES=${DUMP.length} SHA256=${DUMP_SHA}\n`,
        },
      };
    }
    throw new Error(`Unexpected request: ${route}`);
  }

  // Sigillo staging (read with `secrets get --raw`) and gh's REST calls.
  const exec = recordingExec(({ command, args, input, cwd, env }) => {
    if (command === "gh") return gh(args, input);
    if (command === "git" && ["ls-remote", "clone", "bundle"].includes(args[0])) {
      return artifactsGit(args, cwd, env);
    }
    if (command === "git") return git(args, cwd);
    assert.ok(command.endsWith(SIGILLO_BIN), `unexpected child: ${command}`);
    const environment = args[args.indexOf("--env") + 1];
    assert.equal(environment, "stage", "only staging is read through Sigillo");
    if (args[0] === "secrets" && args[1] === "get") {
      const value = state.staging[args[2]];
      return value === undefined
        ? { code: 1, stderr: `secret ${args[2]} not found` }
        : { stdout: `${value}\n` };
    }
    // The environment's secret names.
    if (args[0] === "secrets" && args[1].startsWith("-")) {
      return { stdout: `${Object.keys(state.staging).join("\n")}\n` };
    }
    return { code: 1, stderr: `unexpected sigillo ${args.join(" ")}` };
  });

  function gh(args, input) {
    if (args[0] === "repo" && args[1] === "archive") {
      assert.deepEqual(args, ["repo", "archive", "Example/fixture", "--yes"]);
      state.repository.archived = true;
      state.log.push("github repo archived");
      return {};
    }
    assert.equal(args[0], "api");
    const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
    const path = args.find((argument) => argument.startsWith("repos/"));
    if (method === "GET" && path === "repos/Example/fixture") {
      const { archived, defaultBranch } = state.repository;
      return { stdout: JSON.stringify({ archived, default_branch: defaultBranch }) };
    }
    if (method === "GET" && path === "repos/Example/fixture/commits/HEAD") {
      return { stdout: JSON.stringify({ sha: state.repository.head }) };
    }
    if (method === "GET" && path.startsWith("repos/Example/fixture/hooks?")) {
      return { stdout: hookPages(new URLSearchParams(path.split("?")[1]), args) };
    }
    const id = /^repos\/Example\/fixture\/hooks\/(\d+)$/u.exec(path)?.[1];
    const hook = state.hooks.find((candidate) => String(candidate.id) === id);
    if (state.repository.archived && method !== "GET") {
      return { code: 1, stderr: "HTTP 403: Repository was archived so is read-only." };
    }
    if (method === "PATCH" && hook) {
      const change = JSON.parse(input);
      Object.assign(hook, change);
      state.log.push(`github hook ${id} ${change.active ? "active" : "inactive"}`);
      return { stdout: JSON.stringify(hook) };
    }
    if (method === "DELETE" && hook) {
      state.hooks = state.hooks.filter((candidate) => candidate !== hook);
      state.log.push(`github hook ${id} deleted`);
      return { stdout: "" };
    }
    return { code: 1, stderr: `unexpected gh ${args.join(" ")}` };
  }

  // The checkout's git, run in the project root: what gq reads of it, and
  // gq.ops.json committed and pushed. A push is refused unless it is a
  // fast-forward to a repository that isn't archived.
  async function git(args, cwd) {
    const checkout = state.git;
    const config = () => readFile(join(cwd, "gq.ops.json"), "utf8");
    const command = args.join(" ");
    if (command === "rev-parse --abbrev-ref HEAD") return { stdout: `${checkout.branch}\n` };
    const tracked = /^config --get branch\.(.+)\.remote$/u.exec(command)?.[1];
    if (tracked) {
      return tracked === checkout.branch && checkout.remote
        ? { stdout: `${checkout.remote}\n` }
        : { code: 1 };
    }
    if (command === `remote get-url ${checkout.remote}`) return { stdout: `${checkout.url}\n` };
    if (args[0] === "fetch") return {};
    if (command === "status --porcelain --untracked-files=all -- :(top) :(exclude)gq.ops.json") {
      return { stdout: checkout.changes.map((path) => ` M ${path}\n`).join("") };
    }
    if (command === "status --porcelain -- gq.ops.json") {
      return { stdout: (await config()) === checkout.committed ? "" : " M gq.ops.json\n" };
    }
    if (command === `rev-list --left-right --count ${checkout.remote}/main...HEAD`) {
      return { stdout: `${checkout.behind}\t${checkout.ahead}\n` };
    }
    if (command === "add -- gq.ops.json") {
      checkout.staged = await config();
      return {};
    }
    if (args[0] === "commit" && args.at(-1) === "gq.ops.json") {
      assert.ok(checkout.staged !== undefined, "gq.ops.json is added first");
      checkout.committed = checkout.staged;
      checkout.ahead += 1;
      state.log.push("gq.ops.json committed");
      return {};
    }
    if (command === `push --quiet ${checkout.remote} HEAD:refs/heads/main`) {
      if (state.repository.archived) {
        return { code: 1, stderr: "ERROR: This repository was archived so it is read-only.\n" };
      }
      if (checkout.behind > 0) {
        return { code: 1, stderr: " ! [rejected]        HEAD -> main (non-fast-forward)\n" };
      }
      checkout.pushed = checkout.committed;
      checkout.ahead = 0;
      state.log.push(`gq.ops.json pushed to ${checkout.remote}/main`);
      return {};
    }
    return { code: 1, stderr: `unexpected git ${command}` };
  }

  // git against the Artifacts repository, which takes only a live git token
  // for it (sent as git's credential helper would, in an extra header from
  // the environment's config): its refs, a mirror clone (a directory holding
  // the refs it cloned), and bundles of a mirror.
  async function artifactsGit(args, cwd, env) {
    if (args[0] === "bundle") {
      const file = args.find((argument) => argument.endsWith(".bundle"));
      if (args[1] === "create") {
        assert.ok(args.includes("--all"), "the bundle holds every ref");
        const refs = JSON.parse(await readFile(join(cwd, "refs.json"), "utf8"));
        await writeFile(file, bundleOf(refs));
        state.log.push("code bundled");
        return {};
      }
      const bundle = await readFile(file, "utf8");
      if (args[1] === "verify") {
        return bundle.startsWith("# v2 git bundle\n") ? {} : { code: 1, stderr: "not a bundle" };
      }
      if (args[1] === "list-heads")
        return { stdout: bundle.split("\n\n")[0].split("\n").slice(1).join("\n") };
    }
    const config = {};
    for (let index = 0; index < Number(env?.GIT_CONFIG_COUNT ?? 0); index += 1) {
      config[env[`GIT_CONFIG_KEY_${index}`]] = env[`GIT_CONFIG_VALUE_${index}`];
    }
    assert.equal(config["credential.helper"], "", "no other credential helper answers");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0", "git never prompts");
    const password = Buffer.from(
      /^Authorization: Basic (.+)$/u.exec(config["http.extraHeader"] ?? "")?.[1] ?? "",
      "base64",
    )
      .toString()
      .replace(/^x:/u, "");
    const token = state.artifactsTokens.find((candidate) => candidate.plaintext === password);
    assert.ok(
      token?.state === "active" && token.repo === "fixture",
      "a live git token for fixture",
    );
    assert.ok(args.includes(ARTIFACTS_REMOTE), `git reaches ${ARTIFACTS_REMOTE}`);
    if (
      !state.artifacts.some(({ namespace, name }) => namespace === "fixture" && name === "fixture")
    ) {
      return { code: 128, stderr: "fatal: repository not found\n" };
    }
    const refs = Object.entries(state.artifactsRefs);
    if (args[0] === "ls-remote") {
      assert.ok(args.includes("--refs"), "only refs, no HEAD or peeled tags");
      return { stdout: refs.map(([ref, sha]) => `${sha}\t${ref}\n`).join("") };
    }
    assert.deepEqual(args.slice(0, 3), ["clone", "--mirror", "--quiet"]);
    const into = args.at(-1);
    await mkdir(into, { recursive: true });
    await writeFile(join(into, "refs.json"), JSON.stringify(state.artifactsRefs));
    state.cloned = into;
    return {};
  }

  // GitHub lists hooks a page at a time (30 unless asked, at most 100); gh
  // fetches the rest only with --paginate, and --slurp wraps the pages in
  // one array (otherwise it prints them one after another).
  function hookPages(query, args) {
    const size = Math.min(Number(query.get("per_page") ?? 30), 100);
    const pages = [];
    for (let start = 0; start === 0 || start < state.hooks.length; start += size) {
      pages.push(state.hooks.slice(start, start + size));
    }
    if (!args.includes("--paginate")) return JSON.stringify(pages[0]);
    if (args.includes("--slurp")) return JSON.stringify(pages);
    return pages.map((page) => JSON.stringify(page)).join("");
  }

  return { fetch, exec, state };
}

// One page of a Cloudflare listing: 20 items unless asked, at most 50;
// `bare`, at most 20 and without result_info.
function paged(items, query, bare = false) {
  const size = Math.min(Number(query.get("per_page") ?? 20), bare ? 20 : 50);
  const page = Number(query.get("page") ?? 1);
  const result = items.slice((page - 1) * size, page * size);
  if (bare) return { success: true, result };
  return {
    success: true,
    result,
    result_info: {
      page,
      per_page: size,
      total_count: items.length,
      total_pages: Math.ceil(items.length / size),
    },
  };
}

function xml(text) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${text}`, {
    status: 200,
    headers: { "content-type": "application/xml" },
  });
}

function escapeXml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Every request that changed something, as "METHOD path".
export function changes(fetch) {
  return fetch.requests
    .filter(({ method }) => method !== "GET")
    .map(({ method, url }) => `${method} ${new URL(url).pathname}`);
}

// A terminal's input that types the next answer each time a prompt starts
// listening for keys (its first keypress listener; it adds more).
export function answering(answers) {
  const stdin = new PassThrough();
  stdin.prompts = 0;
  stdin.on("newListener", (event) => {
    if (event !== "keypress" || stdin.listenerCount("keypress") > 0) return;
    const answer = answers[stdin.prompts];
    stdin.prompts += 1;
    if (answer !== undefined) setImmediate(() => stdin.write(answer));
  });
  return stdin;
}

// The entries of a ZIP archive, read from its central directory (ZIP64 sizes
// included), each checked against its CRC: { name, body }.
export function readZip(archive) {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50, "the archive ends with its directory");
  let count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  if (count === 0xffff) {
    const record = Number(archive.readBigUInt64LE(end - 20 + 8));
    count = Number(archive.readBigUInt64LE(record + 32));
    offset = Number(archive.readBigUInt64LE(record + 48));
  }
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50, "a central directory header");
    const crc = archive.readUInt32LE(offset + 16);
    let size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    let start = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const extra = archive.subarray(
      offset + 46 + nameLength,
      offset + 46 + nameLength + extraLength,
    );
    if (extra.length >= 4 && extra.readUInt16LE(0) === 0x0001) {
      let field = 4;
      if (size === 0xffffffff) {
        size = Number(extra.readBigUInt64LE(field));
        field += 16;
      }
      if (start === 0xffffffff) start = Number(extra.readBigUInt64LE(field));
    }
    assert.equal(archive.readUInt32LE(start), 0x04034b50, `${name} has a local header`);
    const data = start + 30 + archive.readUInt16LE(start + 26) + archive.readUInt16LE(start + 28);
    const body = archive.subarray(data, data + size);
    assert.equal(crc32(body), crc, `${name}'s CRC matches`);
    entries.push({ name, body });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
