// In CI, gq ploi release reads the default branch's policy only from
// ARTIFACTS_REMOTE: end to end, with real git against two real git
// smart-HTTP endpoints on 127.0.0.1 (the authoritative remote and an
// impostor), a release repository whose own config tries to redirect the
// read, and synthetic tokens. Nothing reaches a provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { exec } from "../../src/exec.mjs";
import { temporaryDirectory } from "../support/fixture-site.mjs";
import { gitHttpServer } from "../support/git-http.mjs";
import { fakeProviders, OPS, PAUSED, RELEASE_ENV, site } from "../support/ploi-release.mjs";

const TOKEN = "synthetic-artifacts-token";
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();
const commit = (cwd, message) =>
  git(
    cwd,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "--quiet",
    "-m",
    message,
  );

// A bare repository `name` under `root` whose main holds gq.ops.json `ops`.
async function bare(root, name, ops) {
  const work = await temporaryDirectory();
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", work], { env: GIT_ENV });
  await writeFile(join(work, "gq.ops.json"), `${JSON.stringify(ops)}\n`);
  git(work, "add", "-A");
  commit(work, name);
  execFileSync(
    "git",
    ["init", "--quiet", "--bare", "--initial-branch=main", join(root, `${name}.git`)],
    {
      env: GIT_ENV,
    },
  );
  git(work, "push", "--quiet", join(root, `${name}.git`), "main");
}

test("gq ploi release in CI: a release repository that redirects origin to an impostor's authorized policy still refuses on the authoritative remote's hold, before any provider call; the impostor gets nothing", async () => {
  const root = await temporaryDirectory();
  await bare(root, "site", { ...OPS, deployment: PAUSED });
  await bare(root, "forged", OPS);
  const real = await gitHttpServer(root);
  const fake = await gitHttpServer(root);
  const remote = `${real.url}/site.git`;
  const forged = `${fake.url}/forged.git`;

  // The release repository (as CI's workspace has it): the release commit,
  // origin naming ARTIFACTS_REMOTE, and its own config sending that URL to
  // the impostor (insteadOf, directly and through an include).
  const fixture = await site();
  const repository = await temporaryDirectory();
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repository], { env: GIT_ENV });
  await writeFile(join(repository, "gq.ops.json"), `${JSON.stringify(OPS)}\n`);
  git(repository, "add", "-A");
  commit(repository, "release");
  const sha = git(repository, "rev-parse", "HEAD");
  git(repository, "remote", "add", "origin", remote);
  git(repository, "config", `url.${forged}.insteadOf`, remote);
  await writeFile(
    join(repository, ".git/redirect"),
    `[url "${forged}"]\n\tinsteadOf = ${remote}\n`,
  );
  git(repository, "config", "include.path", join(repository, ".git/redirect"));

  const { fetch } = fakeProviders();
  try {
    const result = await fixture.run(["ploi", "release", "--ref", sha, "--git-dir", repository], {
      env: { ...RELEASE_ENV, ARTIFACTS_TOKEN: TOKEN, ARTIFACTS_REMOTE: remote },
      fetch,
      exec,
    });
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(
      result.stderr,
      /fixture is paused \(the default branch's gq\.ops\.json deployment\.state: paused\)/u,
    );
    assert.deepEqual(fetch.requests, [], "no provider call");
    assert.deepEqual(fake.requests, [], "the impostor got nothing");
    assert.ok(real.requests.length >= 2);
    assert.ok(real.requests.every((request) => request.authorization === `Bearer ${TOKEN}`));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN));

    // Its origin pointing at the impostor instead: refused before any request.
    git(repository, "remote", "set-url", "origin", forged);
    const mismatched = await fixture.run(
      ["ploi", "release", "--ref", sha, "--git-dir", repository],
      {
        env: { ...RELEASE_ENV, ARTIFACTS_TOKEN: TOKEN, ARTIFACTS_REMOTE: remote },
        fetch,
        exec,
      },
    );
    assert.notEqual(mismatched.code, 0);
    assert.match(mismatched.stderr, /isn't ARTIFACTS_REMOTE/u);
    assert.deepEqual(fetch.requests, []);
    assert.deepEqual(fake.requests, []);
  } finally {
    await real.close();
    await fake.close();
  }
});
