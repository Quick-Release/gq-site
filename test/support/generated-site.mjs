// Helpers for gq new and gq sync tests: a site gq new generated, and a
// snapshot of a site's working tree to prove what sync did or didn't write.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

import { runGq, temporaryDirectory } from "./fixture-site.mjs";

export function hash(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export async function readSite(root, path) {
  return readFile(join(root, path), "utf8");
}

// A site gq new generated, as its files are right after.
// Existing skeleton tests explicitly exercise the supported Astro framework.
export async function newSite() {
  const parent = await temporaryDirectory();
  const created = await runGq(
    ["new", "acme", "--project", "acme", "--variant", "content", "--framework", "astro"],
    {
      cwd: parent,
    },
  );
  assert.equal(created.code, 0, created.stderr);
  const root = join(parent, "acme");
  return { root, run: (argv) => runGq(argv, { cwd: root }) };
}

// Every working-tree file's content, mode and modification time, and every
// symlink's target. Symlinks aren't followed.
export async function snapshot(root, directory = "") {
  const files = {};
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (path === ".git") continue;
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, path));
    else if (entry.isSymbolicLink()) files[path] = { symlink: await readlink(join(root, path)) };
    else {
      const stats = await lstat(join(root, path));
      files[path] = { content: await readSite(root, path), mode: stats.mode, mtime: stats.mtimeMs };
    }
  }
  return files;
}
