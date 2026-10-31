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
  isolatedGitEnvironment,
  policyGit,
  policyGitEnvironment,
  trustedGit,
} from "../../src/ploi/trusted-git.mjs";
import { temporaryDirectory } from "../support/fixture-site.mjs";

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

  const { local, origin: remote } = policyGit({
    exec,
    cwd: site,
    env: { HOME: homedir, XDG_CONFIG_HOME: join(homedir, ".config") },
    homedir,
    username: "t",
  });
  assert.ok((await remote(["ls-remote", "origin", "HEAD"])).startsWith(head(origin)));
  assert.deepEqual(JSON.parse(await local(["show", "HEAD:gq.ops.json"])), { state: "paused" });
});

test("a policy read's environment turns off system and global git configuration, as the Operator checkout's checks do", () => {
  const env = policyGitEnvironment(
    "/usr/bin/git",
    { SSH_AUTH_SOCK: "/run/agent", HOME: "/elsewhere" },
    {
      header: "Authorization: Bearer t",
      homedir: "/home/u",
      username: "u",
    },
  );
  assert.deepEqual(
    { ...env },
    {
      ...isolatedGitEnvironment({ homedir: "/home/u", path: "/usr/bin:/usr/bin:/bin" }),
      USER: "u",
      LOGNAME: "u",
      SSH_AUTH_SOCK: "/run/agent",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "http.extraHeader",
      GIT_CONFIG_VALUE_2: "Authorization: Bearer t",
    },
  );
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
});
