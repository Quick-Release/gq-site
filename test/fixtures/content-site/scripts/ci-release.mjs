#!/usr/bin/env node

// The release step of Cloudflare CI (infra/ci/cloudflare.ci.ts): deploys the
// admin (`gq ploi release`) and then the frontend (Alchemy) for a v* tag. Prints
// its environment first (names, never values) so a failure is diagnosable
// from the step output alone.
//
//   node scripts/ci-release.mjs --ref <sha>

import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const required = [
  "PLOI_API_TOKEN",
  "RELEASES_R2_ACCESS_KEY_ID",
  "RELEASES_R2_SECRET_ACCESS_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "COMPOSER_AUTH",
];

// The Frontend's own secrets: its deploy binds them when set and warns when
// not (a site without a publication store or consent records has none).
const optional = [
  "FRONTEND_REFRESH_TOKEN",
  "PUBLICATION_EVENT_SECRET",
  "CONSENT_READ_TOKEN",
  "GQ_PREVIEW_CMS_USERNAME",
  "GQ_PREVIEW_CMS_APPLICATION_PASSWORD",
  "GQ_PREVIEW_ACCESS_CLIENT_ID",
  "GQ_PREVIEW_ACCESS_CLIENT_SECRET",
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_SITE_KEY",
  "GQ_FORMS_ACCESS_CLIENT_ID",
  "GQ_FORMS_ACCESS_CLIENT_SECRET",
];

export function missingEnvironment(environment) {
  return required.filter((name) => !environment[name]);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return (result.stdout || result.stderr || `exit ${result.status}`).trim();
}

function isGitRepository(directory) {
  return (
    spawnSync("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" })
      .status === 0
  );
}

// The rules every git call that carries ARTIFACTS_TOKEN follows, the same as
// the CI Worker's admission (infra/ci/release.ts) and gq's own CI policy read
// (@getquick/site's src/ploi/trusted-git.mjs); see @getquick/site's
// docs/reference/deployment-policy.md.
//
// ARTIFACTS_REMOTE: https to a DNS name (two or more dot-separated labels of
// letters, digits and inner hyphens, the last starting with a letter, so no IP
// address; no trailing dot, port or credentials), or plain http to 127.0.0.1
// only, any port (tests); then a path of one or more segments of letters,
// digits, ".", "_", "~" and "-", none starting with "." (no "." or ".."
// segment), and no "%"-escape, query or fragment. "https", "http" or null.
export function authoritativeScheme(remote) {
  if (typeof remote !== "string") return null;
  if (
    /^https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/u.test(
      remote,
    )
  )
    return "https";
  if (
    /^http:\/\/127\.0\.0\.1(?::[1-9][0-9]{0,4})?(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/u.test(
      remote,
    )
  )
    return "http";
  return null;
}

// The system git (never PATH's): the first executable of these.
const TRUSTED_GIT_LOCATIONS = [
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
  "/home/linuxbrew/.linuxbrew/bin/git",
];

function trustedGit() {
  for (const location of TRUSTED_GIT_LOCATIONS) {
    try {
      accessSync(location, constants.X_OK);
      return realpathSync(location);
    } catch {
      // Not here.
    }
  }
  throw new Error(
    `No git at ${TRUSTED_GIT_LOCATIONS.join(", ")}: the release source is only fetched with a system git, not one found on PATH.`,
  );
}

// Git's configuration, in its command-line scope (above any repository's): no
// hook or fsmonitor, no bare repository that isn't named with --git-dir, no
// transport; the fetch adds only the remote's own protocol, no redirects, and
// the token as a header git sends to exactly ARTIFACTS_REMOTE.
const OFFLINE_CONFIG = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["safe.bareRepository", "explicit"],
  ["protocol.allow", "never"],
];

const networkConfig = (scheme, remote, token) => [
  ...OFFLINE_CONFIG,
  ["http.followRedirects", "false"],
  [`protocol.${scheme}.allow`, "always"],
  [`http.${remote}.extraHeader`, `Authorization: Bearer ${token}`],
];

// A git call's environment, built from nothing (none of the step's variables,
// its deploy secrets included): PATH limited to git's directory and the
// system's, HOME and the user from the user database, no system or global
// config, no replacement objects, no prompts, GIT_CEILING_DIRECTORIES at the
// parent of `scratch` (the call's cwd), and `config`.
export function sourceGitEnvironment(git, scratch, config, user = userInfo()) {
  return {
    PATH: `${dirname(git)}:/usr/bin:/bin`,
    HOME: user.homedir,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    USER: user.username,
    LOGNAME: user.username,
    GIT_CEILING_DIRECTORIES: dirname(scratch),
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  };
}

// CI's /workspace is a copy of the checkout without .git, so fetch the release
// commit `ref` (the tag's object id) from Artifacts (ARTIFACTS_REMOTE /
// ARTIFACTS_TOKEN come from the step's sourceControlCredentials) into
// `directory`, a repository made for it, for `gq ploi release --git-dir`: its
// origin names ARTIFACTS_REMOTE, which gq's own policy read requires. The
// directory must not exist yet (one a step before this one made would bring
// its own repository config). Every git call names its repository with
// --git-dir and runs in `directory`, never in the workspace, so no repository
// is found from the workspace. The token reaches only the fetch, in its
// environment, never argv, a URL or a file. `spawn` is for tests.
export function fetchSource(
  ref,
  environment,
  directory = "/tmp/release-source",
  spawn = spawnSync,
) {
  const { ARTIFACTS_REMOTE: remote, ARTIFACTS_TOKEN: token } = environment;
  if (!remote || !token) {
    throw new Error("No git repository here and no ARTIFACTS_REMOTE/ARTIFACTS_TOKEN to fetch one.");
  }
  const scheme = authoritativeScheme(remote);
  if (!scheme) {
    throw new Error(
      "ARTIFACTS_REMOTE isn't an https URL the release source is fetched from (plain http only to 127.0.0.1, for tests).",
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(ref)) throw new Error(`Not a commit or tag object id: ${ref}`);
  const git = trustedGit();
  try {
    mkdirSync(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `${directory} already exists: the release source is fetched into a fresh directory.`,
    );
  }
  const gitDir = join(directory, ".git");
  const steps = [
    [["init", "--quiet"], OFFLINE_CONFIG],
    [["remote", "add", "origin", remote], OFFLINE_CONFIG],
    [
      ["fetch", "--quiet", "--no-tags", "--depth=1", remote, ref],
      networkConfig(scheme, remote, token),
    ],
  ];
  for (const [args, config] of steps) {
    const result = spawn(git, ["--git-dir", gitDir, ...args], {
      cwd: directory,
      env: sourceGitEnvironment(git, directory, config),
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  }
  return directory;
}

function run(label, command, args, env = process.env) {
  console.log(`\n=== ${label}: ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) {
    console.error(`${label} could not start: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) console.error(`${label} failed with exit code ${result.status}`);
  return result.status ?? 1;
}

// An offboarded Site (gq offboard) is never released: the release would
// deploy its CMS and attach its Frontend's domain again.
function refuseOffboarded(ops) {
  if (ops.offboarded) {
    throw new Error(
      `${ops.project} is offboarded (gq.ops.json offboarded): a release would expose it again. If the Site is coming back, run gq offboard --restore first.`,
    );
  }
}

// A protected Site (gq.ops.json deployment) is released only while its
// deployment.state is "authorized": a paused or reserved one refuses before
// the CMS or the Frontend deploys. gq ploi release refuses the same way;
// a reviewed Site change lifts the deployment hold, never a flag.
export function deploymentRefusal(ops) {
  const policy = ops.deployment;
  if (!policy || policy.state === "authorized") return null;
  const who = policy.state === "reserved" ? ` is reserved by ${policy.holder}` : " is paused";
  return (
    `${ops.project}${who} (gq.ops.json deployment.state: ${policy.state}): ${policy.reason}. ` +
    "Nothing was uploaded, synced or deployed. " +
    'A reviewed Site change that sets deployment.state to "authorized" lifts the deployment hold.'
  );
}

function main(arguments_) {
  const ops = JSON.parse(readFileSync(new URL("../gq.ops.json", import.meta.url), "utf8"));
  refuseOffboarded(ops);
  const held = deploymentRefusal(ops);
  if (held) throw new Error(held);
  const index = arguments_.indexOf("--ref");
  const ref = index === -1 ? null : arguments_[index + 1];
  if (!ref) throw new Error("Usage: ci-release.mjs --ref <sha>");

  console.log("=== environment");
  console.log(`node ${process.version}; ${capture("git", ["--version"])}; cwd ${process.cwd()}`);
  for (const name of required) console.log(`${name}: ${process.env[name] ? "set" : "MISSING"}`);
  for (const name of optional) console.log(`${name}: ${process.env[name] ? "set" : "not set"}`);
  const missing = missingEnvironment(process.env);
  if (missing.length > 0) throw new Error(`Missing environment: ${missing.join(", ")}`);

  // In CI (the step's source control credentials set) the release source is
  // always the commit fetched from ARTIFACTS_REMOTE, never a repository found
  // from the workspace, which the tag's own steps could have shaped as one.
  const inCi = Boolean(process.env.ARTIFACTS_REMOTE || process.env.ARTIFACTS_TOKEN);
  const fetched = inCi || !isGitRepository(process.cwd());
  const gitDir = fetched ? fetchSource(ref, process.env) : process.cwd();
  console.log(`release source: ${gitDir}`);
  const resolve = ["rev-parse", `${ref}^{commit}`];
  let commit;
  if (fetched) {
    // The fetched source, read with the same isolated git the fetch used.
    const git = trustedGit();
    commit = capture(git, ["--git-dir", join(gitDir, ".git"), ...resolve], {
      cwd: gitDir,
      env: sourceGitEnvironment(git, gitDir, OFFLINE_CONFIG),
    });
  } else {
    commit = capture("git", ["-C", gitDir, ...resolve]);
  }
  console.log(`ref ${ref} → commit ${commit}`);

  // gq ploi release reads the default branch's current policy only from
  // ARTIFACTS_REMOTE (which the release source's origin must name), in a
  // repository of its own, ARTIFACTS_TOKEN in a header scoped to that URL.
  let admin;
  try {
    admin = run("admin", "pnpm", [
      "exec",
      "gq",
      "ploi",
      "release",
      "--ref",
      ref,
      "--git-dir",
      gitDir,
    ]);
  } finally {
    if (fetched) rmSync(gitDir, { recursive: true, force: true });
  }
  if (admin !== 0) return admin;
  // The Frontend's deploy needs no source control credentials.
  const { ARTIFACTS_TOKEN, ARTIFACTS_REMOTE, ...frontendEnv } = process.env;
  void ARTIFACTS_TOKEN;
  void ARTIFACTS_REMOTE;
  return run("frontend", "pnpm", ["run", "deploy:frontend:raw"], frontendEnv);
}

if (process.argv[1]?.endsWith("ci-release.mjs")) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
