// The Ploi release suites' shared fixture: a content Site with `ploi`,
// `releases`, `media` and `domains` blocks, an in-memory Ploi and R2 behind a
// recording fetch, and a recording exec standing in for git (whose default
// branch's gq.ops.json is the release commit's unless a test says otherwise).
// Nothing here reaches the network.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { createFixtureSite, recordingExec, recordingFetch } from "./fixture-site.mjs";

export const SHA = "0123456789abcdef0123456789abcdef01234567";
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
  return recordingExec(async ({ command, args }) => {
    assert.equal(command, "git");
    if (args[0] === "ls-remote") {
      return { stdout: `ref: refs/heads/main\tHEAD\n${"9".repeat(40)}\tHEAD\n` };
    }
    if (args.join(" ") === "fetch --quiet --no-tags origin refs/heads/main") return {};
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
