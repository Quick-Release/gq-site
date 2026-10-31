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

// The release admission, with this Worker's code (deployed by `gq ci
// deploy`), never the tag's: an old tag carries its own scripts and gq, which
// may predate the Site's current deployment policy. It fetches the release
// tag and the default branch from Artifacts into a scratch repository (the
// token reaches each git call in its environment, never argv or an exported
// variable), reads gq.ops.json from both commits, and stops the release when
// either is offboarded or holds (paused, reserved), when either can't be
// read, when the tag doesn't point at `sha`, or when the default branch
// protects the Site or guards packages that the tagged commit doesn't (its
// gq wouldn't enforce them). See @getquick/site's
// docs/reference/deployment-policy.md.
export function admissionCommand(sha: string, tag: string): string {
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`Not a commit or tag object id: ${sha}`);
  if (!/^v[0-9][0-9A-Za-z._-]*$/u.test(tag)) throw new Error(`Not a release tag: ${tag}`);
  return [
    "set -eu",
    'work="$(mktemp -d)"',
    'current=""',
    'requested=""',
    // Git as the admission's alone: no system or global config (a runner's
    // ~/.gitconfig can't redirect ARTIFACTS_REMOTE with url.insteadOf), no
    // replacement objects; the scratch repository has no config of its own.
    "safe_git() {",
    '  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 git "$@"',
    "}",
    'case "${ARTIFACTS_REMOTE:-}" in https://*) proto=https ;; http://*) proto=http ;; *) proto=file ;; esac',
    // The token: a header scoped to exactly ARTIFACTS_REMOTE, no redirect
    // followed, only that remote's protocol, in the environment, never argv.
    "authed_git() {",
    '  GIT_CONFIG_COUNT=4 GIT_CONFIG_KEY_0="http.$ARTIFACTS_REMOTE.extraHeader" GIT_CONFIG_VALUE_0="Authorization: Bearer $ARTIFACTS_TOKEN" \\',
    "    GIT_CONFIG_KEY_1=http.followRedirects GIT_CONFIG_VALUE_1=false GIT_CONFIG_KEY_2=protocol.allow GIT_CONFIG_VALUE_2=never \\",
    '    GIT_CONFIG_KEY_3="protocol.$proto.allow" GIT_CONFIG_VALUE_3=always safe_git "$@"',
    "}",
    'if [ -n "${ARTIFACTS_REMOTE:-}" ] && [ -n "${ARTIFACTS_TOKEN:-}" ] && safe_git init -q "$work/repo"; then',
    '  branch="$(authed_git ls-remote --symref "$ARTIFACTS_REMOTE" HEAD 2>/dev/null | sed -n \'s#^ref: refs/heads/\\([^[:space:]]*\\)[[:space:]]*HEAD$#\\1#p\')" || branch=""',
    '  if [ -n "$branch" ] \\',
    '    && authed_git -C "$work/repo" fetch -q --depth=1 "$ARTIFACTS_REMOTE" "refs/heads/$branch" \\',
    '    && safe_git -C "$work/repo" show FETCH_HEAD:gq.ops.json >"$work/current.json"; then',
    '    current="$work/current.json"',
    "  fi",
    `  if authed_git -C "$work/repo" fetch -q --depth=1 "$ARTIFACTS_REMOTE" "refs/tags/${tag}" 2>/dev/null; then`,
    '    fetched="$(safe_git -C "$work/repo" rev-parse FETCH_HEAD)"',
    '    commit="$(safe_git -C "$work/repo" rev-parse "FETCH_HEAD^{commit}")"',
    `    if { [ "$fetched" = "${sha}" ] || [ "$commit" = "${sha}" ]; } \\`,
    '      && safe_git -C "$work/repo" show "$commit:gq.ops.json" >"$work/requested.json"; then',
    '      requested="$work/requested.json"',
    "    fi",
    "  fi",
    "fi",
    `node - "$current" "$requested" ${sha} <<'GQ_ADMISSION'`,
    ADMISSION_SCRIPT,
    "GQ_ADMISSION",
  ].join("\n");
}

const ADMISSION_SCRIPT = String.raw`const { readFileSync } = require("node:fs");
const [currentPath, requestedPath, sha] = process.argv.slice(2);
const short = sha.slice(0, 12);
const nothing = "Nothing was uploaded, synced or deployed.";
const refuse = (message) => {
  console.error(message);
  process.exit(1);
};
const read = (path, what) => {
  if (!path) {
    return refuse(
      what + " can't be read, so its deployment policy can't be checked: a release refuses without it. " + nothing,
    );
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return refuse(
      what + " can't be read, so its deployment policy can't be checked: a release refuses without it. " + nothing,
    );
  }
};
const current = read(currentPath, "The default branch's gq.ops.json");
const requested = read(requestedPath, "Release " + short + "'s gq.ops.json");
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
