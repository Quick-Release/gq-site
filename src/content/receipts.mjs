// What gq content remembers between its steps, outside the Site's repository
// (which is public): the content each `get` read (so `put` can refuse a page
// changed since), and each passing `validate` (so `put` can refuse bytes that
// weren't validated). They live in the machine's state directory, one file
// each, private to the user, and hold hashes and IDs, never the content.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** `$XDG_STATE_HOME/gq/content`, else `~/.local/state/gq/content`. */
export function stateDirectory(env) {
  const home = env.XDG_STATE_HOME || (env.HOME ? join(env.HOME, ".local", "state") : null);
  if (!home) throw new Error("Set HOME or XDG_STATE_HOME: gq content keeps its receipts there.");
  return join(home, "gq", "content");
}

function name(...parts) {
  return parts.map((part) => String(part).replace(/[^A-Za-z0-9._-]/gu, "_")).join("--");
}

async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function write(path, value) {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function createReceipts({ env, admin }) {
  // Resolved when first used, so a command that fails earlier says why.
  const basePath = (type, id) =>
    join(stateDirectory(env), "bases", `${name(admin, type, id)}.json`);
  const validationPath = (type, id, digest) =>
    join(stateDirectory(env), "validations", `${name(admin, type, id, digest)}.json`);
  return {
    /** What `get` last read of this post: { sha256, modifiedGmt, readAt }. */
    readBase: (type, id) => read(basePath(type, id)),
    recordBase: (type, id, record) => write(basePath(type, id), record),
    /** A passing validation of these bytes for this post, or null. */
    readValidation: (type, id, digest) => read(validationPath(type, id, digest)),
    recordValidation: (type, id, digest, record) =>
      write(validationPath(type, id, digest), { admin, type, id, sha256: digest, ...record }),
  };
}
