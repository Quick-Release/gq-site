// Deploys a release of the admin to Ploi without any git host: packs the release commit with `git archive`
// (plus a RELEASE manifest), uploads it to the private R2 releases bucket, and
// triggers the Ploi deploy with a short-lived presigned URL (ARCHIVE_URL for
// the site's deploy script). Ploi runs its stored copy of the deploy script,
// so that copy is first synced to gq.ops.json `ploi.deployScript` as of the
// release commit. Fails unless Ploi reports it deployed exactly that commit.
//
//   gq ploi release                  # the v* tag at HEAD, else HEAD
//   gq ploi release --ref v0.1.1     # any tag, branch or commit
//   gq ploi release --git-dir <dir>  # read the commit from another repository
//   gq ploi release --composer-only  # the deploy script stops after Composer:
//                                    # no WP-CLI, activation or database step

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { createR2Client } from "../r2.mjs";
import { createReporter } from "../cli/reporter.mjs";
import {
  assertDeploymentAllowed,
  releasePolicy,
} from "./deployment-policy.mjs";
import { validateManifest } from "../manifest/manifest.mjs";
import { policyGit } from "./trusted-git.mjs";
import {
  SERVER_EXPECTATIONS_FILE,
  prepareGuardedRelease,
  revalidateGuardedRelease,
  unconfiguredApprovals,
} from "./package-expectations.mjs";
import { missingRegistryCredential } from "../sigillo/registry-credentials.mjs";
import { deploy, syncDeployScript } from "./provision.mjs";
import { createPloiServerClient } from "./server-client.mjs";

// Layout: what the archive ships. The site's deploy script must expect the
// same paths (deploy/ploi/admin.sh SHIPPED_PATHS).
export const shippedPaths = Object.freeze(["apps/cms", "deploy/ploi"]);

// The server's `composer install` fetches the GETQUICK plugins from the
// private registry. The login comes from the secret store and reaches the
// deploy script as the deploy variable composer_auth → $COMPOSER_AUTH, for
// that one deploy; nothing stores it on the server. `composerOnly` adds the
// deploy variable composer_only → $COMPOSER_ONLY=true, which makes the deploy
// script stop after Composer (and its verifications), before any WP-CLI,
// activation or database step. `env` names where a missing login comes from.
export function deployVariables(
  archiveUrl,
  composerAuth,
  { composerOnly = false, env = {} } = {},
) {
  if (!composerAuth) {
    throw new Error(
      `${missingRegistryCredential("COMPOSER_AUTH", env)} In CI the Worker has it from gq ci deploy.`,
    );
  }
  return {
    archive_url: archiveUrl,
    composer_auth: composerAuth,
    ...(composerOnly ? { composer_only: "true" } : {}),
  };
}

// A guarded release's archive also ships PACKAGE_EXPECTATIONS, so its key
// names that file's digest too: an archive packed before (or with other
// expectations) is never reused for it.
export function releaseKey(prefix, version, sha, expectations = null) {
  const guarded = expectations
    ? `-${createHash("sha256").update(expectations).digest("hex").slice(0, 12)}`
    : "";
  return `${prefix}v${version}-${sha.slice(0, 12)}${guarded}.tar.gz`;
}

export function releaseManifest({ version, sha, ref }) {
  return `version=${version}\ncommit=${sha}\nref=${ref}\n`;
}

// `gq ploi release [--ref <ref>] [--git-dir <dir>] [--composer-only]`.
// Resolves to an exit code.
// `approvals` is the package approval seam (package-expectations.mjs); only
// a Site with guarded packages consults it, with `clock` to judge how fresh
// its records are.
export async function runRelease({
  context,
  parsed,
  env,
  fetch,
  exec,
  io,
  interactive,
  approvals = unconfiguredApprovals,
  clock = { now: () => Date.now() },
}) {
  const ops = context.config;
  // A paused or reserved Site refuses before anything else.
  assertDeploymentAllowed(ops);
  const { bucket, prefix = "" } = ops.releases ?? {};
  if (!bucket) throw new Error("gq.ops.json releases.bucket is required.");
  const deployScriptPath = ops.ploi?.deployScript;
  if (!deployScriptPath) throw new Error("gq.ops.json ploi.deployScript is required.");
  for (const key of ["serverId", "siteId"]) {
    if (!ops.ploi[key]) throw new Error(`gq.ops.json ploi.${key} is required.`);
  }
  if (!ops.cloudflare?.accountId) throw new Error("gq.ops.json cloudflare.accountId is required.");
  if (!ops.domains?.admin) throw new Error("gq.ops.json domains.admin is required.");

  // --git-dir: read the release commit from another repository (CI's
  // workspace is a plain copy without .git; its release step fetches one).
  const gitDir = parsed.gitDir ? resolve(context.invocationDirectory, parsed.gitDir) : null;
  // The Site's own git calls get no source control credential: the
  // Artifacts token is only for the policy's two origin reads.
  const { ARTIFACTS_TOKEN: _token, ...siteEnv } = env;
  void _token;
  const git = gitRunner(exec, gitDir ?? context.projectRoot, siteEnv);
  // The policies are read with a system git and an environment gq builds
  // (trusted-git.mjs), never PATH's git or the caller's GIT_*. The default
  // branch is read from origin on an operator's machine; in CI only from
  // ARTIFACTS_REMOTE (which origin must name), in a repository gq creates,
  // the token (ARTIFACTS_TOKEN) in a header scoped to that URL.
  const policy = policyGit({
    exec,
    cwd: gitDir ?? context.projectRoot,
    env,
    token: context.env.ARTIFACTS_TOKEN,
    remote: context.env.ARTIFACTS_REMOTE,
  });
  const ref = parsed.ref ?? (await defaultRef(git));
  const sha = (await git(["rev-parse", `${ref}^{commit}`])).trim();
  // Every policy that applies, before anything else reads or changes a
  // provider: the working tree's, the release commit's and the default
  // branch's current one (an old commit doesn't carry a newer hold). Any of
  // them offboarded or holding, or one unreadable, refuses.
  const manifestPath = relative(context.projectRoot, context.configPath);
  const { guarded, target } = releasePolicy([
    { ops, source: "gq.ops.json" },
    {
      ops: await requestedManifest(policy.local, sha, manifestPath),
      source: `release ${sha.slice(0, 12)}'s ${manifestPath}`,
    },
    {
      ops: await policy.defaultBranchManifest(manifestPath),
      source: `the default branch's ${manifestPath}`,
    },
  ]);
  const version = (await git(["show", `${sha}:VERSION`])).trim();
  const deployScript = await git(["show", `${sha}:${deployScriptPath}`]);
  // A Site guarding Composer packages (in any of those policies) checks them,
  // and their approval, at the release commit before anything is uploaded.
  // The server checks them again only with a deploy script gq sync rendered
  // for the same packages.
  if (guarded.length && !target) {
    throw new Error(
      `${guarded.join(", ")} ${guarded.length > 1 ? "are" : "is"} guarded, but no gq.ops.json names deployment.approval to look approvals up for; nothing was uploaded or deployed.`,
    );
  }
  const serverGuard = `GUARDED_PACKAGES="${guarded.join(" ")}"`;
  if (guarded.length && !deployScript.split("\n").includes(serverGuard)) {
    throw new Error(
      `${deployScriptPath} at ${sha.slice(0, 12)} doesn't verify ${guarded.join(", ")} after composer install (no ${serverGuard} line): run gq sync and commit it; nothing was uploaded or deployed.`,
    );
  }
  const { expectations = null, records = [] } = guarded.length
    ? await prepareGuardedRelease({
        project: ops.project,
        target,
        guarded,
        sha,
        show: (path) => git(["show", `${sha}:${path}`]),
        approvals,
        clock,
      })
    : {};
  const key = releaseKey(prefix, version, sha, expectations);
  // Fail before uploading anything if the registry login is missing.
  deployVariables("", context.env.COMPOSER_AUTH, { env: context.env });

  const ui = createReporter(io, interactive);
  const composerOnly = Boolean(parsed.composerOnly);
  ui.intro(
    `Ploi release · v${version} (${ref} @ ${sha.slice(0, 7)})${composerOnly ? " · Composer-only" : ""}`,
  );
  const step = ui.spinner();
  let result;
  let deployScriptUpdated;
  try {
    const r2 = createR2Client({
      accountId: ops.cloudflare.accountId,
      bucket,
      // In the CI Worker, R2_* are the CI SDK's snapshot credentials, so the
      // releases key is passed as RELEASES_R2_*.
      accessKeyId: context.env.RELEASES_R2_ACCESS_KEY_ID ?? context.env.R2_ACCESS_KEY_ID,
      secretAccessKey:
        context.env.RELEASES_R2_SECRET_ACCESS_KEY ?? context.env.R2_SECRET_ACCESS_KEY,
      fetch,
    });

    step.start(`Packing and uploading ${key}`);
    if (await r2.exists(key)) {
      step.message(`${key} is already in R2`);
    } else {
      await r2.put(key, await packArchive(git, { version, sha, ref, expectations }));
    }
    const archiveUrl = await r2.presignGet(key, 1800);

    const client = createPloiServerClient({
      token: context.env.PLOI_API_TOKEN,
      serverId: ops.ploi.serverId,
      fetch,
    });
    step.message(`Syncing the Ploi deploy script with ${deployScriptPath}`);
    deployScriptUpdated = await syncDeployScript(client, ops.ploi.siteId, deployScript);
    // The approval that let this release upload isn't permission to install:
    // run every deploy lookup again, fresh, right before the deploy request.
    if (records.length) {
      step.message("Revalidating the guarded packages' deploy approval");
      await revalidateGuardedRelease({
        project: ops.project,
        target,
        sha,
        records,
        approvals,
        clock,
      });
    }

    step.message("Deploying on Ploi (this can take a few minutes)");
    result = await deploy(client, ops.ploi.siteId, {
      project: ops.project,
      variables: deployVariables(archiveUrl, context.env.COMPOSER_AUTH, {
        composerOnly,
        env: context.env,
      }),
    });
  } catch (error) {
    step.error("Release failed");
    throw error;
  }

  let code = 1;
  if (!result) {
    step.error("No deploy result within 10 minutes; check the Ploi deploy log");
  } else if (result.status !== "success") {
    step.error("Deploy failed");
    ui.error(result.content.trim().split("\n").slice(-25).join("\n"));
  } else if (result.sha !== sha) {
    step.error(`Ploi deployed ${result.sha ?? "an unknown commit"}, expected ${sha}`);
  } else {
    step.stop(`Deployed v${version} (${sha.slice(0, 7)})`);
    code = 0;
  }
  if (deployScriptUpdated) ui.info(`Updated the Ploi deploy script from ${deployScriptPath}.`);
  ui.outro(code ? "Release not deployed." : `https://${ops.domains.admin}`);
  return code;
}

// git runs with run()'s own `env` (PATH and the like); secrets are read from
// the layered `context.env` and never reach a child process.
function gitRunner(exec, cwd, env) {
  return async (args) => {
    const result = await exec("git", args, { cwd, env });
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `exit ${result.code}`;
      throw new Error(`git ${args[0]} failed: ${detail}`);
    }
    return result.stdout;
  };
}

// The validated manifest at `manifestPath` in commit `sha`. A commit without
// one, or with one this gq can't validate, refuses.
async function requestedManifest(git, sha, manifestPath) {
  let text;
  try {
    text = await git(["show", `${sha}:${manifestPath}`]);
  } catch (error) {
    throw new Error(
      `Release ${sha.slice(0, 12)} has no ${manifestPath} (${error.message}); nothing was uploaded or deployed.`,

      { cause: error },
    );
  }
  try {
    return validateManifest(JSON.parse(text));
  } catch (error) {
    throw new Error(
      `Release ${sha.slice(0, 12)}'s ${manifestPath} can't be checked (${error.message}); nothing was uploaded or deployed.`,

      { cause: error },
    );
  }
}

async function defaultRef(git) {
  try {
    return (await git(["describe", "--exact-match", "--tags", "--match", "v*", "HEAD"])).trim();
  } catch {
    return "HEAD";
  }
}

// `exec` captures text, so git writes the (binary) archive to a scratch file.
async function packArchive(git, { version, sha, ref, expectations }) {
  const directory = await mkdtemp(join(tmpdir(), "gq-ploi-release-"));
  const output = join(directory, "release.tar.gz");
  try {
    await git([
      "archive",
      "--format=tar.gz",
      `--output=${output}`,
      `--add-virtual-file=RELEASE:${releaseManifest({ version, sha, ref })}`,
      ...(expectations ? [`--add-virtual-file=${SERVER_EXPECTATIONS_FILE}:${expectations}`] : []),
      sha,
      "--",
      ...shippedPaths,
    ]);
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
