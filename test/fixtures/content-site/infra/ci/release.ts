// A v* tag (what `pnpm push <major|minor|fix>` pushes) is a release.
export function isRelease(params: { trigger: "push" | "tag"; tag?: string }): boolean {
  return params.trigger === "tag" && /^v\d/u.test(params.tag ?? "");
}

// A runner step's options, as the CI Worker passes them to its runners.
export type Step = { name: string; command: string; [option: string]: unknown };
// Where a step runs: a fresh runner, the fresh runner whose workspace the
// later steps share ("install"), or that workspace.
export type Placed = { on: "fresh" | "install" | "workspace"; step: Step };

// The CI Worker's steps, in order. A release starts with the admission
// (admissionCommand), alone in a fresh runner with only git and node from the
// CI image, before anything the tag controls is installed, run or given a
// secret; the release step admits again first, in case the policy changed
// since. A release that isn't admitted stops there.
export function ciSteps(
  params: { trigger: "push" | "tag"; tag?: string; sha: string },
  steps: { install: Step; verify: Step; release: Step },
): Placed[] {
  if (!isRelease(params)) {
    return [
      { on: "install", step: steps.install },
      { on: "workspace", step: steps.verify },
    ];
  }
  const admission = admissionCommand(params.sha, params.tag ?? "");
  return [
    {
      on: "fresh",
      step: { name: "admission", command: admission, sourceControlCredentials: true },
    },
    { on: "install", step: steps.install },
    { on: "workspace", step: steps.verify },
    {
      on: "workspace",
      step: { ...steps.release, command: `${admission}\n${steps.release.command}` },
    },
  ];
}

// A runner the CI SDK gives (ci.runner, workspace.runner): each step runs in
// one, and a fresh one's workspace can run the steps after it.
export type Runner = { runner(step: Step): Promise<Runner> };

// Runs `placed` (ciSteps') in order: "fresh" and "install" steps in a fresh
// runner from `ci`, keeping the install step's workspace, and "workspace"
// steps in that workspace. Both CI Worker templates run their steps through
// this, so the admission is in its own fresh runner before any workspace
// exists.
export async function runSteps(ci: Runner, placed: Placed[]): Promise<void> {
  let workspace: Runner | undefined;
  for (const { on, step } of placed) {
    if (on === "workspace") {
      if (!workspace) throw new Error(`${step.name} needs the install step's workspace`);
      await workspace.runner(step);
    } else {
      const runner = await ci.runner(step);
      if (on === "install") workspace = runner;
    }
  }
}

// The URLs a CI read may use for ARTIFACTS_REMOTE, and the scheme each
// allows: https to a DNS name (two or more dot-separated labels of letters,
// digits and inner hyphens, the last starting with a letter, so no IP
// address; no trailing dot, port or credentials), or plain http to 127.0.0.1
// only, any port (tests); then a path of one or more segments of letters,
// digits, ".", "_", "~" and "-", none starting with "." (no "." or ".."
// segment), and no "%"-escape, query or fragment. The admission uses these
// two expressions; @getquick/site's gq (src/ploi/trusted-git.mjs) and the
// release step's source fetch (scripts/ci-release.mjs) use the same ones.
const HTTPS_REMOTE =
  /^https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/u;
const HTTP_REMOTE =
  /^http:\/\/127\.0\.0\.1(?::[1-9][0-9]{0,4})?(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/u;

// "https" or "http" when the admission reads from `remote`, else null.
export function authoritativeScheme(remote: unknown): "https" | "http" | null {
  if (typeof remote !== "string") return null;
  if (HTTPS_REMOTE.test(remote)) return "https";
  if (HTTP_REMOTE.test(remote)) return "http";
  return null;
}

// The release admission, with this Worker's code (deployed by `gq ci
// deploy`), never the tag's: an old tag carries its own scripts and gq, which
// may predate the Site's current deployment policy. It fetches the release
// tag and the default branch from Artifacts into a scratch repository of its
// own, reads gq.ops.json from both commits, and stops the release when either
// is offboarded or holds (paused, reserved), when either can't be read, when
// the tag doesn't point at `sha`, or when the default branch protects the Site
// or guards packages that the tagged commit doesn't (its gq wouldn't enforce
// them). It runs in the tag's workspace (the fresh runner's restored copy, and
// again in the release step after the tag's own steps), so none of its git
// calls run there or may find a repository there: see ADMISSION_SCRIPT. See
// @getquick/site's docs/reference/deployment-policy.md.
export function admissionCommand(sha: string, tag: string): string {
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`Not a commit or tag object id: ${sha}`);
  if (!/^v[0-9][0-9A-Za-z._-]*$/u.test(tag)) throw new Error(`Not a release tag: ${tag}`);
  return [
    "set -eu",
    `node - ${sha} ${tag} <<'GQ_ADMISSION'`,
    ADMISSION_SCRIPT,
    "GQ_ADMISSION",
  ].join("\n");
}

// The admission itself (node, CommonJS, node's own modules only). Its git is
// the system's (the first executable of the locations below, never PATH's),
// with an environment built from nothing: PATH limited to git's directory and
// the system's, HOME and the user from the user database, no system or global
// config, no replacement objects, no prompts, none of the step's variables
// (its secrets included). Every call names the scratch repository with
// --git-dir and runs in the scratch directory (the repository itself), with
// GIT_CEILING_DIRECTORIES at its parent and safe.bareRepository=explicit, so
// no repository is ever found from the tag's workspace (a tag can commit a
// HEAD, config, objects and refs at its root) or above the scratch directory:
// no url.insteadOf, include, credential or protocol setting of a workspace can
// redirect a read. Hooks and fsmonitor are off and no transport is allowed,
// except for ls-remote and fetch: only ARTIFACTS_REMOTE's own protocol, no
// redirects, and ARTIFACTS_TOKEN as a header scoped to exactly that URL, in
// those calls' environment alone, never argv or a file. ARTIFACTS_REMOTE must
// be a URL authoritativeScheme accepts. The scratch directory is removed
// before the admission's verdict, whatever it is.
const ADMISSION_SCRIPT = String.raw`const { spawnSync } = require("node:child_process");
const { accessSync, constants, mkdtempSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir, userInfo } = require("node:os");
const { dirname, join } = require("node:path");
const [sha, tag] = process.argv.slice(2);
const short = sha.slice(0, 12);
const nothing = "Nothing was uploaded, synced or deployed.";
const remote = process.env.ARTIFACTS_REMOTE || "";
const token = process.env.ARTIFACTS_TOKEN || "";
const refuse = (message) => {
  console.error(message);
  process.exit(1);
};
const scheme = (() => {
  if (/${HTTPS_REMOTE.source}/u.test(remote)) return "https";
  if (/${HTTP_REMOTE.source}/u.test(remote)) return "http";
  return null;
})();
const LOCATIONS = ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/home/linuxbrew/.linuxbrew/bin/git"];
const git = (() => {
  for (const location of LOCATIONS) {
    try {
      accessSync(location, constants.X_OK);
      return realpathSync(location);
    } catch {
      // Not here.
    }
  }
  return null;
})();
const OFFLINE = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["safe.bareRepository", "explicit"],
  ["protocol.allow", "never"],
];
const NETWORK = [
  ...OFFLINE,
  ["http.followRedirects", "false"],
  ["protocol." + scheme + ".allow", "always"],
  ["http." + remote + ".extraHeader", "Authorization: Bearer " + token],
];
// Both policies' texts ({ text } or { error }), read in a scratch
// repository removed before this returns; or { refusal }.
const read = () => {
  if (!remote || !token) {
    return {
      refusal:
        "The admission reads the deployment policy with ARTIFACTS_REMOTE and ARTIFACTS_TOKEN (the step's source control credentials), and this step has " +
        (remote ? "no ARTIFACTS_TOKEN" : "no ARTIFACTS_REMOTE") + ": a release refuses without them. " + nothing,
    };
  }
  if (!scheme) {
    return {
      refusal:
        "ARTIFACTS_REMOTE isn't an https URL the admission reads the deployment policy from (plain http only to 127.0.0.1, for tests), so the release refuses. " +
        nothing,
    };
  }
  if (!git) {
    return {
      refusal:
        "No git at " + LOCATIONS.join(", ") +
        ": the deployment policy is only read with a system git, not one found on PATH. " + nothing,
    };
  }
  let user;
  try {
    user = userInfo();
  } catch {
    return { refusal: "The admission's user isn't in the user database, so its git can't run: a release refuses. " + nothing };
  }
  const { homedir, username } = user;
  const scratch = mkdtempSync(join(tmpdir(), "gq-admission-"));
  const run = (args, config) => {
    const env = {
      PATH: dirname(git) + ":/usr/bin:/bin",
      HOME: homedir,
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      USER: username,
      LOGNAME: username,
      GIT_CEILING_DIRECTORIES: dirname(scratch),
      GIT_CONFIG_COUNT: String(config.length),
    };
    config.forEach(([key, value], index) => {
      env["GIT_CONFIG_KEY_" + index] = key;
      env["GIT_CONFIG_VALUE_" + index] = value;
    });
    const result = spawnSync(git, ["--git-dir", scratch, ...args], {
      cwd: scratch,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      const detail = String(result.stderr || "").trim().split("\n").pop() || "exit " + result.status;
      throw new Error("git " + args[0] + " failed: " + detail.split(token).join("…"));
    }
    return result.stdout;
  };
  try {
    run(["init", "--bare", "--quiet"], OFFLINE);
    let current;
    try {
      const head = run(["ls-remote", "--symref", remote, "HEAD"], NETWORK);
      const branch = (/^ref: refs\/heads\/(\S+)\tHEAD$/mu.exec(head) || [])[1];
      if (!branch) throw new Error("the remote names no default branch");
      run(["fetch", "--quiet", "--no-tags", "--depth=1", remote, "refs/heads/" + branch], NETWORK);
      current = { text: run(["show", "FETCH_HEAD:gq.ops.json"], OFFLINE) };
    } catch (error) {
      current = { error: error.message };
    }
    let requested;
    try {
      run(["fetch", "--quiet", "--no-tags", "--depth=1", remote, "refs/tags/" + tag], NETWORK);
      const fetched = run(["rev-parse", "FETCH_HEAD"], OFFLINE).trim();
      const commit = run(["rev-parse", "FETCH_HEAD^{commit}"], OFFLINE).trim();
      if (fetched !== sha && commit !== sha) {
        throw new Error("refs/tags/" + tag + " is " + fetched.slice(0, 12) + ", not " + short);
      }
      requested = { text: run(["show", commit + ":gq.ops.json"], OFFLINE) };
    } catch (error) {
      requested = { error: error.message };
    }
    return { current, requested };
  } catch (error) {
    return { current: { error: error.message }, requested: { error: error.message } };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
const policies = read();
if (policies.refusal) refuse(policies.refusal);
const parse = (policy, what) => {
  const unreadable = (detail) =>
    refuse(
      what + " can't be read (" + detail + "), so its deployment policy can't be checked: a release refuses without it. " + nothing,
    );
  if (policy.error !== undefined) return unreadable(policy.error);
  try {
    return JSON.parse(policy.text);
  } catch {
    return unreadable("not JSON");
  }
};
const current = parse(policies.current, "The default branch's gq.ops.json");
const requested = parse(policies.requested, "Release " + short + "'s gq.ops.json");
for (const [ops, source] of [
  [current, "the default branch's gq.ops.json"],
  [requested, "release " + short + "'s gq.ops.json"],
]) {
  if (ops.offboarded) {
    refuse(ops.project + " is offboarded (" + source + " offboarded): a release would expose it again. " + nothing);
  }
  const policy = ops.deployment;
  if (policy && policy.state !== "authorized") {
    const who = policy.state === "reserved" ? " is reserved by " + policy.holder : " is paused";
    refuse(
      ops.project + who + " (" + source + " deployment.state: " + policy.state + "): " + policy.reason + ". " +
        nothing + ' A reviewed Site change that sets deployment.state to "authorized" lifts the deployment hold.',
    );
  }
}
const guarded = (current.deployment && current.deployment.guardedPackages) || [];
const carried = (requested.deployment && requested.deployment.guardedPackages) || [];
const missing = guarded.filter((name) => !carried.includes(name));
if ((current.deployment && !requested.deployment) || missing.length > 0) {
  refuse(
    "Release " + short + " predates the default branch's deployment policy" +
      (missing.length > 0 ? " (it doesn't guard " + missing.join(", ") + ")" : "") +
      ": its own scripts and gq wouldn't enforce it. " + nothing +
      " Release a commit that carries the current gq.ops.json deployment block.",
  );
}
console.log("Release " + short + " admitted by the default branch's and its own deployment policy.");`;
