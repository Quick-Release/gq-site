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

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createR2Client } from "../r2.mjs";
import { createReporter } from "../cli/reporter.mjs";
import { deploy, syncDeployScript } from "./provision.mjs";
import { createPloiServerClient } from "./server-client.mjs";

// Layout: what the archive ships. The site's deploy script must expect the
// same paths (deploy/ploi/admin.sh SHIPPED_PATHS).
export const shippedPaths = Object.freeze(["apps/cms", "deploy/ploi"]);

// The server's `composer install` fetches the GETQUICK plugins from the
// private registry. The login comes from the secret store and reaches the
// deploy script as the deploy variable composer_auth → $COMPOSER_AUTH, for
// that one deploy; nothing stores it on the server.
export function deployVariables(archiveUrl, composerAuth) {
  if (!composerAuth) {
    throw new Error(
      "COMPOSER_AUTH is missing: run this through gq sigillo run (or CI), which injects the registry login.",
    );
  }
  return { archive_url: archiveUrl, composer_auth: composerAuth };
}

export function releaseKey(prefix, version, sha) {
  return `${prefix}v${version}-${sha.slice(0, 12)}.tar.gz`;
}

export function releaseManifest({ version, sha, ref }) {
  return `version=${version}\ncommit=${sha}\nref=${ref}\n`;
}

// `gq ploi release [--ref <ref>] [--git-dir <dir>]`. Resolves to an exit code.
export async function runRelease({ context, parsed, env, fetch, exec, io, interactive }) {
  const ops = context.config;
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
  const git = gitRunner(exec, gitDir ?? context.projectRoot, env);
  const ref = parsed.ref ?? (await defaultRef(git));
  const sha = (await git(["rev-parse", `${ref}^{commit}`])).trim();
  const version = (await git(["show", `${sha}:VERSION`])).trim();
  const key = releaseKey(prefix, version, sha);
  const deployScript = await git(["show", `${sha}:${deployScriptPath}`]);
  // Fail before uploading anything if the registry login is missing.
  deployVariables("", context.env.COMPOSER_AUTH);

  const ui = createReporter(io, interactive);
  ui.intro(`Ploi release · v${version} (${ref} @ ${sha.slice(0, 7)})`);
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
      await r2.put(key, await packArchive(git, { version, sha, ref }));
    }
    const archiveUrl = await r2.presignGet(key, 1800);

    const client = createPloiServerClient({
      token: context.env.PLOI_API_TOKEN,
      serverId: ops.ploi.serverId,
      fetch,
    });
    step.message(`Syncing the Ploi deploy script with ${deployScriptPath}`);
    deployScriptUpdated = await syncDeployScript(client, ops.ploi.siteId, deployScript);

    step.message("Deploying on Ploi (this can take a few minutes)");
    result = await deploy(client, ops.ploi.siteId, {
      project: ops.project,
      variables: deployVariables(archiveUrl, context.env.COMPOSER_AUTH),
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

async function defaultRef(git) {
  try {
    return (await git(["describe", "--exact-match", "--tags", "--match", "v*", "HEAD"])).trim();
  } catch {
    return "HEAD";
  }
}

// `exec` captures text, so git writes the (binary) archive to a scratch file.
async function packArchive(git, { version, sha, ref }) {
  const directory = await mkdtemp(join(tmpdir(), "gq-ploi-release-"));
  const output = join(directory, "release.tar.gz");
  try {
    await git([
      "archive",
      "--format=tar.gz",
      `--output=${output}`,
      `--add-virtual-file=RELEASE:${releaseManifest({ version, sha, ref })}`,
      sha,
      "--",
      ...shippedPaths,
    ]);
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
