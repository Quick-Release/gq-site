// What discovery means for each catalogued package: its current blueprint
// constraint, the newest stable upstream and installable registry versions,
// the proposed target and what blocks anything newer. A proposal only moves
// a caret constraint's floor up inside its range, to a version the canonical
// registry serves; everything else is reported for review. Discovery proves
// availability, not that the newest combination of packages works together.
import {
  compareVersions,
  minimumOf,
  parseCaret,
  parseVersion,
  satisfiesCaret,
} from "./versions.mjs";

const WRITE_BLOCKERS = new Set([
  "discovery-failed",
  "identity",
  "migration-required",
  "reference-mismatch",
]);

// One report row per catalogue entry, in catalogue order.
export function planPackages(catalogue, composer, discoveries) {
  return catalogue.packages.map((pkg, index) => planPackage(pkg, composer, discoveries[index]));
}

function planPackage(pkg, composer, { upstream, registry }) {
  const require = composer.require ?? {};
  const current = require[pkg.name] ?? null;
  const blockers = [];
  const notes = [];
  const block = (code, message) => blockers.push({ code, message });
  const note = (code, message) => notes.push({ code, message });

  for (const source of [upstream, registry]) {
    if (source.status === "error") {
      block(
        "discovery-failed",
        `${source === upstream ? "Upstream" : "Registry"}: ${source.error.message}`,
      );
    }
  }

  // Identity: a package keeps its name; a rename is a migration.
  for (const former of pkg.formerNames ?? []) {
    if (Object.hasOwn(require, former)) {
      block(
        "migration-required",
        `The blueprint still requires the former name ${former}; renaming it to ${pkg.name} needs an explicit migration.`,
      );
    }
  }
  if (upstream.status === "ok" && upstream.declaredName && upstream.declaredName !== pkg.name) {
    block(
      "identity",
      `${upstream.latest.tag} of ${pkg.upstream.repository} declares ${upstream.declaredName}, not ${pkg.name}: a rename needs an explicit migration.`,
    );
  }
  if (registry.status === "ok") {
    const others = registry.declaredNames.filter((name) => name !== pkg.name);
    if (others.length > 0) {
      block("identity", `The registry's ${pkg.name} metadata declares ${others.join(", ")}.`);
    }
  }
  for (const migration of pkg.migrations ?? []) {
    block(
      "migration-required",
      `${migration.kind}${migration.from ? ` ${migration.from}` : ""} (${migration.status}): ${migration.reason}`,
    );
  }

  // Upstream availability against registry installability.
  if (upstream.status === "ok" && registry.status === "ok") {
    const served = new Set(registry.versions);
    const lagging = upstream.versions.filter((version) => !served.has(version));
    const newestServed = registry.latest && parseVersion(registry.latest.version);
    const unserved = lagging.filter(
      (version) => !newestServed || compareVersions(parseVersion(version), newestServed) > 0,
    );
    if (unserved.length > 0) {
      note(
        "registry-lag",
        `Released upstream but not yet installable from ${pkg.install.registry}: ${unserved.join(", ")}.`,
      );
    }
    if (
      pkg.upstream.discovery === "tags" &&
      upstream.latest &&
      registry.latest?.version === upstream.latest.version
    ) {
      const reference = registry.latest.reference;
      if (reference && reference !== upstream.latest.commit) {
        block(
          "reference-mismatch",
          `The registry's ${registry.latest.version} is built from ${short(reference)}, but upstream tag ${upstream.latest.tag} is ${short(upstream.latest.commit)}.`,
        );
      }
    }
  }

  const row = {
    name: pkg.name,
    requirement: pkg.requirement,
    variants: pkg.variants,
    policy: pkg.policy,
    current,
    upstream: summarise(upstream),
    registry: summarise(registry),
    target: null,
    proposed: null,
    action: "none",
    blockers,
    notes,
  };
  if (pkg.note) notes.push({ code: "catalogue", message: pkg.note });

  if (registry.status !== "ok") return finish(row);
  const holds = pkg.holds ?? [];
  const installable = registry.releases.filter((release) => {
    const version = parseVersion(release.version);
    return !holds.some((hold) => compareVersions(version, parseVersion(hold.from)) >= 0);
  });
  for (const hold of holds) {
    if (
      registry.releases.some(
        (release) => compareVersions(parseVersion(release.version), parseVersion(hold.from)) >= 0,
      )
    ) {
      block("hold", `Held below ${hold.from}: ${hold.reason}`);
    }
  }
  const newestInstallable = installable.at(-1) ?? null;
  if (!newestInstallable) {
    block(
      "not-installable",
      `The registry serves no stable ${pkg.name} release${holds.length ? " outside its holds" : ""}.`,
    );
    return finish(row);
  }

  if (pkg.requirement === "site") {
    note(
      "site-owned",
      `A Site requires ${pkg.name} itself; the newest installable release is ${newestInstallable.version}.`,
    );
    row.target = newestInstallable.version;
    row.action = "report";
    return finish(row);
  }
  if (pkg.requirement === "none") {
    row.target = null;
    row.action = "blocked";
    block("not-required", `No variant installs ${pkg.name}; it is never added automatically.`);
    phpBlock(composer, newestInstallable, block);
    return finish(row);
  }

  const caret = parseCaret(current);
  if (!caret) {
    block("unsupported-constraint", `${current} isn't a caret constraint; change it by hand.`);
    return finish(row);
  }
  if (!registry.releases.some((release) => satisfiesCaret(parseVersion(release.version), caret))) {
    block("not-installable", `The registry serves no release inside ${current}.`);
  }
  const newestVersion = parseVersion(newestInstallable.version);
  if (compareVersions(newestVersion, caret.ceiling) >= 0) {
    block(
      "breaking",
      `${newestInstallable.version} is outside ${current}: a breaking upgrade, pending review and any migration.`,
    );
  }
  const compatible = installable
    .filter((release) => satisfiesCaret(parseVersion(release.version), caret))
    .at(-1);
  if (pkg.policy === "manual") {
    block("manual", `${pkg.name}'s policy is manual: nothing is proposed.`);
    row.action = "blocked";
    return finish(row);
  }
  if (!compatible || compareVersions(parseVersion(compatible.version), caret.floor) <= 0) {
    row.action = blockers.length > 0 ? "blocked" : "none";
    return finish(row);
  }
  // A target that needs a newer PHP than the blueprint allows isn't safe.
  if (phpBlock(composer, compatible, block)) {
    row.action = "blocked";
    return finish(row);
  }
  // Unconfirmed identity or provenance blocks the write too.
  if (blockers.some((blocker) => WRITE_BLOCKERS.has(blocker.code))) {
    row.action = "blocked";
    return finish(row);
  }
  row.target = compatible.version;
  row.proposed = `^${compatible.version}`;
  row.action = "upgrade";
  return finish(row);
}

function phpBlock(composer, release, block) {
  const needed = minimumOf(release.php);
  const allowed = minimumOf(composer.require?.php);
  if (needed && allowed && compareVersions(needed, allowed) > 0) {
    block(
      "php",
      `${release.version} requires PHP ${release.php}; the blueprint allows ${composer.require.php}.`,
    );
    return true;
  }
  return false;
}

function finish(row) {
  if (row.action === "none" && row.blockers.length > 0) row.action = "blocked";
  return row;
}

function summarise(source) {
  if (source.status === "error") return { status: "error", error: source.error };
  // The full release list is planning input, not part of the report.
  return Object.fromEntries(Object.entries(source).filter(([key]) => key !== "releases"));
}

function short(reference) {
  return String(reference).slice(0, 12);
}

// composerFile's text with each change's require value replaced in place.
// Only `"<name>": "<from>"` inside the top-level "require" object changes;
// every other byte, key and its formatting stays. Throws rather than guess.
export function applyRequirements(text, changes) {
  const before = JSON.parse(text);
  const block = /("require"\s*:\s*\{)([^{}]*)(\})/u.exec(text);
  if (!block) throw new Error("The blueprint's composer.json has no require object gq can edit.");
  let body = block[2];
  for (const change of [...changes].sort((left, right) => left.name.localeCompare(right.name))) {
    if (before.require?.[change.name] !== change.from) {
      throw new Error(
        `${change.name} is ${before.require?.[change.name] ?? "not required"}, not ${change.from}; run gq packages propose again.`,
      );
    }
    const pattern = new RegExp(
      `("${escapeRegExp(change.name)}"\\s*:\\s*)"${escapeRegExp(change.from)}"`,
      "gu",
    );
    const matches = body.match(pattern) ?? [];
    if (matches.length !== 1)
      throw new Error(`Can't find exactly one ${change.name} requirement to change.`);
    body = body.replace(pattern, (_, key) => `${key}${JSON.stringify(change.to)}`);
  }
  const output =
    text.slice(0, block.index) +
    block[1] +
    body +
    block[3] +
    text.slice(block.index + block[0].length);
  // Nothing but the requested values changed.
  const after = JSON.parse(output);
  const expected = structuredClone(before);
  for (const change of changes) expected.require[change.name] = change.to;
  if (JSON.stringify(after) !== JSON.stringify(expected)) {
    throw new Error("Editing composer.json would change more than the proposed requirements.");
  }
  return output;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}
