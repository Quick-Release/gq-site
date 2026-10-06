// Git access to the site's Cloudflare Artifacts repository (gq.ops.json
// `artifacts`). A site on GitHub (gq.ops.json
// `github.repository`) pushes to GitHub only: the CI Worker mirrors GitHub
// pushes into Artifacts, and that starts CI. Artifacts stays readable from a
// clone, e.g. to check what CI sees:
//
//   gq git artifacts setup   # register the credential helper; drop the
//                            # Artifacts push URL older setups added to origin
//   git ls-remote https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git
//
// An Artifacts-only site (no `github.repository`) keeps its code in Artifacts:
// `setup` makes the Artifacts repository `origin` too, and pushes to it start
// CI directly.
//
// As a git credential helper (`get`), it mints a repo-scoped token that
// expires in an hour, using ARTIFACTS_API_TOKEN from Sigillo `staging` (the
// helper runs through `gq sigillo run`): read-only for a site on GitHub, read
// and write for an Artifacts-only one. Nothing is stored in .git/config or
// on disk; `store`/`erase` are no-ops.

import { text } from "node:stream/consumers";
import { join } from "node:path";

import { artifactsRemoteUrl, createArtifactsClient } from "../cloudflare/account-client.mjs";

function artifactsConfig(context) {
  const accountId = context.config.cloudflare?.accountId;
  const { namespace, repo } = context.config.artifacts ?? {};
  if (!accountId || !namespace || !repo) {
    throw new Error("gq.ops.json cloudflare.accountId and artifacts.namespace/repo are required.");
  }
  return { accountId, namespace, repo };
}

// A site without gq.ops.json `github.repository` keeps its code in Artifacts.
export function isArtifactsOnly(config) {
  return !config.github?.repository;
}

// The helper command git runs (it appends get/store/erase): the site's own
// gq, under `gq sigillo run staging`.
export function helperCommand(projectRoot) {
  const gq = JSON.stringify(join(projectRoot, "node_modules", ".bin", "gq"));
  return `!${gq} sigillo run staging -- ${gq} git artifacts`;
}

function gitRunner(exec, cwd, env) {
  return async (args) => {
    const result = await exec("git", args, { cwd, env });
    if (result.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.code}`);
    }
    return result.stdout.trim();
  };
}

// `gq git artifacts setup`. Resolves to an exit code.
export async function runArtifactsSetup({ context, env, exec, io }) {
  const remote = artifactsRemoteUrl(artifactsConfig(context));
  const host = new URL(remote).origin;
  const git = gitRunner(exec, context.projectRoot, env);
  // An empty helper first resets the list for this host, so global helpers
  // (e.g. macOS osxkeychain) neither answer with nor store expired tokens.
  const helperKey = `credential.${host}.helper`;
  await git(["config", "--local", "--unset-all", helperKey]).catch(() => {
    // Not configured yet.
  });
  await git(["config", "--local", "--add", helperKey, ""]);
  await git(["config", "--local", "--add", helperKey, helperCommand(context.projectRoot)]);

  if (isArtifactsOnly(context.config)) return artifactsOrigin({ git, remote, io });

  // Older setups made origin push to GitHub and Artifacts; the mirror now
  // does the latter, and a second push URL would run the pre-push hook twice.
  const pushUrls = (await git(["remote", "get-url", "--push", "--all", "origin"])).split("\n");
  if (pushUrls.includes(remote)) {
    await git(["config", "--local", "--unset-all", "remote.origin.pushurl"]);
    const fetchUrl = await git(["remote", "get-url", "origin"]);
    for (const url of pushUrls.filter((url) => url !== remote && url !== fetchUrl)) {
      await git(["remote", "set-url", "--add", "--push", "origin", url]);
    }
  }
  io.out(`Credential helper registered for ${host}`);
  const pushes = await git(["remote", "get-url", "--push", "--all", "origin"]);
  io.out(`origin pushes to: ${pushes.split("\n").join(", ")}`);
  return 0;
}

// An Artifacts-only site: origin is the Artifacts repository. A missing origin
// is added; one pointing elsewhere is left alone and reported, since pushes
// there would start no CI.
async function artifactsOrigin({ git, remote, io }) {
  const origin = await git(["remote", "get-url", "origin"]).catch(() => undefined);
  if (origin === undefined) {
    await git(["remote", "add", "origin", remote]);
    io.out(`Added origin: ${remote}`);
  } else if (origin !== remote) {
    io.err(
      `origin is ${origin}, not the Artifacts repository ${remote}. This site has no ` +
        "gq.ops.json github.repository, so only pushes to Artifacts start CI: " +
        `run git remote set-url origin ${remote}`,
    );
    return 1;
  }
  const pushes = await git(["remote", "get-url", "--push", "--all", "origin"]);
  io.out(`origin pushes to: ${pushes.split("\n").join(", ")}`);
  return 0;
}

// `gq git artifacts get|store|erase`, as git's credential helper: answers
// `get` for the Artifacts host only. Resolves to an exit code.
export async function runArtifactsCredential({ context, parsed, stdin, fetch, io }) {
  if (parsed.command[2] !== "get") return 0;
  if (!stdin) throw new Error("run() was called without stdin, and this command needs it.");
  const input = await text(stdin);
  const ops = artifactsConfig(context);
  const host = /^host=(.*)$/mu.exec(input)?.[1];
  // Not ours: let git try other helpers.
  if (host !== new URL(artifactsRemoteUrl(ops)).host) return 0;

  const token = context.env.ARTIFACTS_API_TOKEN;
  if (!token) {
    throw new Error("ARTIFACTS_API_TOKEN is missing; create it with gq cloudflare ci.");
  }
  const client = createArtifactsClient({ accountId: ops.accountId, token, fetch });
  const password = await client.createGitToken(ops.namespace, ops.repo, {
    scope: isArtifactsOnly(context.config) ? "write" : "read",
    ttl: 3600,
  });
  io.stdout.write(`username=x\npassword=${password}\n`);
  return 0;
}
