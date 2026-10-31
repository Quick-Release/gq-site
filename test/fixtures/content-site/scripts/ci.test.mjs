import assert from "node:assert/strict";
import test from "node:test";

import { isRelease } from "../infra/ci/release.ts";

test("only v* tags are releases", () => {
  assert.equal(isRelease({ trigger: "tag", tag: "v0.1.1" }), true);
  assert.equal(isRelease({ trigger: "tag", tag: "nightly" }), false);
  assert.equal(isRelease({ trigger: "push" }), false);
});

test("the release step names any missing deploy credential", async () => {
  const { missingEnvironment } = await import("./ci-release.mjs");
  assert.deepEqual(missingEnvironment({ PLOI_API_TOKEN: "x", CLOUDFLARE_API_TOKEN: "y" }), [
    "RELEASES_R2_ACCESS_KEY_ID",
    "RELEASES_R2_SECRET_ACCESS_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "COMPOSER_AUTH",
  ]);
});

test("the release step accepts only the Artifacts URLs it fetches the source from", async () => {
  const { authoritativeScheme } = await import("./ci-release.mjs");
  assert.equal(
    authoritativeScheme("https://acct.artifacts.cloudflare.net/git/ns/site.git"),
    "https",
  );
  assert.equal(authoritativeScheme("http://127.0.0.1:41234/site.git"), "http");
  for (const rejected of [
    "http://127.0.0.1/site.git/", // trailing slash (empty segment)
    "http://localhost:41234/site.git", // not 127.0.0.1
    "https://example.test:443/x.git", // a port
    "https://user:pass@example.test/x.git", // credentials
    "https://example.test/a/../x.git", // a .. segment
    "https://example.test/x.git?y", // a query
    "https://1.2.3.4/x.git", // a bare IP
    "file:///tmp/x.git",
    "/tmp/x.git",
  ]) {
    assert.equal(authoritativeScheme(rejected), null, rejected);
  }
});

test("the release step fetches the source isolated from the workspace and the runner's environment", async () => {
  const { fetchSource, sourceGitEnvironment } = await import("./ci-release.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const sha = "0".repeat(40);
  const remote = "https://acct.artifacts.cloudflare.net/git/ns/site.git";

  // Guards, all before any git runs: no credentials, a URL it won't fetch
  // from, and a ref that isn't an object id.
  assert.throws(() => fetchSource("abc", {}), /ARTIFACTS_REMOTE\/ARTIFACTS_TOKEN/u);
  for (const bad of ["http://localhost/x.git", "file:///tmp/x.git", "/tmp/x.git"]) {
    assert.throws(
      () => fetchSource(sha, { ARTIFACTS_REMOTE: bad, ARTIFACTS_TOKEN: "t" }),
      /isn't an https URL/u,
      bad,
    );
  }
  assert.throws(
    () => fetchSource("not-a-sha", { ARTIFACTS_REMOTE: remote, ARTIFACTS_TOKEN: "t" }),
    /Not a commit or tag object id/u,
  );

  // The git environment is built from nothing the caller chose: the token
  // isn't in it (it is added per call), discovery is ceilinged at the scratch
  // directory's parent, and system and global config are off.
  const scratch = mkdtempSync(join(tmpdir(), "gq-source-env-"));
  const env = sourceGitEnvironment("/usr/bin/git", scratch, [["core.hooksPath", "/dev/null"]], {
    homedir: "/home/ci",
    username: "ci",
  });
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_CEILING_DIRECTORIES, dirname(scratch));
  assert.equal(env.HOME, "/home/ci");
  assert.ok(!JSON.stringify(env).includes("PATH_TO_SECRET"));
  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "core.hooksPath");
});

test("verifies GitHub webhook signatures", async () => {
  const { createHmac } = await import("node:crypto");
  const { verifySignature } = await import("../infra/ci/github.ts");
  const body = '{"zen":"Design for failure."}';
  const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  assert.equal(await verifySignature("secret", body, signature), true);
  assert.equal(await verifySignature("other", body, signature), false);
  assert.equal(await verifySignature("secret", `${body} `, signature), false);
  assert.equal(await verifySignature("secret", body, null), false);
  assert.equal(await verifySignature("", body, signature), false);
});

test("mirrors branch and tag pushes of the configured repository only", async () => {
  const { parsePushEvent } = await import("../infra/ci/github.ts");
  const push = (ref, repository = "example/site") =>
    JSON.stringify({ ref, repository: { full_name: repository } });
  assert.deepEqual(parsePushEvent(push("refs/heads/main"), "example/site"), {
    ref: "refs/heads/main",
  });
  assert.deepEqual(parsePushEvent(push("refs/tags/v0.2.0"), "example/site"), {
    ref: "refs/tags/v0.2.0",
  });
  assert.equal(parsePushEvent(push("refs/heads/main", "someone/else"), "example/site"), null);
  assert.equal(parsePushEvent(push("refs/pull/1/head"), "example/site"), null);
  assert.equal(parsePushEvent(push("refs/heads/a:b"), "example/site"), null);
});

test("the mirror script converges Artifacts on GitHub's refs", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mirrorScript } = await import("../infra/ci/github.ts");

  const root = mkdtempSync(join(tmpdir(), "mirror-"));
  // Run from a git hook (pre-push → pnpm verify), git's GIT_DIR, GIT_INDEX_FILE
  // and the like would point these throwaway repositories at the site's own.
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...environment,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim();
  const github = join(root, "github.git");
  const artifacts = join(root, "artifacts.git");
  const work = join(root, "work");
  const mirror = (ref) =>
    execFileSync("sh", ["-c", mirrorScript], {
      env: {
        ...environment,
        REF: ref,
        GITHUB_REMOTE: github,
        GITHUB_AUTH: "unused",
        ARTIFACTS_REMOTE: artifacts,
        ARTIFACTS_TOKEN: "unused",
      },
      stdio: "pipe",
    });
  const head = (repo, ref) => {
    try {
      return git("--git-dir", repo, "rev-parse", "--verify", "-q", ref);
    } catch {
      return null;
    }
  };

  try {
    git("init", "-q", "--bare", github);
    git("init", "-q", "--bare", artifacts);
    git("init", "-q", "-b", "main", work);
    git("-C", work, "commit", "-q", "--allow-empty", "-m", "one");
    git("-C", work, "push", "-q", github, "main");

    mirror("refs/heads/main");
    assert.equal(head(artifacts, "refs/heads/main"), head(github, "refs/heads/main"));

    // A force-push on GitHub (rewritten history) is mirrored as-is.
    git("-C", work, "commit", "-q", "--amend", "--allow-empty", "-m", "rewritten");
    git("-C", work, "push", "-q", "--force", github, "main");
    mirror("refs/heads/main");
    assert.equal(head(artifacts, "refs/heads/main"), head(github, "refs/heads/main"));

    // Annotated tags keep their tag object.
    git("-C", work, "tag", "-a", "v1.0.0", "-m", "release");
    git("-C", work, "push", "-q", github, "v1.0.0");
    mirror("refs/tags/v1.0.0");
    assert.equal(head(artifacts, "refs/tags/v1.0.0"), head(github, "refs/tags/v1.0.0"));

    // A branch deleted on GitHub is deleted on Artifacts; mirroring it again is a no-op.
    git("-C", work, "push", "-q", github, "main:feature");
    mirror("refs/heads/feature");
    assert.notEqual(head(artifacts, "refs/heads/feature"), null);
    git("-C", work, "push", "-q", github, ":feature");
    mirror("refs/heads/feature");
    assert.equal(head(artifacts, "refs/heads/feature"), null);
    mirror("refs/heads/feature");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gets each run's GitHub token from the GETQUICK CI broker, else GITHUB_CI_TOKEN", async () => {
  const { githubToken, hasGithubCredentials } = await import("../infra/ci/github.ts");
  const requests = [];
  const broker = async (url, init) => {
    requests.push({ url, init });
    return Response.json({ token: "minted", expires_at: "2026-01-01T00:00:00Z" });
  };
  const env = {
    GITHUB_REPOSITORY: "Quick-Release/site",
    GITHUB_CI_TOKEN: "fine-grained",
    GQ_CI_BROKER_URL: "https://broker.example",
    GQ_CI_BROKER_TOKEN: "credential",
  };
  assert.equal(await githubToken(env, broker), "minted");
  assert.equal(requests[0].url, "https://broker.example/token");
  assert.equal(requests[0].init.headers.Authorization, "Bearer credential");
  assert.deepEqual(JSON.parse(requests[0].init.body), { repository: "Quick-Release/site" });

  const tokenOnly = { GITHUB_REPOSITORY: "Quick-Release/site", GITHUB_CI_TOKEN: "fine-grained" };
  assert.equal(await githubToken(tokenOnly, broker), "fine-grained");
  assert.equal(requests.length, 1);
  assert.equal(hasGithubCredentials({ GITHUB_REPOSITORY: "Quick-Release/site" }), false);
  await assert.rejects(
    githubToken(env, async () => new Response("Unauthorized.", { status: 401 })),
    /broker answered 401/u,
  );
});
