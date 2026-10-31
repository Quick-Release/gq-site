// The Ploi release suites' shared fixture: a content Site with `ploi`,
// `releases`, `media` and `domains` blocks, an in-memory Ploi and R2 behind a
// recording fetch, and a recording exec standing in for git (whose default
// branch's gq.ops.json is the release commit's unless a test says otherwise).
// Nothing here reaches the network.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { trustedGit } from "../../src/ploi/trusted-git.mjs";
import { createFixtureSite, recordingExec, recordingFetch } from "./fixture-site.mjs";

export const SHA = "0123456789abcdef0123456789abcdef01234567";
// The CI Worker's authoritative Artifacts remote (a stand-in URL).
export const ARTIFACTS_REMOTE =
  "https://account-1.artifacts.cloudflare.net/git/fixture-ns/fixture.git";
export const DEPLOY_SCRIPT = "#!/usr/bin/env bash\necho deploy v1.4.0\n";
export const SERVER_IP = "203.0.113.7";

export const OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  domains: { admin: "admin.example.test", frontend: "www.example.test" },
  ploi: {
    serverId: "12",
    siteId: "34",
    systemUser: "fixture",
    projectRoot: "/",
    webDirectory: "/apps/cms/web",
    database: "fixture_staging",
    envTemplate: "apps/cms/.env.production.example",
    deployScript: "deploy/ploi/admin.sh",
  },
  releases: { bucket: "fixture-releases", prefix: "admin/" },
  media: { bucket: "fixture-media", domain: "media.example.test" },
  cloudflare: { accountId: "account-1", zoneId: "zone-1", zoneName: "example.test" },
});

export const ENV_TEMPLATE = [
  "DB_NAME='site'",
  "DB_USER='site_user'",
  "DB_PASSWORD='replace-with-a-strong-password'",
  "WP_HOME='https://admin.example.test'",
  "AUTH_KEY='replace-me'",
].join("\n");
export const READY_ENV = [
  "DB_NAME='fixture_staging'",
  "DB_USER='fixture_staging'",
  "DB_PASSWORD='kept'",
  "WP_HOME='https://admin.example.test'",
  "AUTH_KEY='kept-salt'",
  "",
].join("\n");

export const RELEASE_ENV = Object.freeze({
  PLOI_API_TOKEN: "ploi-secret",
  COMPOSER_AUTH: '{"http-basic":{}}',
  R2_ACCESS_KEY_ID: "r2-key",
  R2_SECRET_ACCESS_KEY: "r2-secret",
});

export function site({ ops = OPS, files = {} } = {}) {
  return createFixtureSite({
    ops,
    files: {
      "deploy/ploi/admin.sh": DEPLOY_SCRIPT,
      "apps/cms/.env.production.example": ENV_TEMPLATE,
      ...files,
    },
  });
}

// An in-memory Ploi server 12 / site 34 behind a recording fetch. `state`
// holds what Ploi would report; `deployResult` is the line the deploy script
// prints; R2 answers HEAD (missing unless `archived`) and PUT.
export function fakeProviders({
  state: overrides = {},
  deployResult = `FIXTURE_DEPLOY_STATUS=success SHA=${SHA}`,
  archived = false,
} = {}) {
  const site = {
    id: 34,
    domain: OPS.domains.admin,
    status: "active",
    system_user: "fixture",
    web_directory: "/apps/cms/web",
    project_root: "/",
  };
  const state = {
    site,
    deployScript: DEPLOY_SCRIPT,
    env: READY_ENV,
    repository: { provider: "none" },
    logs: [{ id: 3, type: "deploy" }],
    crontabs: [],
    ...overrides,
  };
  const fetch = recordingFetch(({ method, url, body }) => {
    const { hostname, pathname, search } = new URL(url);
    if (hostname.endsWith(".r2.cloudflarestorage.com")) {
      if (method === "HEAD") return new Response(null, { status: archived ? 200 : 404 });
      if (method === "PUT") return new Response(null, { status: 200 });
    }
    const path = `${pathname.replace("/api/servers/12", "")}${search}`;
    const route = `${method} ${path}`;
    const data = body === undefined ? undefined : JSON.parse(body);
    switch (route) {
      case "GET ":
        return { data: { ip_address: SERVER_IP } };
      case "GET /system-users?per_page=100":
        return { data: [{ name: "fixture" }] };
      case "GET /sites?per_page=100":
        return { data: state.site ? [state.site] : [] };
      case "GET /databases?per_page=100":
        return { data: [{ id: 5, name: "fixture_staging" }] };
      case "GET /sites/34":
        return { data: state.site };
      case "GET /sites/34/repository":
        return { data: { repository: state.repository } };
      case "GET /sites/34/env":
        return { data: state.env };
      case "PATCH /sites/34/env":
        state.env = data.content;
        return {};
      case "GET /sites/34/certificates?per_page=100":
        return { data: [{ type: "letsencrypt", status: "active" }] };
      case "GET /sites/34/deploy/script":
        return { deploy_script: state.deployScript };
      case "PATCH /sites/34/deploy/script":
        state.deployScript = data.deploy_script;
        return {};
      case "GET /sites/34/log?per_page=5":
        return { data: state.logs };
      case "POST /sites/34/deploy":
        state.deployed = data.variables;
        state.logs = [{ id: 4, type: "deploy" }, ...state.logs];
        return {};
      case "GET /crontabs":
        return { data: state.crontabs };
      case "POST /crontabs":
        state.crontabs = [...state.crontabs, { id: state.crontabs.length + 1, ...data }];
        return { data: state.crontabs.at(-1) };
      case "GET /sites/34/log/4":
        return { data: { content: `composer install\n${deployResult}\n` } };
      default:
        throw new Error(`Unexpected request: ${route}`);
    }
  });
  return { fetch, state };
}

// git for the release commit: no v* tag at HEAD, VERSION 1.4.0, and an
// archive written to wherever --output points.
// `manifest` is the release commit's gq.ops.json and `current` the default
// branch's (origin's HEAD, main); null leaves one out.
export function fakeGit({
  tag = null,
  script = DEPLOY_SCRIPT,
  files = {},
  manifest = OPS,
  current = manifest,
} = {}) {
  return recordingExec(async ({ command, args: all }) => {
    assert.ok(isGit(command), command);
    // A CI policy read runs in gq's own repository (--git-dir) against
    // ARTIFACTS_REMOTE, which the workspace's origin names.
    const args = all[0] === "--git-dir" ? all.slice(2) : all;
    if (args.join(" ") === "config --local --no-includes --get remote.origin.url") {
      return { stdout: `${ARTIFACTS_REMOTE}\n` };
    }
    if (args[0] === "init" && args.includes("--bare")) return {};
    if (args[0] === "ls-remote") {
      return { stdout: `ref: refs/heads/main\tHEAD\n${"9".repeat(40)}\tHEAD\n` };
    }
    if (/^fetch --quiet --no-tags \S+ refs\/heads\/main$/u.test(args.join(" "))) return {};
    if (args.join(" ") === "show FETCH_HEAD:gq.ops.json") {
      return current === null
        ? { code: 128, stderr: "fatal: path 'gq.ops.json' does not exist in 'FETCH_HEAD'" }
        : { stdout: JSON.stringify(current) };
    }
    if (args[0] === "show" && args[1] === `${SHA}:gq.ops.json`) {
      return manifest === null
        ? { code: 128, stderr: `fatal: path 'gq.ops.json' does not exist in '${SHA}'` }
        : { stdout: JSON.stringify(manifest) };
    }
    if (args[0] === "describe") {
      return tag ? { stdout: `${tag}\n` } : { code: 128, stderr: "fatal: no tag exactly matches" };
    }
    if (args[0] === "rev-parse") return { stdout: `${SHA}\n` };
    if (args[0] === "show" && args[1] === `${SHA}:VERSION`) return { stdout: "1.4.0\n" };
    if (args[0] === "show" && args[1] === `${SHA}:deploy/ploi/admin.sh`) {
      return { stdout: script };
    }
    if (args[0] === "show" && args[1].startsWith(`${SHA}:`)) {
      const content = files[args[1].slice(SHA.length + 1)];
      return content === undefined
        ? { code: 128, stderr: `fatal: path '${args[1]}' does not exist` }
        : { stdout: content };
    }
    if (args[0] === "archive") {
      const output = args.find((argument) => argument.startsWith("--output=")).slice(9);
      await writeFile(output, "release-archive");
      return {};
    }
    return { code: 1, stderr: `unexpected git ${args.join(" ")}` };
  });
}

export const resolvesToServer = async () => [{ address: SERVER_IP }];
export const requestLine = ({ method, url }) => `${method} ${new URL(url).pathname}`;

export const PAUSED = Object.freeze({
  protected: true,
  state: "paused",
  reason: "Nightly updates paused for a controlled release",
});
export const RESERVED = Object.freeze({
  protected: true,
  state: "reserved",
  reason: "The nightly pipeline is updating the Site",
  holder: "nightly pipeline",
});

// A git command: `git` from PATH, or the system git the policy reads use
// (trusted-git.mjs).
export const isGit = (command) => command === "git" || command === TRUSTED_GIT;
export const TRUSTED_GIT = trustedGit();

// --- guarded packages: the approval record and lookup stand-ins ----------

// The Site's approval slot and stage, which every record must name.
export const APPROVAL = Object.freeze({ slot: "fixture/production", stage: "prod" });

// The commit refs/tags/v0.1.11 points to: the lock's source.reference.
export const PUBLISHED_REFERENCE = "b".repeat(40);

// gq-support.php ("hello\n") alone, and its gq-support.files/v1 digest, from
// printf 'gq-support.php\0<sha256>\n' | sha256sum.
export const SUPPORT_FILES = Object.freeze({
  "gq-support.php": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
});

export const SUPPORT_DIGEST = "335b71ade6b432f03f1858a221294a017f4d6dc1f635a504e85194dcf30b26ce";

// fakeClock's now.
export const OBSERVED = "2026-10-01T09:00:00Z";

// A gq-support.composer-approval/v1 record, as the approval service returns it.
export function approvalRecord(overrides = {}) {
  return {
    schema: "gq-support.composer-approval/v1",
    stage: APPROVAL.stage,
    slot: APPROVAL.slot,
    phase: "deploy",
    release_id: 11,
    package: { name: "getquick/gq-support", version: "0.1.11", zip_sha256: "f".repeat(64) },
    // The gq-support source commit: never the lock's reference.
    provenance: { source_commit: "c".repeat(40), release_run: "4242" },
    published_tag: { name: "v0.1.11", commit: PUBLISHED_REFERENCE },
    files: SUPPORT_FILES,
    files_digest: SUPPORT_DIGEST,
    normalization: "gq-support.files/v1",
    observed_at: OBSERVED,
    ...overrides,
  };
}

// An approval adapter answering each lookup with the next of `answers` (a
// record, or an Error it rejects with), noting each request and, when given
// `fetch`, the provider requests made before it.
export function scriptedApprovals(answers, fetch) {
  const requests = [];
  return {
    requests,
    async lookup(request) {
      requests.push({ ...request, before: fetch?.requests.map(requestLine) });
      const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}
