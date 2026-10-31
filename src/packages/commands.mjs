// gq packages check|propose: discovery and upgrade proposals for the GETQUICK
// packages in the blueprint's catalogue (catalogue.mjs): Composer packages and
// npm packages on GitHub Packages. Both are read-only; `propose --write`
// changes only the proposed pins of the blueprint's CMS composer.json files
// and npm pins, and their recorded requirements, in a gq-site checkout.
// Neither resolves a lockfile, touches a Site, or approves a combination's
// runtime compatibility. Exits 1 when any source couldn't be read, or when
// the current pins' recorded requirements disagree with the registry or
// with each other.
import { rename, writeFile } from "node:fs/promises";

import { isNpm, loadCatalogue, locateBlueprint, requirementsText } from "./catalogue.mjs";
import { discoverPackage } from "./discovery.mjs";
import { FAILING_BLOCKERS, applyDependencies, applyRequirements, planPackages } from "./plan.mjs";

export const PACKAGES_USAGE = [
  "gq packages check [--json]",
  "gq packages propose --latest [--write] [--json]",
];

const COMPATIBILITY =
  "Discovery shows what is released and installable, not that this combination works together: " +
  "test the proposal before a platform release pins it.";

export function isPackagesCommand(argv) {
  return argv[0] === "packages";
}

// Resolves to the exit code.
export async function runPackagesCommand(argv, { cwd, env, fetch, io }) {
  const options = parsePackagesArguments(argv);
  const blueprint = await locateBlueprint(cwd);
  if (options.write && !blueprint.writable) {
    throw new Error(
      "gq packages propose --write changes the blueprint, so it only runs in a gq-site checkout; " +
        "Sites take new pins by bumping @getquick/site.",
    );
  }
  const loaded = await loadCatalogue(blueprint);
  const discoveries = [];
  for (const pkg of loaded.catalogue.packages) {
    discoveries.push(await discoverPackage(pkg, { composer: loaded.composer, env, fetch }));
  }
  const packages = planPackages(
    loaded.catalogue,
    loaded.composer,
    discoveries,
    loaded.npm,
    loaded.requirements,
  );
  const files = [
    ...loaded.composers.map((composer) => composer.relativePath),
    loaded.npmFile,
    loaded.requirementsFile,
  ].filter(Boolean);
  const failed = packages.some((row) =>
    row.blockers.some((blocker) => FAILING_BLOCKERS.has(blocker.code)),
  );

  if (options.action === "check") {
    if (options.json)
      io.out(
        JSON.stringify(
          {
            composerFile: loaded.composerFile,
            npmFile: loaded.npmFile,
            files,
            packages,
            compatibility: COMPATIBILITY,
          },
          null,
          2,
        ),
      );
    else printCheck(io, files, packages);
    return failed ? 1 : 0;
  }

  const changes = packages
    .filter((row) => row.action === "upgrade")
    .map((row) => ({
      name: row.name,
      from: row.current,
      to: row.proposed,
      ...(row.proposedRequires ? { requires: row.proposedRequires } : {}),
    }));
  const blocked = packages
    .filter((row) => row.blockers.length > 0)
    .map((row) => ({ name: row.name, action: row.action, blockers: row.blockers }));
  let written = false;
  if (options.write && changes.length > 0) {
    const npmNames = new Set(
      loaded.catalogue.packages.filter((pkg) => isNpm(pkg)).map((pkg) => pkg.name),
    );
    // Every file is edited in memory first, so a refusal writes none.
    const edits = [
      ...loaded.composers.map((composer) => [
        composer.path,
        composer.text,
        applyRequirements,
        (change) =>
          !npmNames.has(change.name) && Object.hasOwn(composer.json.require ?? {}, change.name),
      ]),
      [loaded.npmPath, loaded.npmText, applyDependencies, (change) => npmNames.has(change.name)],
    ].flatMap(([path, text, apply, owns]) => {
      const own = changes.filter(owns);
      if (own.length === 0) return [];
      const output = apply(text, own);
      return output === text ? [] : [[path, output]];
    });
    if (loaded.requirements) {
      const records = structuredClone(loaded.requirements);
      for (const change of changes) {
        if (npmNames.has(change.name)) continue;
        records.packages[change.name] = { version: change.to, require: change.requires ?? {} };
      }
      const before = requirementsText(loaded.requirements);
      const after = requirementsText(records);
      if (after !== before) edits.push([loaded.requirementsPath, after]);
    }
    for (const [path, output] of edits) {
      const temporary = `${path}.gq-packages.tmp`;
      await writeFile(temporary, output);
      await rename(temporary, path);
      written = true;
    }
  }
  const proposal = {
    composerFile: loaded.composerFile,
    npmFile: loaded.npmFile,
    files,
    changes,
    blocked,
    written,
    compatibility: COMPATIBILITY,
  };
  if (options.json) io.out(JSON.stringify({ ...proposal, packages }, null, 2));
  else printProposal(io, proposal, options.write);
  return failed ? 1 : 0;
}

function parsePackagesArguments(argv) {
  const action = argv[1];
  const usage = () => new Error(`Usage:\n  ${PACKAGES_USAGE.join("\n  ")}`);
  if (action !== "check" && action !== "propose") throw usage();
  const allowed = action === "check" ? ["--json"] : ["--json", "--latest", "--write"];
  const options = { action, json: false, latest: false, write: false };
  for (const argument of argv.slice(2)) {
    if (!allowed.includes(argument)) throw usage();
    const key = argument.slice(2);
    if (options[key]) throw usage();
    options[key] = true;
  }
  // --latest is the only proposal strategy so far; it is stated, not implied.
  if (action === "propose" && !options.latest) throw usage();
  return options;
}

function printCheck(io, files, packages) {
  io.out(`Blueprint requirements: ${files.join(", ")}`);
  for (const row of packages) {
    io.out("");
    io.out(
      `${row.name} (${row.requirement}${row.variants.length ? `, ${row.variants.join(", ")}` : ", no variant"})`,
    );
    io.out(`  constraint  ${row.current ?? "—"}`);
    io.out(`  upstream    ${describeSource(row.upstream, "upstream")}`);
    io.out(`  registry    ${describeSource(row.registry, "registry")}`);
    io.out(`  target      ${describeTarget(row)}`);
    if (row.requires && Object.keys(row.requires).length > 0) {
      const requires = Object.entries(row.requires).map(
        ([name, constraint]) => `${name} ${constraint}`,
      );
      io.out(`  requires    ${requires.join(", ")}`);
    }
    if (row.lockstep) {
      io.out(
        `  lockstep    ${row.lockstep.group}: ${row.lockstep.members.join(", ")} at ${row.lockstep.target ?? "no common version"}`,
      );
    }
    for (const blocker of row.blockers) io.out(`  ✗ ${blocker.code}: ${blocker.message}`);
    for (const note of row.notes) io.out(`  ! ${note.code}: ${note.message}`);
  }
  io.out("");
  io.out(COMPATIBILITY);
}

function printProposal(io, proposal, write) {
  if (proposal.changes.length === 0) {
    io.out(`No safe upgrades to propose for ${proposal.files.join(", ")}.`);
  } else {
    const verb = !write
      ? "Proposed (not applied; --write applies them)"
      : proposal.written
        ? "Wrote"
        : "Already applied";
    io.out(`${verb}: ${proposal.files.join(", ")}`);
    for (const change of proposal.changes)
      io.out(`  ${change.name}  ${change.from} → ${change.to}`);
  }
  if (proposal.blocked.length > 0) {
    io.out("");
    io.out("Pending review (never written):");
    for (const row of proposal.blocked) {
      for (const blocker of row.blockers)
        io.out(`  ${row.name}  ${blocker.code}: ${blocker.message}`);
    }
  }
  io.out("");
  io.out(`Applying a proposal doesn't approve it. ${COMPATIBILITY}`);
}

function describeSource(source, kind) {
  if (source.status === "error") return `unreadable (${source.error.code})`;
  if (!source.latest) return `no stable release (${source.source})`;
  const latest = source.latest;
  const provenance =
    kind === "upstream"
      ? [
          latest.tag,
          latest.commit && `commit ${latest.commit.slice(0, 12)}`,
          latest.asset,
          latest.digest,
        ].filter(Boolean)
      : [
          latest.reference && `reference ${String(latest.reference).slice(0, 12)}`,
          latest.shasum && `sha1 ${latest.shasum}`,
          latest.integrity && `integrity ${latest.integrity}`,
        ].filter(Boolean);
  return `${latest.version} — ${source.source}${provenance.length ? `, ${provenance.join(", ")}` : ""}`;
}

function describeTarget(row) {
  if (row.action === "upgrade" && row.lockstep) {
    return `${row.proposed} (from ${row.current}, with ${row.lockstep.group})`;
  }
  if (row.action === "upgrade" && row.proposed === row.target) {
    return `${row.proposed} (from ${row.current})`;
  }
  if (row.action === "upgrade") return `${row.proposed} (upgrade inside ${row.current})`;
  if (row.action === "report")
    return `${row.target} (reported only: ${row.requirement === "site" ? "site-owned" : "not required"})`;
  if (row.action === "none") return `${row.current} (up to date)`;
  return "— (blocked)";
}
