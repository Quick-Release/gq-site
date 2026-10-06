// GitHub side of the CI, for a site on GitHub (gq.ops.json
// `github.repository`): GitHub stays the home of the code, issues and PRs;
// its pushes reach the Artifacts repository through the mirror Workflow
// (mirror.ts), and CI results go back as commit statuses. An Artifacts-only
// site uses none of it. Plain functions (no Workers-only imports) so Node can
// test them (scripts/ci.test.mjs).

const encoder = new TextEncoder();

// Verifies GitHub's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body).
export async function verifySignature(
  secret: string,
  body: string,
  header: string | null,
): Promise<boolean> {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return constantTimeEqual(expected, header.slice("sha256=".length));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export type MirrorParams = { ref: string };

// A branch or tag push (including deletions) to the configured repository;
// null for anything else, which the webhook acknowledges and ignores.
export function parsePushEvent(body: string, repository: string): MirrorParams | null {
  const event = JSON.parse(body) as { ref?: unknown; repository?: { full_name?: unknown } };
  if (!repository || event.repository?.full_name !== repository) return null;
  if (typeof event.ref !== "string" || !/^refs\/(heads|tags)\/[^\s:]+$/u.test(event.ref)) {
    return null;
  }
  return { ref: event.ref };
}

// Mirrors one ref from GitHub to Artifacts as GitHub has it *now* (not as the
// webhook saw it), so out-of-order or retried deliveries still converge on
// GitHub's state: force-push when the ref exists, delete it when it doesn't.
// Credentials arrive as environment variables, never in the command.
export const mirrorScript = String.raw`set -eu
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
git init -q --bare "$dir"
github() { git -C "$dir" -c http.extraHeader="Authorization: Basic $GITHUB_AUTH" "$@"; }
artifacts() { git -C "$dir" -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" "$@"; }
status=0
github ls-remote --exit-code "$GITHUB_REMOTE" "$REF" >/dev/null || status=$?
if [ "$status" -eq 0 ]; then
  github fetch -q "$GITHUB_REMOTE" "+$REF:$REF"
  artifacts push --force "$ARTIFACTS_REMOTE" "$REF:$REF"
elif [ "$status" -eq 2 ]; then
  if artifacts ls-remote --exit-code "$ARTIFACTS_REMOTE" "$REF" >/dev/null; then
    artifacts push "$ARTIFACTS_REMOTE" ":$REF"
  fi
else
  exit "$status"
fi`;

// Basic credentials git sends to GitHub for a token (PAT or App token).
export function githubAuth(token: string): string {
  return btoa(`x-access-token:${token}`);
}

export type CommitState = "pending" | "success" | "failure" | "error";

export const statusContext = "cloudflare-ci";

// Sets the cloudflare-ci commit status that PRs and branch protection read.
export async function postCommitStatus(
  { token, repository }: { token: string; repository: string },
  sha: string,
  state: CommitState,
  description: string,
): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/${repository}/statuses/${sha}`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "larkspur-ci",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ state, context: statusContext, description: description.slice(0, 140) }),
  });
  if (!response.ok) {
    throw new Error(`GitHub status ${state} for ${sha} failed: ${response.status}`);
  }
}
