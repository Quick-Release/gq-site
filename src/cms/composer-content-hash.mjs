// composer.lock's content-hash for a composer.json, computed as Composer's
// Locker::getContentHash does: the md5 of PHP's json_encode (flags 0) of the
// relevant top-level keys, sorted, with config.platform. PHP decodes JSON
// objects to arrays, so an empty object encodes as [] and an object keyed
// 0..n-1 as a list; json_encode escapes "/" and every non-ASCII character.
// A caller that relies on it first checks it reproduces the lock's current
// hash: if it doesn't, the difference is in this reimplementation, and the
// caller refuses rather than trust it.
import { createHash } from "node:crypto";

const RELEVANT_KEYS = [
  "name",
  "version",
  "require",
  "require-dev",
  "conflict",
  "replace",
  "provide",
  "minimum-stability",
  "prefer-stable",
  "repositories",
  "extra",
];

export function composerContentHash(composerText) {
  const content = JSON.parse(composerText);
  const relevant = {};
  for (const key of RELEVANT_KEYS) {
    if (Object.hasOwn(content, key)) relevant[key] = content[key];
  }
  if (content.config && typeof content.config === "object" && "platform" in content.config) {
    relevant.config = { platform: content.config.platform };
  }
  const sorted = Object.fromEntries(
    Object.keys(relevant)
      .sort()
      .map((key) => [key, relevant[key]]),
  );
  return createHash("md5").update(phpJsonEncode(sorted)).digest("hex");
}

function phpJsonEncode(value) {
  if (Array.isArray(value)) return `[${value.map(phpJsonEncode).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.every((key, index) => key === String(index))) {
      return `[${keys.map((key) => phpJsonEncode(value[key])).join(",")}]`;
    }
    return `{${keys.map((key) => `${phpString(key)}:${phpJsonEncode(value[key])}`).join(",")}}`;
  }
  if (typeof value === "string") return phpString(value);
  return JSON.stringify(value);
}

function phpString(text) {
  return JSON.stringify(text)
    .replaceAll("/", "\\/")
    .replace(/[\u007f-￿]/gu, (character) =>
      character.charCodeAt(0) === 0x7f
        ? character
        : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}
