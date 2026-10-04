// The provider operations offboarding plans and applies against: Cloudflare
// (the project's tokens, Workers, Workflows, containers, D1, custom domains,
// R2, Artifacts and the zone's DNS records), the Ploi site, its crontab,
// database and system user, the GitHub repository and its webhooks, the CMS
// database backup and dump, and the operator's git checkout.
// Each offboarding command (`gq offboard`, `--restore`, and the archive that
// deletes) works through this one surface, so a step only says what it does,
// never how a provider is called.
//
// Credentials: the command runs through `gq sigillo run operations`, which
// injects the token-manager token. Tokens are managed with it; every other
// Cloudflare call goes through a 1-hour token it mints for this run and
// deletes afterwards (named "GETQUICK <PROJECT> offboarding (temporary)").
// Ploi's token and the releases bucket's R2 key live in Sigillo staging and
// are read into memory from there unless the environment already has them;
// GitHub goes through the operator's `gh` login, and git through the
// checkout's own remote and credentials. No value is printed.
//
// An Artifacts-only Site (no github.repository, ADR 0012) has no GitHub to
// reach: its code is read from its Artifacts repository with git, through a
// read-only git token minted for each operation and handed to git in its
// environment, never in its arguments or on disk.
//
// R2 objects (the archive's reads, writes and emptied buckets) go through
// keys scoped to one bucket each, minted for the run as 1-hour tokens
// ("GETQUICK <PROJECT> offboarding <bucket> (temporary)") and deleted with
// the run's token: phase 1 disabled the project's own bucket keys, and a
// scoped key can't reach another client's bucket. R2 rejects a new key for
// a while, so each is retried until R2 first accepts it (src/r2.mjs).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { redactText } from "../cli/redact.mjs";

import { exportLiveDatabase, runBackup } from "../db/sync.mjs";
import { createR2Client, s3CredentialsFromToken } from "../r2.mjs";
import { createPloiServerClient } from "../ploi/server-client.mjs";
import { sigilloSecrets } from "../sigillo/commands.mjs";
import { isArtifactsOnly } from "../ci/git-artifacts.mjs";
import {
  artifactsRemoteUrl,
  createCloudflareAccountClient,
} from "../cloudflare/account-client.mjs";
import {
  accountPolicy,
  bucketPolicies,
  managerToken,
  SECRETS_ENVIRONMENT,
  tokenName,
  withTemporaryToken,
  zonePolicy,
} from "../cloudflare/tokens.mjs";

// What the run's temporary token may do: detach and attach Workers custom
// domains and switch workers.dev, and toggle the media bucket's domain.
// D1 Read finds the publication stores that tie the Frontend's other stages
// to the project.
export const offboardingAccountPermissions = [
  "Workers Scripts Read",
  "Workers Scripts Write",
  "Workers Routes Write",
  "Workers R2 Storage Write",
  "D1 Read",
];
export const offboardingZonePermissions = ["Zone Read", "DNS Write", "Workers Routes Write"];
// An Artifacts-only Site's cut revokes its repository's git tokens.
const artifactsPermissions = ["Artifacts Read", "Artifacts Write"];
// The archive also deletes: Workers (and their Workflows), container
// applications, D1 stores (after exporting one), buckets, and Artifacts
// repositories; and deletes DNS records with the zone permissions above.
export const archiveAccountPermissions = [
  ...offboardingAccountPermissions,
  "D1 Write",
  "Workers Containers Read",
  "Workers Containers Write",
  ...artifactsPermissions,
];

// A deletion finds what it deletes already gone (another deletion took it
// along, or a rerun): that is done, not a failure.
const GONE = { allowNotFound: true };
const ONE_HOUR = 60 * 60 * 1000;
const D1_EXPORT_POLL_MS = 2000;
const D1_EXPORT_TIMEOUT_MS = 15 * 60 * 1000;
// Ploi deletes a site in the background: gq waits up to 5 minutes for it to
// go, 2 s at first, then twice as long each time up to 10 s.
const PLOI_SETTLE_MS = 5 * 60 * 1000;
const PLOI_FIRST_WAIT_MS = 2000;
const PLOI_LONGEST_WAIT_MS = 10_000;

// The gq.ops.json keys offboarding reads, checked before anything runs. The
// archive forgets ploi.siteId once it deletes the site, so it doesn't need it.
// A Site without github.repository is Artifacts-only, so it needs its
// Artifacts repository instead.
const SITE_ID_KEY = ["ploi.siteId", (ops) => ops.ploi?.siteId];
const REQUIRED_KEYS = [
  ["domains.admin", (ops) => ops.domains?.admin],
  ["domains.frontend", (ops) => ops.domains?.frontend],
  ["ploi.serverId", (ops) => ops.ploi?.serverId],
  ["ploi.systemUser", (ops) => ops.ploi?.systemUser],
  ["ploi.database", (ops) => ops.ploi?.database],
  ["backups.bucket", (ops) => ops.backups?.bucket],
  ["media.bucket", (ops) => ops.media?.bucket],
  ["media.domain", (ops) => ops.media?.domain],
  ["ci.worker", (ops) => ops.ci?.worker],
  ["cloudflare.accountId", (ops) => ops.cloudflare?.accountId],
  ["cloudflare.zoneId", (ops) => ops.cloudflare?.zoneId],
];
const ARTIFACTS_KEYS = [
  ["artifacts.namespace", (ops) => ops.artifacts?.namespace],
  ["artifacts.repo", (ops) => ops.artifacts?.repo],
];
const ARCHIVE_KEYS = [
  ["releases.bucket", (ops) => ops.releases?.bucket],
  ["ci.backupBucket", (ops) => ops.ci?.backupBucket],
  ...ARTIFACTS_KEYS,
];

// Runs `work(providers)` with every provider connected, and deletes the
// temporary Cloudflare tokens afterwards whatever happens. `dependencies` are
// the run() seam's (context, env, fetch, exec, clock, io, interactive); `archive`
// grants what the archive needs and requires its keys.
export async function withOffboardingProviders(dependencies, work, { archive = false } = {}) {
  const { context, env, fetch, exec, clock } = dependencies;
  const ops = context.config;
  const artifactsOnly = isArtifactsOnly(ops);
  const required = archive
    ? [...REQUIRED_KEYS, ...ARCHIVE_KEYS]
    : [...REQUIRED_KEYS, SITE_ID_KEY, ...(artifactsOnly ? ARTIFACTS_KEYS : [])];
  const missing = required.filter(([, read]) => !read(ops)).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `gq.ops.json ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required to ${archive ? "archive" : "offboard"}.`,
    );
  }
  const accountId = ops.cloudflare.accountId;
  const manager = createCloudflareAccountClient({
    token: managerToken(context, "offboard"),
    accountId,
    fetch,
  });
  const staging = await sigilloSecrets({ context, env, exec }, SECRETS_ENVIRONMENT);
  // A secret Sigillo doesn't list (or holds empty) is missing; one it lists
  // but can't hand over, or a listing that fails too, is a failed read.
  const stagingSecret = async (name) => {
    const injected = context.env[name]?.trim();
    if (injected) return injected;
    const missing = new Error(`${name} is missing in Sigillo ${staging.name}.`);
    let value;
    try {
      value = await staging.get(name);
    } catch (error) {
      const listed = await staging.list().catch(() => undefined);
      if (listed !== undefined && !new RegExp(`\\b${name}\\b`, "u").test(listed)) throw missing;
      throw new Error(
        `Reading ${name} from Sigillo ${staging.name} failed: ${redactText(error.message)}`,
        {
          cause: error,
        },
      );
    }
    if (!value) throw missing;
    return value;
  };

  const ploiClient = createPloiServerClient({
    token: await stagingSecret("PLOI_API_TOKEN"),
    serverId: ops.ploi.serverId,
    fetch,
  });
  // The manager token is never one of the project's tokens offboarding
  // disables, whatever it is named.
  const { id: managerId } = await manager("GET", "/tokens/verify");
  const groups = await manager("GET", "/tokens/permission_groups");

  return withTemporaryToken(
    manager,
    {
      name: tokenName(ops.project, "offboarding (temporary)"),
      accountId,
      zoneId: ops.cloudflare.zoneId,
      policies: [
        accountPolicy(
          accountId,
          archive
            ? archiveAccountPermissions
            : [...offboardingAccountPermissions, ...(artifactsOnly ? artifactsPermissions : [])],
          groups,
        ),
        zonePolicy(ops.cloudflare.zoneId, offboardingZonePermissions, groups),
      ],
      fetch,
    },
    async (cloudflare, zone) => {
      const keys = scopedKeys({
        manager,
        accountId,
        project: ops.project,
        groups,
        fetch,
        clock,
      });
      let failure;
      try {
        return await work({
          ops,
          cloudflare: cloudflareOperations({
            manager,
            cloudflare,
            zone,
            managerId,
            project: ops.project,
            fetch,
          }),
          ploi: ploiOperations(ploiClient, ops.ploi.siteId, clock),
          ...repositoryOperations(dependencies),
          ...(artifactsOnly ? { code: codeOperations({ ...dependencies, ops, cloudflare }) } : {}),
          r2: keys.r2,
          dumpDatabase: (uploadUrl) => exportLiveDatabase(ploiClient, ops, uploadUrl),
          async backupDatabase() {
            const r2 = {
              R2_ACCESS_KEY_ID: await stagingSecret("R2_ACCESS_KEY_ID"),
              R2_SECRET_ACCESS_KEY: await stagingSecret("R2_SECRET_ACCESS_KEY"),
              PLOI_API_TOKEN: await stagingSecret("PLOI_API_TOKEN"),
            };
            const code = await runBackup({
              ...dependencies,
              parsed: {},
              context: { ...context, env: { ...context.env, ...r2 } },
            });
            if (code !== 0) throw new Error("The final database backup failed.");
          },
        });
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        // A key left behind expires within the hour; why the run stopped
        // matters more.
        await keys.close().catch((error) => {
          if (!failure) throw error;
        });
      }
    },
  );
}

// Runs `work(providers)` with only a Site on GitHub's repository and the
// checkout (`github` and `git`): what is left once its infrastructure is
// deleted.
export function withRepositoryProviders(dependencies, work) {
  return work({ ops: dependencies.context.config, ...repositoryOperations(dependencies) });
}

// The checkout, and the GitHub repository unless the Site is Artifacts-only.
function repositoryOperations({ context, env, exec }) {
  const repository = context.config.github?.repository;
  return {
    ...(repository ? { github: githubOperations(exec, env, repository) } : {}),
    git: gitOperations(exec, env, context.projectRoot, basename(context.configPath)),
  };
}

// R2 clients for one bucket each, minted on first use as 1-hour tokens that
// can only read and write that bucket's objects; close() deletes them. R2
// takes a while to accept a new key: each client waits for it on `clock`.
function scopedKeys({ manager, accountId, project, groups, fetch, clock }) {
  const minted = new Map();
  async function mint(bucket) {
    const token = await manager("POST", "/tokens", {
      name: tokenName(project, `offboarding ${bucket} (temporary)`),
      expires_on: new Date(Date.now() + ONE_HOUR).toISOString().replace(/\.\d{3}Z$/u, "Z"),
      policies: bucketPolicies({ accountId, bucket }, groups),
    });
    const credentials = await s3CredentialsFromToken(token.id, token.value);
    return {
      token,
      client: createR2Client({ accountId, bucket, ...credentials, fetch, minted: clock }),
    };
  }
  return {
    async r2(bucket) {
      if (!minted.has(bucket)) minted.set(bucket, mint(bucket));
      return (await minted.get(bucket)).client;
    },
    // Deletes every key, then fails on the first that couldn't be.
    async close() {
      const settled = await Promise.allSettled(minted.values());
      const deleted = await Promise.allSettled(
        settled
          .filter((result) => result.status === "fulfilled")
          .map((result) => manager("DELETE", `/tokens/${result.value.token.id}`)),
      );
      const failed = deleted.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    },
  };
}

function cloudflareOperations({ manager, cloudflare, zone, managerId, project, fetch }) {
  const prefix = tokenName(project, "");
  // A Worker's settings (its bindings), or null when it is gone.
  const workerSettings = (script) =>
    cloudflare("GET", `/workers/scripts/${script}/settings`, undefined, GONE);
  return {
    // The project's own tokens ("GETQUICK <PROJECT> …"), without the
    // temporary ones gq mints and deletes, and never the manager token.
    async projectTokens() {
      const tokens = await manager("GET", "/tokens", undefined, { paginate: true });
      return tokens.filter(
        (token) =>
          token.name.startsWith(prefix) &&
          !token.name.endsWith("(temporary)") &&
          token.id !== managerId,
      );
    },
    // Cloudflare replaces a token on update, so everything but its status
    // is sent back as it was listed.
    setTokenStatus(token, status) {
      const kept = ["name", "policies", "condition", "expires_on", "not_before"];
      const body = Object.fromEntries(
        kept.filter((key) => token[key] !== undefined).map((key) => [key, token[key]]),
      );
      return manager("PUT", `/tokens/${token.id}`, { ...body, status });
    },
    async accountSubdomain() {
      return (await cloudflare("GET", "/workers/subdomain")).subdomain;
    },
    workerDomains: (service) =>
      cloudflare("GET", `/workers/domains?service=${encodeURIComponent(service)}`),
    detachWorkerDomain: (id) => cloudflare("DELETE", `/workers/domains/${id}`),
    attachWorkerDomain: ({ hostname, service, zoneId }) =>
      cloudflare("PUT", "/workers/domains", {
        hostname,
        service,
        zone_id: zoneId,
        environment: "production",
      }),
    // A Worker's bindings (none once it is gone).
    async workerBindings(script) {
      return (await workerSettings(script))?.bindings ?? [];
    },
    workerSubdomain: (script) => cloudflare("GET", `/workers/scripts/${script}/subdomain`),
    // `previewsEnabled` left out keeps Cloudflare's default for it.
    setWorkerSubdomain: (script, { enabled, previewsEnabled }) =>
      cloudflare("POST", `/workers/scripts/${script}/subdomain`, {
        enabled,
        ...(previewsEnabled === undefined ? {} : { previews_enabled: previewsEnabled }),
      }),
    async bucketDomain(bucket, domain) {
      const { domains = [] } = await cloudflare("GET", `/r2/buckets/${bucket}/domains/custom`);
      return domains.find((candidate) => candidate.domain === domain);
    },
    setBucketDomain: (bucket, domain, enabled) =>
      cloudflare("PUT", `/r2/buckets/${bucket}/domains/custom/${domain}`, { enabled }),
    removeBucketDomain: (bucket, domain) =>
      cloudflare("DELETE", `/r2/buckets/${bucket}/domains/custom/${domain}`, undefined, GONE),
    deleteToken: (token) => manager("DELETE", `/tokens/${token.id}`),

    // What the archive reads, exports and deletes. Whether something is
    // there is an exact lookup wherever Cloudflare has one: a listing may
    // miss it, and the plan must not say it is deleted.
    async workers() {
      const scripts = await cloudflare("GET", "/workers/scripts", undefined, { paginate: true });
      return [...new Set(scripts.map((script) => script.id))];
    },
    async workerExists(script) {
      return (await workerSettings(script)) !== null;
    },
    deleteWorker: (name) => cloudflare("DELETE", `/workers/scripts/${name}`, undefined, GONE),
    async workflowExists(name) {
      return (await cloudflare("GET", `/workflows/${name}`, undefined, GONE)) !== null;
    },
    deleteWorkflow: (name) => cloudflare("DELETE", `/workflows/${name}`, undefined, GONE),
    containerApplications: () =>
      cloudflare("GET", "/containers/applications", undefined, { paginate: true }),
    deleteContainerApplication: (id) =>
      cloudflare("DELETE", `/containers/applications/${id}`, undefined, GONE),
    async d1(name) {
      const found = await cloudflare(
        "GET",
        `/d1/database?name=${encodeURIComponent(name)}`,
        undefined,
        { paginate: true },
      );
      return found.find((database) => database.name === name);
    },
    // Every D1 store whose name starts with `prefix`.
    async d1Stores(prefix) {
      const query = `?name=${encodeURIComponent(prefix)}`;
      const found = await cloudflare("GET", `/d1/database${query}`, undefined, { paginate: true });
      return found.filter((database) => database.name.startsWith(prefix));
    },
    deleteD1: (id) => cloudflare("DELETE", `/d1/database/${id}`, undefined, GONE),
    // The D1 store's SQL export, as a Response to stream: Cloudflare writes
    // it, then hands out a signed URL for it.
    async exportD1(id) {
      const deadline = Date.now() + D1_EXPORT_TIMEOUT_MS;
      let bookmark;
      while (Date.now() < deadline) {
        const exported = await cloudflare("POST", `/d1/database/${id}/export`, {
          output_format: "polling",
          ...(bookmark ? { current_bookmark: bookmark } : {}),
        });
        if (exported.status === "error") {
          throw new Error(`The D1 export failed: ${exported.error ?? "no reason given"}`);
        }
        const url = exported.result?.signed_url;
        if (exported.status === "complete" && url) {
          const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
          if (!response.ok)
            throw new Error(`Downloading the D1 export failed with ${response.status}`);
          return response;
        }
        bookmark = exported.at_bookmark;
        await sleep(D1_EXPORT_POLL_MS);
      }
      throw new Error("The D1 export did not finish within 15 minutes.");
    },
    async bucketExists(name) {
      return (await cloudflare("GET", `/r2/buckets/${name}`, undefined, GONE)) !== null;
    },
    createBucket: (name) => cloudflare("POST", "/r2/buckets", { name }),
    deleteBucket: (name) => cloudflare("DELETE", `/r2/buckets/${name}`, undefined, GONE),
    artifactsRepository: (namespace, repo) =>
      cloudflare("GET", `/artifacts/namespaces/${namespace}/repos/${repo}`, undefined, {
        allowNotFound: true,
      }),
    // The repository's active git tokens, which push to it while they last;
    // null once it is gone (a listing would come back empty).
    async artifactsGitTokens(namespace, repo) {
      const path = `/artifacts/namespaces/${namespace}/repos/${repo}`;
      if (!(await cloudflare("GET", path, undefined, GONE))) return null;
      return cloudflare("GET", `${path}/tokens?state=active`, undefined, { paginate: true });
    },
    revokeArtifactsGitToken: (namespace, id) =>
      cloudflare("DELETE", `/artifacts/namespaces/${namespace}/tokens/${id}`, undefined, GONE),
    deleteArtifactsRepository: (namespace, repo) =>
      cloudflare("DELETE", `/artifacts/namespaces/${namespace}/repos/${repo}`, undefined, GONE),
    // The zone's own name (its apex).
    async zoneName() {
      return (await zone("GET", "")).name;
    },
    // The zone's records named exactly `hostname`.
    async dnsRecords(hostname) {
      const records = await zone("GET", `/dns_records?name=${encodeURIComponent(hostname)}`);
      return records.filter((record) => record.name.toLowerCase() === hostname.toLowerCase());
    },
    deleteDnsRecord: (id) => zone("DELETE", `/dns_records/${id}`, undefined, GONE),
  };
}

function ploiOperations(client, siteId, clock) {
  const sitePath = `/sites/${siteId}`;
  return {
    async site() {
      return (await client.request("GET", sitePath)).data ?? {};
    },
    // The site, or null once it is deleted (or gq.ops.json forgot it).
    async existingSite() {
      if (!siteId) return null;
      return (
        (await client.request("GET", sitePath, undefined, { allowNotFound: true }))?.data ?? null
      );
    },
    // The site's .env file, as text ("" without one).
    async siteEnv() {
      const response = await client.request("GET", `${sitePath}/env`, undefined, {
        allowNotFound: true,
      });
      return String(response?.data ?? response?.env ?? response?.content ?? "");
    },
    deleteSite: () => client.request("DELETE", sitePath, undefined, GONE),
    // Resolves once Ploi neither returns nor lists the deleted site, which
    // it deletes in the background; throws after 5 minutes.
    async siteDeleted() {
      const gone = await settling(
        clock,
        async () =>
          !(await client.request("GET", sitePath, undefined, { allowNotFound: true })) &&
          !(await client.list("/sites")).some(({ id }) => String(id) === String(siteId)),
      );
      if (!gone) {
        throw new Error(
          `Ploi still shows the site ${siteId} 5 minutes after deleting it: run gq offboard --archive again once it is gone.`,
        );
      }
    },
    // Every site on the server.
    sites: () => client.list("/sites"),
    databases: () => client.list("/databases"),
    deleteDatabase: (id) => client.request("DELETE", `/databases/${id}`, undefined, GONE),
    systemUsers: () => client.list("/system-users"),
    // Ploi refuses (422) while a site it is still deleting runs as the user:
    // retried for 5 minutes, then the last refusal fails the run.
    async deleteSystemUser(id) {
      let refusal;
      const deleted = await settling(clock, async () => {
        try {
          await client.request("DELETE", `/system-users/${id}`, undefined, GONE);
          return true;
        } catch (error) {
          if (error.status !== 422) throw error;
          refusal = error;
          return false;
        }
      });
      if (!deleted) {
        throw new Error(
          `${refusal.message} Ploi still refused it after gq retried for 5 minutes.`,
          { cause: refusal },
        );
      }
    },
    suspend: (reason) => client.request("POST", `${sitePath}/suspend`, { reason }),
    resume: () => client.request("POST", `${sitePath}/resume`),
    crontabs: () => client.list("/crontabs"),
    deleteCrontab: (id) => client.request("DELETE", `/crontabs/${id}`),
    createCrontab: (crontab) => client.request("POST", "/crontabs", crontab),
  };
}

// Calls `settled()` until it resolves to true, waiting on `clock` between
// calls; resolves to false once 5 minutes have gone by.
async function settling(clock, settled) {
  const started = clock.now();
  let wait = PLOI_FIRST_WAIT_MS;
  for (;;) {
    if (await settled()) return true;
    const waited = clock.now() - started;
    if (waited >= PLOI_SETTLE_MS) return false;
    await clock.sleep(Math.min(wait, PLOI_SETTLE_MS - waited));
    wait = Math.min(wait * 2, PLOI_LONGEST_WAIT_MS);
  }
}

// An Artifacts-only Site's code, read from its Artifacts repository with git
// (`exec`) and a read-only git token the run's temporary token (`cloudflare`)
// mints for each operation and revokes after it: git gets it as the credential helper would (user
// x), in an extra header set through its environment, with every other
// credential helper turned off and no prompt. A failure names the git
// command, with its output redacted.
function codeOperations({ ops, cloudflare, exec, env }) {
  const { namespace, repo } = ops.artifacts;
  const remote = artifactsRemoteUrl({ accountId: ops.cloudflare.accountId, namespace, repo });
  async function run(args, cwd, gitEnv) {
    const result = await exec("git", args, { cwd, env: { ...env, ...gitEnv } });
    if (result.code !== 0) {
      const output = redactText(result.stderr.trim()) || `exit code ${result.code}`;
      throw new Error(`git ${args.join(" ")} failed: ${output}`);
    }
    return result.stdout;
  }
  // git reaching the repository, with a git token minted for it and
  // revoked once git is done, whatever happened.
  async function remoteGit(args, cwd) {
    const { id, plaintext } = await cloudflare(
      "POST",
      `/artifacts/namespaces/${namespace}/tokens`,
      { repo, scope: "read", ttl: 3600 },
    );
    const authorization = Buffer.from(`x:${plaintext}`).toString("base64");
    try {
      return await run(args, cwd, {
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "http.extraHeader",
        GIT_CONFIG_VALUE_1: `Authorization: Basic ${authorization}`,
      });
    } finally {
      await cloudflare(
        "DELETE",
        `/artifacts/namespaces/${namespace}/tokens/${id}`,
        undefined,
        GONE,
      );
    }
  }
  return {
    // Every ref under refs/ and the commit it points at, as { ref: sha }.
    async refs() {
      return parseRefs(await remoteGit(["ls-remote", "--refs", remote]));
    },
    // Calls `work({ path, refs })` with a git bundle of every ref (`refs`, as
    // the bundle lists them), made from a mirror clone in a temporary
    // directory that is removed afterwards whatever happens.
    async bundle(work) {
      const directory = await mkdtemp(join(tmpdir(), "gq-offboard-"));
      try {
        const mirror = join(directory, "repository.git");
        const path = join(directory, "code.bundle");
        await remoteGit(["clone", "--mirror", "--quiet", remote, mirror]);
        await run(["bundle", "create", "--quiet", path, "--all"], mirror);
        await run(["bundle", "verify", "--quiet", path], mirror);
        const refs = parseRefs(await run(["bundle", "list-heads", path], mirror));
        return await work({ path, refs });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

// `<sha> <ref>` lines (tab- or space-separated) as { ref: sha }, only refs
// under refs/ (a bundle may list HEAD too).
function parseRefs(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim().split(/\s+/u))
      .filter(([sha, ref]) => sha && ref?.startsWith("refs/"))
      .map(([sha, ref]) => [ref, sha])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

// The repository's webhooks through the operator's `gh` login (it needs repo
// admin, as `gq github setup` does). Bodies go over stdin.
function githubOperations(exec, env, repository) {
  async function gh(args, input) {
    const result = await exec("gh", ["api", ...args], {
      env,
      input: input === undefined ? undefined : JSON.stringify(input),
    });
    if (result.code !== 0) {
      throw new Error(`gh api ${args.join(" ")} failed: ${redactText(result.stderr.trim())}`);
    }
    return result.stdout ? JSON.parse(result.stdout) : null;
  }
  return {
    repository,
    // Every page of them: --slurp wraps the pages in one array.
    async hooks() {
      return (await gh(["--paginate", "--slurp", `repos/${repository}/hooks?per_page=100`])).flat();
    },
    updateHook: (id, change) =>
      gh(["-X", "PATCH", `repos/${repository}/hooks/${id}`, "--input", "-"], change),
    deleteHook: (id) => gh(["-X", "DELETE", `repos/${repository}/hooks/${id}`]),
    // Whether it is archived, and its default branch.
    async details() {
      const found = await gh([`repos/${repository}`]);
      return { archived: found.archived === true, defaultBranch: found.default_branch };
    },
    async headCommit() {
      return (await gh([`repos/${repository}/commits/HEAD`])).sha;
    },
    // Read-only from then on: its code, issues and history stay readable.
    async archive() {
      const result = await exec("gh", ["repo", "archive", repository, "--yes"], { env });
      if (result.code !== 0) {
        throw new Error(
          `gh repo archive ${repository} failed: ${redactText(result.stderr.trim())}`,
        );
      }
    },
  };
}

// The operator's checkout, through git in the project root (`cwd`): what the
// archive reads of it, and gq.ops.json (`file`, relative to `cwd`) committed
// and pushed. A failure names the git command, with its output redacted.
function gitOperations(exec, env, cwd, file) {
  async function git(args) {
    const result = await exec("git", args, { cwd, env });
    if (result.code !== 0) {
      const output = redactText(result.stderr.trim()) || `exit code ${result.code}`;
      throw new Error(`git ${args.join(" ")} failed: ${output}`);
    }
    return result.stdout;
  }
  return {
    // The branch checked out, or null when HEAD is detached.
    async branch() {
      const name = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      return name === "HEAD" ? null : name;
    },
    // The remote `branch` tracks, or null.
    async remote(branch) {
      const result = await exec("git", ["config", "--get", `branch.${branch}.remote`], {
        cwd,
        env,
      });
      return (result.code === 0 && result.stdout.trim()) || null;
    },
    async remoteUrl(remote) {
      return (await git(["remote", "get-url", remote])).trim();
    },
    fetch: (remote, branch) =>
      git(["fetch", "--quiet", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]),
    // The paths changed or untracked anywhere in the checkout but `file`.
    async otherChanges() {
      const status = await git([
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ":(top)",
        `:(exclude)${file}`,
      ]);
      return status
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3));
    },
    // Whether `file` differs from its last commit.
    async recordChanged() {
      return (await git(["status", "--porcelain", "--", file])).trim() !== "";
    },
    // How many commits `remote`'s `branch` and HEAD each have that the other
    // lacks (as last fetched).
    async divergence(remote, branch) {
      const counts = await git([
        "rev-list",
        "--left-right",
        "--count",
        `${remote}/${branch}...HEAD`,
      ]);
      const [behind, ahead] = counts.trim().split(/\s+/u).map(Number);
      return { behind, ahead };
    },
    // Commits `file` alone, whatever else is staged.
    async commitRecord(message) {
      await git(["add", "--", file]);
      await git(["commit", "--quiet", "-m", message, "--", file]);
    },
    // Refused by the remote unless it is a fast-forward.
    push: (remote, branch) => git(["push", "--quiet", remote, `HEAD:refs/heads/${branch}`]),
  };
}
