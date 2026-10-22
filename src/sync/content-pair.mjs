// The content runtime's package pair (ADR 0020): the CMS plugin
// getquick/gq-content and the Frontend package @getquick/content, released
// together at one version by Quick-Release/gq-content. A Site whose
// gq.ops.json has `contentRuntime: "package"` (every Site gq new generates)
// requires both, each pinned exactly by a managed key: the blueprint's
// fragments/cms-composer.keys.json and fragments/frontend-package.keys.json
// are the pins. A Site without it keeps the runtime it copied from an earlier
// blueprint, and none of this applies to it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import cmsKeys from "../../blueprint/templates/fragments/cms-composer.keys.json" with { type: "json" };
import frontendKeys from "../../blueprint/templates/fragments/frontend-package.keys.json" with { type: "json" };

export const CONTENT_RUNTIME_PACKAGE = "package";

const COMPOSER_FILE = "apps/cms/composer.json";
const PACKAGE_FILE = "apps/frontend/package.json";

const [[composer, version]] = Object.entries(cmsKeys.require);
const [[npm, npmVersion]] = Object.entries(frontendKeys.dependencies);
if (npmVersion !== version) {
  throw new Error(
    `The blueprint pins ${composer} ${version} but ${npm} ${npmVersion}: a release pins one version.`,
  );
}

export const CONTENT_PAIR = Object.freeze({ composer, npm, version });

export function usesContentPackage(manifest) {
  return manifest.contentRuntime === CONTENT_RUNTIME_PACKAGE;
}

// What is wrong with the pair as a Site's two files declare it, as one line,
// or undefined when both require the same version. Only a Site on the
// package pair is checked; a file gq can't read is left to gq sync's own
// errors.
export async function contentPairProblem(root, manifest) {
  if (!usesContentPackage(manifest)) return undefined;
  const cms = await declared(root, COMPOSER_FILE, ["require", composer]);
  const frontend = await declared(root, PACKAGE_FILE, ["dependencies", npm]);
  if (cms === frontend) {
    return cms === undefined
      ? `Content pair: neither ${COMPOSER_FILE} nor ${PACKAGE_FILE} requires it; the blueprint pins ${composer} and ${npm} ${version}.`
      : undefined;
  }
  const cmsText = `${COMPOSER_FILE} requires ${composer} ${cms}`;
  const frontendText = `${PACKAGE_FILE} depends on ${npm} ${frontend}`;
  if (cms === undefined) {
    return `Content pair: ${frontendText} but ${composer} is missing from ${COMPOSER_FILE}; the blueprint pins both to ${version}.`;
  }
  if (frontend === undefined) {
    return `Content pair: ${cmsText} but ${npm} is missing from ${PACKAGE_FILE}; the blueprint pins both to ${version}.`;
  }
  return `Content pair: ${cmsText} and ${frontendText}; the halves disagree (the blueprint pins both to ${version}).`;
}

async function declared(root, path, [section, name]) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(join(root, path), "utf8"));
  } catch {
    return undefined;
  }
  const value = parsed?.[section]?.[name];
  return typeof value === "string" ? value : undefined;
}
