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

// Whether `version` (parsed, stable) satisfies a Composer constraint: `||`
// alternatives of space- or comma-separated conditions, each an exact or
// partial version, a wildcard (`*`, `1.2.*`), a caret, a tilde, a hyphen
// range or a comparison (`>=`, `>`, `<=`, `<`, `!=`, `=`). Stability flags
// (`@stable`) are ignored. Resolves to true or false, or null for a
// constraint it can't read, which a caller reports rather than guesses.
export function satisfiesConstraint(version, constraint) {
  const alternatives = String(constraint)
    .trim()
    .split(/\s*\|\|?\s*/u);
  let satisfied = false;
  for (const alternative of alternatives) {
    const text = alternative.replace(/@[a-z]+/giu, "").trim();
    if (text === "") return null;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(text);
    const conditions = hyphen
      ? [`>=${hyphen[1]}`, upperOfHyphen(hyphen[2])]
      : text.split(/\s*,\s*|\s+/u).filter(Boolean);
    let all = true;
    for (const condition of conditions) {
      const result = condition === null ? null : satisfiesCondition(version, condition);
      if (result === null) return null;
      if (!result) all = false;
    }
    if (all) satisfied = true;
  }
  return satisfied;
}

// `1.2.3` → `<=1.2.3`; a partial `1.2` → `<1.3`, as Composer reads a hyphen
// range's upper end.
function upperOfHyphen(text) {
  const parts = partialVersion(text);
  if (!parts) return null;
  if (parts.given === 3) return `<=${parts.version.text}`;
  const next =
    parts.given === 1 ? `${parts.version.major + 1}.0.0` : bump(parts.version, "minor").text;
  return `<${next}`;
}

function satisfiesCondition(version, condition) {
  if (condition === "*") return true;
  const operator = /^(>=|<=|!=|==|>|<|=|\^|~)?\s*(.+)$/u.exec(condition);
  if (!operator) return null;
  const [, op = "", rest] = operator;
  const wildcard = /^v?(\d+)(?:\.(\d+))?\.[*x]$/u.exec(rest);
  if (wildcard && (op === "" || op === "=" || op === "==")) {
    const floor = parseVersion(`${wildcard[1]}.${wildcard[2] ?? 0}.0`);
    const ceiling =
      wildcard[2] === undefined ? parseVersion(`${floor.major + 1}.0.0`) : bump(floor, "minor");
    return compareVersions(version, floor) >= 0 && compareVersions(version, ceiling) < 0;
  }
  const parts = partialVersion(rest);
  if (!parts) return null;
  const bound = parts.version;
  const compared = compareVersions(version, bound);
  switch (op) {
    case "":
    case "=":
    case "==":
      return compared === 0;
    case "!=":
      return compared !== 0;
    case ">=":
      return compared >= 0;
    case ">":
      return compared > 0;
    case "<=":
      return compared <= 0;
    case "<":
      return compared < 0;
    case "^": {
      let ceiling;
      if (bound.major > 0 || parts.given === 1) ceiling = parseVersion(`${bound.major + 1}.0.0`);
      else if (bound.minor > 0 || parts.given === 2) ceiling = bump(bound, "minor");
      else ceiling = bump(bound, "patch");
      return compared >= 0 && compareVersions(version, ceiling) < 0;
    }
    case "~": {
      const ceiling =
        parts.given === 3 ? bump(bound, "minor") : parseVersion(`${bound.major + 1}.0.0`);
      return compared >= 0 && compareVersions(version, ceiling) < 0;
    }
    default:
      return null;
  }
}

// `1`, `1.2`, `v1.2.3` → the version it names (missing parts 0) and how many
// parts were given.
function partialVersion(text) {
  const match = /^v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?$/u.exec(text);
  if (!match) return null;
  const given = match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1;
  return {
    version: parseVersion(`${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}`),
    given,
  };
}

function bump(version, part) {
  if (part === "minor") return parseVersion(`${version.major}.${version.minor + 1}.0`);
  return parseVersion(`${version.major}.${version.minor}.${version.patch + 1}`);
}
