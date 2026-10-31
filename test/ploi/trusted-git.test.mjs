// The git the deployment policy is read with: a system git, run with an
// environment gq builds, so neither PATH nor the caller's GIT_* variables
// decide what the policy says.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { exec } from "../../src/exec.mjs";
import {
  authoritativeScheme,
  policyGit,
  policyGitEnvironment,
  trustedGit,
} from "../../src/ploi/trusted-git.mjs";
import { temporaryDirectory } from "../support/fixture-site.mjs";
import { gitHttpServer } from "../support/git-http.mjs";

const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

test("the policy's git is the first executable system location, and none refuses", async () => {
  const root = await temporaryDirectory();
  const notExecutable = join(root, "not-executable");
  await writeFile(notExecutable, "");
  const executable = join(root, "git");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);

  assert.equal(trustedGit([join(root, "missing"), notExecutable, executable]), executable);
  assert.throws(
    () => trustedGit([join(root, "missing"), notExecutable]),
    /No git at .*: the deployment policy is only read with a system git, not one found on PATH/u,
  );
});

test("a policy read reads the repository it runs in, whatever GIT_DIR or other git variables the caller sets", async () => {
  // Two real repositories: the Site's, held, and another one, unheld.
  const repository = async (state) => {
    const root = await temporaryDirectory();
    execFileSync("git", ["init", "--quiet", root], { env: GIT_ENV });
    await writeFile(join(root, "gq.ops.json"), JSON.stringify({ state }));
    execFileSync("git", ["-C", root, "add", "-A"], { env: GIT_ENV });
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "commit",
        "--quiet",
        "-m",
        state,
      ],
      { env: GIT_ENV },
    );
    return root;
  };
  const site = await repository("paused");
  const other = await repository("authorized");
  const fakeBin = join(await temporaryDirectory(), "bin");
  await mkdir(fakeBin);

  const { local } = policyGit({
    exec,
    cwd: site,
    env: {
      GIT_DIR: join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: join(other, ".git/index"),
      GIT_OBJECT_DIRECTORY: join(other, ".git/objects"),
      GIT_CONFIG_PARAMETERS: "'core.hooksPath=/tmp'",
      PATH: `${fakeBin}:/usr/bin`,
    },
  });

  assert.deepEqual(JSON.parse(await local(["show", "HEAD:gq.ops.json"])), { state: "paused" });
});

test("no global or system git configuration can redirect a policy read: ~/.gitconfig's url.insteadOf reaches neither origin nor local reads", async () => {
  const repository = async (state) => {
    const root = await temporaryDirectory();
    execFileSync("git", ["init", "--quiet", root], { env: GIT_ENV });
    await writeFile(join(root, "gq.ops.json"), JSON.stringify({ state }));
    execFileSync("git", ["-C", root, "add", "-A"], { env: GIT_ENV });
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "commit",
        "--quiet",
        "-m",
        state,
      ],
      { env: GIT_ENV },
    );
    return root;
  };
  const origin = await repository("paused");
  const impostor = await repository("authorized");
  const site = await repository("paused");
  execFileSync("git", ["-C", site, "remote", "add", "origin", `file://${origin}`], {
    env: GIT_ENV,
  });
  const head = (root) =>
    execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      env: GIT_ENV,
      encoding: "utf8",
    }).trim();

  // The user's global configuration (both places git reads it from) sends
  // origin to the impostor, and aliases a command a read uses.
  const homedir = await temporaryDirectory();
  const redirect = `[url "file://${impostor}"]\n\tinsteadOf = file://${origin}\n[alias]\n\tshow = log\n`;
  await writeFile(join(homedir, ".gitconfig"), redirect);
  await mkdir(join(homedir, ".config/git"), { recursive: true });
  await writeFile(join(homedir, ".config/git/config"), redirect);
  // Without gq's environment, git follows it: the setup is real.
  const followed = execFileSync("git", ["-C", site, "ls-remote", "origin", "HEAD"], {
    env: { ...GIT_ENV, HOME: homedir, XDG_CONFIG_HOME: join(homedir, ".config") },
    encoding: "utf8",
  });
  assert.ok(followed.startsWith(head(impostor)));

  // An operator's machine (no ARTIFACTS_REMOTE): origin is the repository's
  // own, read with gq's environment.
  const { local } = policyGit({
    exec,
    cwd: site,
    env: { HOME: homedir, XDG_CONFIG_HOME: join(homedir, ".config") },
    homedir,
    username: "t",
  });
  assert.ok((await local(["ls-remote", "origin", "HEAD"])).startsWith(head(origin)));
  assert.deepEqual(JSON.parse(await local(["show", "HEAD:gq.ops.json"])), { state: "paused" });
});

test("a repository-local policy read's environment is exactly gq's: system and global git configuration off, no credential", () => {
  const env = policyGitEnvironment(
    "/usr/bin/git",
    { SSH_AUTH_SOCK: "/run/agent", HOME: "/elsewhere", ARTIFACTS_TOKEN: "t" },
    { homedir: "/home/u", username: "u" },
  );
  assert.deepEqual(
    { ...env },
    {
      PATH: "/usr/bin:/usr/bin:/bin",
      HOME: "/home/u",
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      USER: "u",
      LOGNAME: "u",
      SSH_AUTH_SOCK: "/run/agent",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    },
  );
});

// --- CI: the default branch's policy comes only from ARTIFACTS_REMOTE ---------
//
// Two real git smart-HTTP endpoints (git http-backend on 127.0.0.1): the
// authoritative Artifacts stand-in and an impostor. Tokens are synthetic.

const TOKEN = "synthetic-artifacts-token";
const SITE = { schemaVersion: 1, project: "acme", variant: "content" };
const PAUSED_OPS = { ...SITE, deployment: { protected: true, state: "paused", reason: "Held" } };
const AUTHORIZED_OPS = { ...SITE, deployment: { protected: true, state: "authorized" } };

// A bare repository `name` under `root` whose main holds gq.ops.json `ops`.
async function bareRepository(root, name, ops) {
  const work = await temporaryDirectory();
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", work], { env: GIT_ENV });
  await writeFile(join(work, "gq.ops.json"), `${JSON.stringify(ops)}\n`);
  execFileSync("git", ["-C", work, "add", "-A"], { env: GIT_ENV });
  execFileSync(
    "git",
    ["-C", work, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", name],
    { env: GIT_ENV },
  );
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", join(root, `${name}.git`)], {
    env: GIT_ENV,
  });
  execFileSync("git", ["-C", work, "push", "--quiet", join(root, `${name}.git`), "main"], { env: GIT_ENV });
}

// The authoritative endpoint (default branch `authoritative`), an impostor
// (`impostor`), and a release workspace whose repository config is `config`
// (given the two URLs). Resolves to everything a test needs.
async function ciSetup({ authoritative = PAUSED_OPS, impostor = AUTHORIZED_OPS, config }) {
  const root = await temporaryDirectory();
  await bareRepository(root, "site", authoritative);
  await bareRepository(root, "forged", impostor);
  const real = await gitHttpServer(root);
  const fake = await gitHttpServer(root);
  const remote = `${real.url}/site.git`;
  const forged = `${fake.url}/forged.git`;
  const workspace = await temporaryDirectory();
  execFileSync("git", ["init", "--quiet", workspace], { env: GIT_ENV });
  const repoConfig = config({ remote, forged, workspace });
  await writeFile(join(workspace, ".git/config"), repoConfig.text);
  for (const [path, content] of Object.entries(repoConfig.files ?? {})) {
    await writeFile(join(workspace, path), content);
  }
  const home = await temporaryDirectory();
  return {
    real,
    fake,
    remote,
    forged,
    workspace,
    home,
    close: async () => {
      await real.close();
      await fake.close();
    },
  };
}

const repository = (lines) => ["[core]", "\trepositoryformatversion = 0", "\tbare = false", ...lines, ""].join("\n");

test("in CI, a workspace whose config redirects origin (repository insteadOf, an include, pushurl) neither gets the token nor supplies the policy: the authoritative remote's held policy holds", async () => {
  const setup = await ciSetup({
    config: ({ remote, forged, workspace }) => ({
      text: repository([
        `[remote "origin"]`,
        `\turl = ${remote}`,
        `\tpushurl = ${forged}`,
        `\tfetch = +refs/heads/*:refs/remotes/origin/*`,
        `[url "${forged}"]`,
        `\tinsteadOf = ${remote}`,
        `[include]`,
        `\tpath = ${join(workspace, ".git/redirect")}`,
      ]),
      files: { ".git/redirect": `[url "${forged}"]\n\tinsteadOf = ${remote}\n[http]\n\textraHeader = X-Forged: 1\n` },
    }),
  });
  try {
    // Plain git, as the workspace's config says: it goes to the impostor.
    const followed = await exec("git", ["-C", setup.workspace, "ls-remote", "origin", "HEAD"], {
      env: { ...GIT_ENV, HOME: setup.home },
    });
    assert.equal(followed.code, 0, followed.stderr);
    assert.ok(setup.fake.requests.length > 0, "the setup really redirects");
    setup.fake.requests.length = 0;

    const policy = policyGit({
      exec,
      cwd: setup.workspace,
      env: { ARTIFACTS_TOKEN: TOKEN },
      token: TOKEN,
      remote: setup.remote,
      homedir: setup.home,
      username: "t",
    });
    assert.deepEqual(await policy.defaultBranchManifest("gq.ops.json"), PAUSED_OPS);
    assert.deepEqual(setup.fake.requests, [], "the impostor got nothing");
    assert.ok(setup.real.requests.length >= 2);
    for (const request of setup.real.requests) {
      assert.equal(request.authorization, `Bearer ${TOKEN}`, request.path);
    }
  } finally {
    await setup.close();
  }
});

test("in CI, a workspace whose origin isn't ARTIFACTS_REMOTE refuses before any request", async () => {
  for (const origin of ["forged", "none"]) {
    const setup = await ciSetup({
      config: ({ forged }) => ({
        text: repository(origin === "none" ? [] : [`[remote "origin"]`, `\turl = ${forged}`]),
      }),
    });
    try {
      const policy = policyGit({
        exec,
        cwd: setup.workspace,
        env: {},
        token: TOKEN,
        remote: setup.remote,
        homedir: setup.home,
        username: "t",
      });
      await assert.rejects(policy.defaultBranchManifest("gq.ops.json"), /isn't ARTIFACTS_REMOTE: in CI the deployment policy is read only from the remote the CI Worker names/u);
      assert.deepEqual(setup.real.requests, []);
      assert.deepEqual(setup.fake.requests, []);
    } finally {
      await setup.close();
    }
  }
});

test("in CI, the authoritative remote's authorized policy is read, the token on every request to it and nowhere else; global config and redirects can't move it", async () => {
  const setup = await ciSetup({
    authoritative: AUTHORIZED_OPS,
    impostor: PAUSED_OPS,
    config: ({ remote }) => ({ text: repository([`[remote "origin"]`, `\turl = ${remote}`]) }),
  });
  try {
    // A global config redirecting the authoritative URL: ignored.
    await writeFile(join(setup.home, ".gitconfig"), `[url "${setup.forged}"]\n\tinsteadOf = ${setup.remote}\n`);
    const policy = policyGit({
      exec,
      cwd: setup.workspace,
      env: {},
      token: TOKEN,
      remote: setup.remote,
      homedir: setup.home,
      username: "t",
    });
    assert.deepEqual(await policy.defaultBranchManifest("gq.ops.json"), AUTHORIZED_OPS);
    assert.deepEqual(setup.fake.requests, []);
    assert.ok(setup.real.requests.every((request) => request.authorization === `Bearer ${TOKEN}`));
  } finally {
    await setup.close();
  }

  // The authoritative URL answering with a redirect: not followed, nothing
  // sent to where it points, the release refuses.
  const root = await temporaryDirectory();
  await bareRepository(root, "forged", AUTHORIZED_OPS);
  const target = await gitHttpServer(root);
  const redirecting = await gitHttpServer(root, { redirectTo: target.url });
  const remote = `${redirecting.url}/forged.git`;
  const workspace = await temporaryDirectory();
  execFileSync("git", ["init", "--quiet", workspace], { env: GIT_ENV });
  execFileSync("git", ["-C", workspace, "remote", "add", "origin", remote], { env: GIT_ENV });
  try {
    const policy = policyGit({ exec, cwd: workspace, env: {}, token: TOKEN, remote, homedir: await temporaryDirectory(), username: "t" });
    await assert.rejects(policy.defaultBranchManifest("gq.ops.json"), /can't be read/u);
    assert.deepEqual(target.requests, [], "the redirect wasn't followed");
  } finally {
    await target.close();
    await redirecting.close();
  }
});

test("a token without ARTIFACTS_REMOTE, or a remote gq won't read policy from, refuses; an operator's machine reads its own origin", async () => {
  const workspace = await temporaryDirectory();
  execFileSync("git", ["init", "--quiet", workspace], { env: GIT_ENV });
  assert.throws(
    () => policyGit({ exec, cwd: workspace, env: {}, token: TOKEN }),
    /ARTIFACTS_TOKEN is set without ARTIFACTS_REMOTE/u,
  );
  for (const remote of ["http://example.test/site.git", "https://user:pass@example.test/x.git", "file:///tmp/x.git", "https://example.test/x.git?y", "/tmp/x.git"]) {
    assert.throws(() => policyGit({ exec, cwd: workspace, env: {}, token: TOKEN, remote }), /ARTIFACTS_REMOTE isn't an https URL/u, remote);
  }
  assert.equal(authoritativeScheme("https://acct.artifacts.cloudflare.net/git/site/acme.git"), "https");

  // No token, no remote: origin, from the operator's own checkout.
  const root = await temporaryDirectory();
  await bareRepository(root, "site", PAUSED_OPS);
  execFileSync("git", ["-C", workspace, "remote", "add", "origin", join(root, "site.git")], { env: GIT_ENV });
  const policy = policyGit({ exec, cwd: workspace, env: {}, homedir: await temporaryDirectory(), username: "t" });
  assert.deepEqual(await policy.defaultBranchManifest("gq.ops.json"), PAUSED_OPS);
});
