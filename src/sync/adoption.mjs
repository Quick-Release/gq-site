// What a Site that adopted the blueprint over files it already had can still
// lack, which gq sync doesn't report as pending because those files are the
// Site's: a pnpm-workspace.yaml that lists no workspace packages (the file
// pnpm writes when it installs before gq sync has created the blueprint's,
// which gq sync then keeps, since it creates that file once), and the keys of
// the blueprint's initial root package.json (scripts gq verify runs, the
// sigillo and Vite+ pins) that only a package.json gq creates gets. gq sync
// warns about each; gq doctor fails on them.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import ownership from "../../blueprint/ownership.json" with { type: "json" };
import { appliesTo, missingInitialKeys } from "./managed-files.mjs";

export const WORKSPACE_FILE = "pnpm-workspace.yaml";

// Each gap as `{ path, keys?, message, fix }`: `fix` is the gq sync command
// that closes it, and `keys` the initial keys a package.json lacks.
export async function adoptionGaps(root, manifest) {
  const gaps = [];
  if (createsWorkspaceFile(manifest)) {
    const text = await readFile(join(root, WORKSPACE_FILE), "utf8").catch(() => undefined);
    if (text !== undefined && !listsPackages(text)) {
      gaps.push({
        path: WORKSPACE_FILE,
        message:
          `${WORKSPACE_FILE} lists no workspace packages, so pnpm installs none of the Site's ` +
          "apps (pnpm writes such a file when it installs before gq sync creates the blueprint's, " +
          "and gq sync never replaces a file it creates once)",
        fix: `gq sync --recreate ${WORKSPACE_FILE}`,
      });
    }
  }
  for (const { path, keys } of await missingInitialKeys(root, manifest)) {
    gaps.push({
      path,
      keys,
      message: `${path} lacks keys a new Site's ${path} starts with: ${keys.join(", ")}`,
      fix: `gq sync --recreate ${path} (adds them, and changes no key ${path} has)`,
    });
  }
  return gaps;
}

// Whether the blueprint creates pnpm-workspace.yaml for this Site.
function createsWorkspaceFile(manifest) {
  return ownership.createOnce.some(
    (entry) => entry.path === WORKSPACE_FILE && appliesTo(entry, manifest),
  );
}

// Whether a pnpm-workspace.yaml's top-level `packages` lists at least one
// glob, as a block sequence or a flow one.
export function listsPackages(text) {
  const lines = text.split(/\r?\n/u);
  const at = lines.findIndex((line) => /^packages\s*:/u.test(line));
  if (at === -1) return false;
  const inline = lines[at]
    .replace(/^packages\s*:/u, "")
    .replace(/\s+#.*$/u, "")
    .trim();
  if (inline !== "") return /^\[\s*[^\s\]]/u.test(inline);
  for (const line of lines.slice(at + 1)) {
    if (/^\s*(#.*)?$/u.test(line)) continue;
    if (!/^\s/u.test(line)) return /^-\s*\S/u.test(line);
    return /^\s+-\s*\S/u.test(line);
  }
  return false;
}
