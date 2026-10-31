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

// Where a run's GitHub token comes from: the GETQUICK CI token broker when
// the Worker has its URL and this Site's credential (gq github setup --app,
// gq-platform ADR 0012), otherwise the fine-grained GITHUB_CI_TOKEN.
export type GithubCredentials = {
  GITHUB_REPOSITORY: string;
  GITHUB_CI_TOKEN?: string;
  GQ_CI_BROKER_URL?: string;
  GQ_CI_BROKER_TOKEN?: string;
};

// A token for GITHUB_REPOSITORY: from the broker, an installation token for
// this repository only (Contents read, Commit statuses write) that expires
// within the hour, minted afresh for each use; or GITHUB_CI_TOKEN. Call it
// inside the Workflow step that uses the token, and never return the token
// from a step: step results are persisted.
export async function githubToken(
  env: GithubCredentials,
  fetchImplementation: typeof fetch = fetch,
): Promise<string> {
  if (env.GQ_CI_BROKER_URL && env.GQ_CI_BROKER_TOKEN) {
    const response = await fetchImplementation(`${env.GQ_CI_BROKER_URL}/token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GQ_CI_BROKER_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repository: env.GITHUB_REPOSITORY }),
    });
    if (!response.ok) {
      // The broker's refusal is fixed text, never a credential.
      const detail = await response.text().catch(() => "");
      throw new Error(`GETQUICK CI broker answered ${response.status}: ${detail.slice(0, 200)}`);
    }
    const { token } = (await response.json()) as { token?: unknown };
    if (typeof token !== "string" || !token) throw new Error("GETQUICK CI broker sent no token");
    return token;
  }
  if (env.GITHUB_CI_TOKEN) return env.GITHUB_CI_TOKEN;
  throw new Error("No GitHub credentials: run gq github setup --app, then gq ci deploy");
}

// Whether the Worker has any GitHub credentials to report statuses with.
export function hasGithubCredentials(env: GithubCredentials): boolean {
  return Boolean(env.GITHUB_CI_TOKEN || (env.GQ_CI_BROKER_URL && env.GQ_CI_BROKER_TOKEN));
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
      "User-Agent": "{{project}}-ci",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ state, context: statusContext, description: description.slice(0, 140) }),
  });
  if (!response.ok) {
    throw new Error(`GitHub status ${state} for ${sha} failed: ${response.status}`);
  }
}
