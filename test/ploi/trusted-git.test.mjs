// The git the deployment policy is read with: a system git, run with an
// environment gq builds, so neither PATH nor the caller's GIT_* variables
// decide what the policy says.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { exec } from "../../src/exec.mjs";
import { policyGit, trustedGit } from "../../src/ploi/trusted-git.mjs";
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
