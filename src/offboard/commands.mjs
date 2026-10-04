// Offboarding a Site (ADR 0011): when a client leaves, `gq offboard` cuts
// every public URL and every credential gq made for it, losing no content or
// code, and records `offboarded` in gq.ops.json, which turns on the guards
// (guard.mjs) that keep anything from exposing it again. Reversible:
// `gq offboard --restore` brings everything back and removes the record.
// Irreversible: `gq offboard --archive` archives all its content to the
// shared offboarded-clients bucket, verifies it, then deletes its live
// infrastructure and archives its GitHub repository (archive.mjs); an
// Artifacts-only Site's code is archived with its content instead.
// Each prints the plan (✓ done, - to do or + to restore, ! by hand), then
// acts after confirmation, and only on what is still to do, so any of them
// can be run again after a failure.
//
//   gq offboard [--dry-run] [--yes]
//   gq offboard --restore [--dry-run] [--yes]
//   gq offboard --archive [--dry-run] [--yes]

import { isArtifactsOnly } from "../ci/git-artifacts.mjs";
import { createReporter } from "../cli/reporter.mjs";
import { planManagedFiles } from "../sync/managed-files.mjs";
import { archivePlan, inspectArchive } from "./archive.mjs";
import { artifactsRepositoryName } from "./names.mjs";
import { runPlan } from "./plan.mjs";
import { withOffboardingProviders, withRepositoryProviders } from "./providers.mjs";
import { inspectRepository, repositoryItems } from "./repository.mjs";
import { assertOwnDatabase, cutPlan, inspectSite, restorePlan } from "./steps.mjs";

// Command → [usage, the options it accepts, runner].
const OFFBOARD_COMMANDS = new Map([
  [
    "offboard",
    [
      "gq offboard [--restore | --archive] [--dry-run] [--yes]",
      ["restore", "archive", "dryRun", "yes"],
      runOffboard,
    ],
  ],
]);

export const OFFBOARD_USAGE = [...OFFBOARD_COMMANDS.values()].map(([usage]) => usage);

export function offboardCommandOptions(command) {
  return OFFBOARD_COMMANDS.get(command.join(" "))?.[1];
}

export function isOffboardCommand(command) {
  return OFFBOARD_COMMANDS.has(command.join(" "));
}

// Resolves to the command's exit code.
export function runOffboardCommand(command, dependencies) {
  const [, , runner] = OFFBOARD_COMMANDS.get(command.join(" "));
  return runner(dependencies);
}

// The managed files that refuse to deploy an offboarded Site (frontend.run.ts
// drops its URLs; the deploy and CI release scripts refuse): an older or
// edited copy would expose it again on the next deploy.
const DEPLOY_FILES = [
  "infra/frontend.run.ts",
  "infra/scripts/deploy-frontend.mjs",
  "scripts/ci-release.mjs",
];
const STALE = {
  create: "missing",
  update: "gq sync would update it",
  edited: "edited since gq last wrote it",
};

// Throws, naming each, unless the deploy files are as gq sync writes them.
async function refuseStaleDeployFiles(context) {
  const { files } = await planManagedFiles(context.projectRoot, context.config);
  const stale = files.filter(({ path, status }) => DEPLOY_FILES.includes(path) && STALE[status]);
  if (stale.length === 0) return;
  throw new Error(
    `The managed deploy files aren't current: ${stale.map(({ path, status }) => `${path} (${STALE[status]})`).join(", ")}. A deploy from them could expose ${context.config.project} again: run gq sync first (gq sync --check shows what it changes), then gq offboard.`,
  );
}

// `gq offboard [--restore | --archive] [--dry-run] [--yes]`. Resolves to an
// exit code.
async function runOffboard(dependencies) {
  const { context, parsed, io, interactive, stdin } = dependencies;
  const ops = context.config;
  if (parsed.restore && parsed.archive) {
    throw new Error("--restore and --archive can't be combined.");
  }
  if (parsed.archive) return runArchive(dependencies);
  const record = ops.offboarded;
  if (record?.phase === "archived" || record?.archive) {
    throw new Error(
      parsed.restore
        ? `${ops.project} was archived (gq.ops.json offboarded): its infrastructure is deleted, so there is nothing to restore.`
        : `${ops.project} is being archived (gq.ops.json offboarded.archive): finish it with gq offboard --archive (pnpm offboard:archive).`,
    );
  }
  if (!parsed.restore) await refuseStaleDeployFiles(context);
  const ui = createReporter(io, interactive, stdin);
  ui.intro(`${parsed.restore ? "Restore" : "Offboard"} · ${ops.project}`);
  return withOffboardingProviders(dependencies, async (providers) => {
    const site = await inspectSite(providers);
    const options = { configPath: context.configPath };
    if (parsed.restore) {
      return runPlan(restorePlan(site, options), providers, {
        ui,
        parsed,
        todoSymbol: "+",
        question: `Restore ${ops.project}'s public access and credentials?`,
        nothing: `Nothing to restore: ${ops.project} is not offboarded.`,
        finished: `Restored ${ops.project}. Commit gq.ops.json, then deploy as usual.`,
      });
    }
    await assertOwnDatabase(ops, providers.ploi);
    return runPlan(cutPlan(site, options), providers, {
      ui,
      parsed,
      todoSymbol: "-",
      question: `Cut ${ops.project}'s public access and credentials? (gq offboard --restore undoes it.)`,
      nothing: `Nothing left to cut: ${ops.project} is offboarded.`,
      finished: `Offboarded ${ops.project}. Commit gq.ops.json: its offboarded record keeps gq from exposing the Site again.`,
    });
  });
}

// `gq offboard --archive`: only for a Site whose access is cut and recorded.
// In a terminal, the project's name typed back confirms it; elsewhere --yes.
async function runArchive(dependencies) {
  const { context, parsed, io, interactive, stdin } = dependencies;
  const ops = context.config;
  const record = ops.offboarded;
  if (!record) {
    throw new Error(
      `${ops.project} isn't offboarded: run gq offboard first (pnpm offboard), which cuts its access and records it.`,
    );
  }
  const ui = createReporter(io, interactive, stdin);
  ui.intro(`Archive · ${ops.project}`);
  // Its infrastructure is deleted: what may be left is pushing the record
  // and archiving the repository, which need neither Cloudflare nor Ploi.
  // An Artifacts-only Site's code went with its archive.
  if (record.phase === "archived" && isArtifactsOnly(ops)) {
    ui.outro(
      `Nothing left to archive: ${ops.project} was archived to r2://${record.archive?.bucket}/${record.archive?.prefix}.`,
    );
    return 0;
  }
  if (record.phase === "archived") {
    return withRepositoryProviders(dependencies, async (providers) =>
      runPlan(repositoryItems(await inspectRepository(providers), ops), providers, {
        ui,
        parsed,
        todoSymbol: "-",
        question: `Push gq.ops.json and archive ${ops.github.repository}?`,
        nothing: `Nothing left to archive: ${ops.project} was archived to r2://${record.archive?.bucket}/${record.archive?.prefix}.`,
        finished: `Archived ${ops.github.repository}: it is read-only now.`,
      }),
    );
  }
  return withOffboardingProviders(
    dependencies,
    async (providers) => {
      const site = await inspectArchive(providers);
      const { items, result, hasCodeBundle, archivesRepository } = archivePlan(site, {
        configPath: context.configPath,
      });
      return runPlan(items, providers, {
        ui,
        parsed,
        todoSymbol: "-",
        async confirm(prompt) {
          const typed = await prompt.text(
            `This deletes ${ops.project}'s live infrastructure for good, once its archive is verified. Type ${ops.project} to go on`,
          );
          return typed?.trim() === ops.project;
        },
        nothing: `Nothing left to archive: ${ops.project} is archived.`,
        finished: () => {
          const { bucket, prefix, manifestSha256 } = result();
          const artifactsOnly = isArtifactsOnly(ops);
          return [
            artifactsOnly
              ? `Archived ${ops.project}. Commit gq.ops.json in this checkout: its Artifacts repository is deleted, so there is nowhere to push it.`
              : archivesRepository
                ? `Archived ${ops.project}. gq.ops.json's record is pushed.`
                : `Archived ${ops.project}, but not its repository yet: push gq.ops.json to ${site.repository.defaultBranch}, then run gq offboard --archive again.`,
            `  Archive:    r2://${bucket}/${prefix} (manifest.json sha256 ${manifestSha256})`,
            artifactsOnly
              ? hasCodeBundle()
                ? `  Code:       r2://${bucket}/${prefix}code.bundle (every ref of the Artifacts repository ${artifactsRepositoryName(ops)}, which is deleted)`
                : `  Code:       none (the Artifacts repository ${artifactsRepositoryName(ops)} had no refs, so no bundle was created)`
              : `  Code:       https://github.com/${ops.github.repository} (${archivesRepository ? "archived, read-only" : "not archived yet"})`,
            `  Secrets:    Sigillo project ${ops.sigillo?.projectId ?? "(gq.ops.json sigillo.projectId)"}, kept`,
          ].join("\n");
        },
      });
    },
    { archive: true },
  );
}
