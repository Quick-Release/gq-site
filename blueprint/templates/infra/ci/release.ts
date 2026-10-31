// A v* tag (what `pnpm push <major|minor|fix>` pushes) is a release.
export function isRelease(params: { trigger: "push" | "tag"; tag?: string }): boolean {
  return params.trigger === "tag" && /^v\d/u.test(params.tag ?? "");
}

// The release admission the CI Worker runs before the release step's own
// scripts, with this Worker's code (deployed by `gq ci deploy`), not the
// tagged workspace's: an old tag runs its own scripts/ci-release.mjs and gq,
// which may predate the Site's current deployment policy. It reads the
// default branch's gq.ops.json from Artifacts (with the step's
// sourceControlCredentials) and the release commit's from the workspace, and
// stops the release when either is offboarded or holds (paused, reserved),
// when the default branch's can't be read, or when the default branch
// protects the Site or guards packages that the release commit's doesn't
// (its gq wouldn't enforce them). Uses only git and node from the CI image.
// See @getquick/site's docs/reference/deployment-policy.md.
export function admissionCommand(sha: string): string {
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`Not a commit or tag object id: ${sha}`);
  return [
    "set -eu",
    'work="$(mktemp -d)"',
    'current=""',
    'if [ -n "${ARTIFACTS_REMOTE:-}" ] && [ -n "${ARTIFACTS_TOKEN:-}" ]; then',
    "  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader",
    '  export GIT_CONFIG_VALUE_0="Authorization: Bearer $ARTIFACTS_TOKEN"',
    '  branch="$(git ls-remote --symref "$ARTIFACTS_REMOTE" HEAD 2>/dev/null | sed -n \'s#^ref: refs/heads/\\([^[:space:]]*\\)[[:space:]]*HEAD$#\\1#p\')" || branch=""',
    '  if [ -n "$branch" ] && git init -q "$work/repo" \\',
    '    && git -C "$work/repo" fetch -q --depth=1 "$ARTIFACTS_REMOTE" "refs/heads/$branch" \\',
    '    && git -C "$work/repo" show FETCH_HEAD:gq.ops.json >"$work/current.json"; then',
    '    current="$work/current.json"',
    "  fi",
    "fi",
    `node - "$current" gq.ops.json ${sha} <<'GQ_ADMISSION'`,
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
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return refuse(
      what + " can't be read, so its deployment policy can't be checked: a release refuses without it. " + nothing,
    );
  }
};
if (!currentPath) {
  refuse(
    "The default branch's gq.ops.json can't be read, so its current deployment policy can't be checked: a release refuses without it. " + nothing,
  );
}
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
        nothing + ' A reviewed Site change that sets deployment.state to "authorized" lifts the hold.',
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
