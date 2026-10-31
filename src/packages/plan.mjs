// What discovery means for each catalogued package: its current blueprint
// constraint, the newest stable upstream and installable registry versions,
// the proposed target and what blocks anything newer. A proposal only moves
// a caret constraint's floor up inside its range, or an exact pin to a newer
// version, to a version the canonical registry serves; everything else is
// reported for review. A lockstep group (ADR 0018) is planned as one: its
// target is the newest version every member's registry serves, and either
// every member moves to it or none does. Discovery proves availability, not
// that the newest combination of packages works together.
//
// With recorded requirements (the catalogue's requirementsFile), each pin's
// record is compared with what the registry says that version requires, and
// a proposal is held when it would leave a pinned package's requirement
// unsatisfied, so pins Composer can't install together are never proposed.
import { blueprintPin, isNpm, lockstepGroups } from "./catalogue.mjs";
import {
  compareVersions,
  minimumOf,
  parseCaret,
  parseVersion,
  satisfiesCaret,
  satisfiesConstraint,
} from "./versions.mjs";

const WRITE_BLOCKERS = new Set([
  "discovery-failed",
  "identity",
  "migration-required",
  "reference-mismatch",
]);

// Blockers that mean the blueprint's current pins are wrong, not that a
// proposal waits: gq packages check fails on them.
export const FAILING_BLOCKERS = new Set(["discovery-failed", "requirements-drift"]);

// One report row per catalogue entry, in catalogue order. `requirements` is
// the requirementsFile's JSON, when the catalogue has one.
export function planPackages(catalogue, composer, discoveries, npm = null, requirements = null) {
  const installable = new Map();
  const rows = catalogue.packages.map((pkg, index) =>
    planPackage(pkg, composer, npm, discoveries[index], installable),
  );
  for (const [group, members] of lockstepGroups(catalogue)) {
    planLockstep(
      group,
      members.map((pkg) => {
        const index = catalogue.packages.indexOf(pkg);
        return { pkg, row: rows[index], installable: installable.get(pkg) ?? null };
      }),
      composer,
    );
  }
  if (requirements) planRequirements(catalogue, rows, discoveries, requirements);
  return rows;
}

// Recorded requirements against the registry, then the proposed pins
// against every pinned package's requirements, holding back (with its
// lockstep group) any upgrade that would leave one unsatisfied, until the
// proposal is consistent.
function planRequirements(catalogue, rows, discoveries, requirements) {
  const entries = catalogue.packages
    .map((pkg, index) => ({ pkg, row: rows[index], registry: discoveries[index].registry }))
    .filter(({ pkg }) => !isNpm(pkg));
  const releaseOf = (entry, version) =>
    entry.registry.status === "ok"
      ? (entry.registry.releases.find((release) => release.version === version) ?? null)
      : null;
  const block = (row, code, message) => {
    if (!row.blockers.some((blocker) => blocker.message === message)) {
      row.blockers.push({ code, message });
    }
  };

  for (const entry of entries) {
    const { pkg, row } = entry;
    const record = requirements.packages[pkg.name];
    const pinned = row.current === null ? null : parseVersion(row.current);
    if (!record || !pinned || entry.registry.status !== "ok") continue;
    const release = releaseOf(entry, pinned.text);
    if (!release) {
      block(
        row,
        "requirements-drift",
        `The registry doesn't serve the pinned ${pkg.name} ${pinned.text}, so what it requires can't be confirmed.`,
      );
    } else if (describeRequire(release.requires) !== describeRequire(record.require)) {
      block(
        row,
        "requirements-drift",
        `The registry's ${pkg.name} ${pinned.text} requires ${describeRequire(release.requires)}, but the recorded requirements say ${describeRequire(record.require)}.`,
      );
    }
    row.requires = record.require;
  }

  const byName = new Map(entries.map((entry) => [entry.pkg.name, entry]));
  for (;;) {
    const pinOf = (entry) => (moving(entry) ? entry.row.proposed : entry.row.current);
    const requiresOf = (entry) =>
      moving(entry)
        ? (releaseOf(entry, entry.row.proposed)?.requires ?? {})
        : (requirements.packages[entry.pkg.name]?.require ?? {});
    const held = new Set();
    for (const entry of entries) {
      const pin = pinOf(entry);
      if (pin === null) continue;
      for (const [name, constraint] of Object.entries(requiresOf(entry))) {
        const other = byName.get(name);
        const otherPin = other ? pinOf(other) : null;
        const version = otherPin === null ? null : parseVersion(otherPin);
        if (!version || satisfiesConstraint(version, constraint) !== false) continue;
        const message = `${entry.pkg.name} ${pin} requires ${name} ${constraint}, which ${name} ${otherPin} doesn't satisfy.`;
        const culprits = [entry, other].filter(moving);
        if (culprits.length === 0) {
          block(entry.row, "requirements-drift", message);
          continue;
        }
        for (const culprit of culprits) {
          block(culprit.row, "unsatisfied", message);
          held.add(culprit);
        }
      }
    }
    if (held.size === 0) break;
    for (const entry of held) {
      const group = entry.pkg.lockstep;
      const members = group ? rows.filter((row) => row.lockstep?.group === group) : [entry.row];
      for (const row of members) {
        if (row !== entry.row) {
          block(row, "lockstep", `${entry.pkg.name} can't move, so no member of ${group} does.`);
        }
        row.proposed = null;
        row.action = "blocked";
      }
    }
  }
  for (const entry of entries) {
    if (moving(entry))
      entry.row.proposedRequires = releaseOf(entry, entry.row.proposed)?.requires ?? {};
  }

  function moving(entry) {
    return entry.row.action === "upgrade";
  }
}

function describeRequire(require) {
  const pairs = Object.entries(require ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return pairs.length === 0
    ? "nothing"
    : pairs.map(([name, constraint]) => `${name} ${constraint}`).join(", ");
}

function planPackage(pkg, composer, npm, { upstream, registry }, installableByPackage) {
  const require = composer.require ?? {};
  const current = blueprintPin(pkg, composer, npm);
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
    ecosystem: pkg.ecosystem ?? "composer",
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
  // A lockstep member's target is its group's (planLockstep).
  if (pkg.lockstep) {
    installableByPackage.set(pkg, installable);
    return row;
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

  if (pkg.policy === "exact") return planExact(row, composer, current, newestInstallable, block);

  const caret = parseCaret(current);
  if (!caret && pkg.policy === "manual") {
    // An exact pin under a manual policy: reported, never proposed.
    block("manual", `${pkg.name}'s policy is manual: nothing is proposed.`);
    row.target = newestInstallable.version;
    row.action = "blocked";
    return finish(row);
  }
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

// An exact pin moves to the newest installable version.
function planExact(row, composer, current, newestInstallable, block) {
  const pinned = parseVersion(current);
  if (!pinned || pinned.text !== current) {
    block("unsupported-constraint", `${current} isn't an exact version; change it by hand.`);
    return finish(row);
  }
  if (compareVersions(parseVersion(newestInstallable.version), pinned) <= 0) return finish(row);
  if (phpBlock(composer, newestInstallable, block)) {
    row.action = "blocked";
    return finish(row);
  }
  if (row.blockers.some((blocker) => WRITE_BLOCKERS.has(blocker.code))) {
    row.action = "blocked";
    return finish(row);
  }
  row.target = newestInstallable.version;
  row.proposed = newestInstallable.version;
  row.action = "upgrade";
  return finish(row);
}

// A lockstep group: the newest version installable for every member, which
// every member moves to, or none does. Each row names the group, its target
// and any member that lags behind the others' newest version.
function planLockstep(group, members, composer) {
  const names = members.map(({ pkg }) => pkg.name);
  const sets = members.map(({ installable }) =>
    installable === null ? null : new Map(installable.map((release) => [release.version, release])),
  );
  const readable = sets.every((set) => set !== null);
  const all = [...new Set(sets.flatMap((set) => (set ? [...set.keys()] : [])))]
    .map(parseVersion)
    .sort(compareVersions);
  const newestAny = all.at(-1) ?? null;
  const common = readable
    ? all.filter((version) => sets.every((set) => set.has(version.text)))
    : [];
  const target = common.at(-1) ?? null;
  const lagging =
    readable && newestAny
      ? members.filter((_, index) => !sets[index].has(newestAny.text)).map(({ pkg }) => pkg.name)
      : [];
  const pins = new Set(members.map(({ row }) => row.current));
  const [pin] = pins;
  const current = pins.size === 1 && pin !== null ? parseVersion(pin) : null;

  const groupBlockers = [];
  const notes = [];
  if (!readable) {
    const failed = members.filter(({ installable }) => installable === null);
    groupBlockers.push({
      code: "lockstep",
      message: `${failed.map(({ pkg }) => pkg.name).join(", ")} couldn't be planned, so ${group} can't move.`,
    });
  } else if (!target) {
    groupBlockers.push({
      code: "not-installable",
      message: `No version of ${group} is installable for every member (${names.join(", ")}).`,
    });
  }
  if (lagging.length > 0) {
    notes.push({
      code: "lockstep-lag",
      message: `${newestAny.text} is installable for ${names.filter((name) => !lagging.includes(name)).join(", ")} but not for ${lagging.join(", ")}: ${group} ${target ? `stays at ${target.text} or below` : "can't move"}.`,
    });
  }
  if (pins.size > 1) {
    groupBlockers.push({
      code: "lockstep-drift",
      message: `${group} is pinned to different versions: ${members.map(({ row }) => `${row.name} ${row.current ?? "unpinned"}`).join(", ")}.`,
    });
  } else if (pin !== null && (!current || current.text !== pin)) {
    groupBlockers.push({
      code: "unsupported-constraint",
      message: `${group} is pinned to ${pin}, not an exact version; change it by hand.`,
    });
  }
  const unrequired = members.filter(({ pkg }) => pkg.requirement !== "blueprint");
  if (unrequired.length > 0) {
    groupBlockers.push({
      code: "lockstep",
      message: `${unrequired.map(({ pkg }) => pkg.name).join(", ")} ${unrequired.length > 1 ? "aren't" : "isn't"} pinned by the blueprint, so ${group} moves only by hand.`,
    });
  }
  const moving = target && (!current || compareVersions(target, current) > 0);
  if (moving) {
    for (const { pkg, row } of members) {
      const release = sets[members.findIndex((member) => member.pkg === pkg)].get(target.text);
      phpBlock(composer, release, (code, message) => row.blockers.push({ code, message }));
    }
  }
  const held = members.filter(({ row }) =>
    row.blockers.some((blocker) => WRITE_BLOCKERS.has(blocker.code) || blocker.code === "php"),
  );
  if (moving && held.length > 0) {
    groupBlockers.push({
      code: "lockstep",
      message: `${held.map(({ pkg }) => pkg.name).join(", ")} can't move to ${target.text}, so no member of ${group} does.`,
    });
  }

  for (const { row } of members) {
    row.lockstep = {
      group,
      members: names,
      target: target?.text ?? null,
      lagging,
    };
    row.blockers.push(...groupBlockers);
    row.notes.push(...notes);
    row.target = target?.text ?? null;
    if (moving && groupBlockers.length === 0 && held.length === 0) {
      row.proposed = target.text;
      row.action = "upgrade";
    } else {
      row.action = row.blockers.length > 0 ? "blocked" : "none";
    }
  }
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
  return applyPins(text, changes, "require", "The blueprint's composer.json");
}

// npmFile's text with each change's dependencies value replaced, the same way.
export function applyDependencies(text, changes) {
  return applyPins(text, changes, "dependencies", "The blueprint's npm pins");
}

function applyPins(text, changes, section, label) {
  const before = JSON.parse(text);
  const block = new RegExp(`("${section}"\\s*:\\s*\\{)([^{}]*)(\\})`, "u").exec(text);
  if (!block) throw new Error(`${label} has no ${section} object gq can edit.`);
  let body = block[2];
  for (const change of [...changes].sort((left, right) => left.name.localeCompare(right.name))) {
    if (before[section]?.[change.name] !== change.from) {
      throw new Error(
        `${change.name} is ${before[section]?.[change.name] ?? "not required"}, not ${change.from}; run gq packages propose again.`,
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
  for (const change of changes) expected[section][change.name] = change.to;
  if (JSON.stringify(after) !== JSON.stringify(expected)) {
    throw new Error(`Editing ${label} would change more than the proposed requirements.`);
  }
  return output;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}
