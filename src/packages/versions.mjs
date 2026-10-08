// Semantic versions as the package catalogue reads them: a release tag or a
// registry version (`v1.2.3`, `1.2.3`, `1.2.3-rc.1`), ordered by SemVer
// precedence, never by publication date. Anything else (`dev-main`,
// `plugin-v0.1.4`, a four-part version) is not a version here.

const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

// { major, minor, patch, prerelease, text } or null.
export function parseVersion(text) {
  const match = VERSION_PATTERN.exec(String(text).trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split(".") : [],
    text: `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ""}`,
  };
}

export function isStable(version) {
  return version.prerelease.length === 0;
}

export function compareVersions(left, right) {
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  // A prerelease sorts before its release (SemVer 11.3).
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const numeric = /^\d+$/u;
    if (numeric.test(a) && numeric.test(b)) return Number(a) < Number(b) ? -1 : 1;
    if (numeric.test(a)) return -1;
    if (numeric.test(b)) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

// The newest of `versions` (parsed), or null.
export function newest(versions) {
  return versions.reduce(
    (best, version) => (best === null || compareVersions(version, best) > 0 ? version : best),
    null,
  );
}

// A Composer caret constraint (`^0.3.1`, `^2.0`) as its floor and the first
// version outside it, or null for any other constraint form.
export function parseCaret(constraint) {
  const match = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/u.exec(
    String(constraint).trim(),
  );
  if (!match) return null;
  const floor = parseVersion(`${match[1]}.${match[2]}.${match[3] ?? 0}`);
  let ceiling;
  if (floor.major > 0) ceiling = `${floor.major + 1}.0.0`;
  else if (floor.minor > 0 || match[3] === undefined) ceiling = `0.${floor.minor + 1}.0`;
  else ceiling = `0.0.${floor.patch + 1}`;
  return { floor, ceiling: parseVersion(ceiling) };
}

export function satisfiesCaret(version, caret) {
  return compareVersions(version, caret.floor) >= 0 && compareVersions(version, caret.ceiling) < 0;
}

// `>=8.3`, `>=8.4.1`: the lower bound of a plain minimum constraint, or null.
export function minimumOf(constraint) {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(String(constraint ?? "").trim());
  if (!match) return null;
  return parseVersion(`${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}`);
}
