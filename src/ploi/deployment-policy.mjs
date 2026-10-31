// A Site's deployment policy (gq.ops.json `deployment`, see
// docs/reference/deployment-policy.md). A Site without the block deploys as
// it always has. A protected Site states its state explicitly: only
// "authorized" deploys; "paused" and "reserved" refuse every deploy, before
// anything is uploaded, synced or deployed. No flag lifts a deployment hold: a reviewed
// Site change to gq.ops.json does. Offboarding is refused separately and
// earlier, for every command that could expose the Site (offboard/guard.mjs).
//
// A release checks every policy that applies to it: the working tree's, the
// release commit's and the default branch's current one, which a release
// can't proceed without (readDefaultBranchManifest). An old commit that
// predates a hold doesn't carry it, so the current policy is what holds it.
import { validateManifest } from "../manifest/manifest.mjs";

// Why `ops` (a validated manifest) can't be deployed now, or null. `source`
// names where its gq.ops.json came from.
export function deploymentRefusal(ops, source = "gq.ops.json") {
  const policy = ops.deployment;
  if (!policy || policy.state === "authorized") return null;
  const who = policy.state === "reserved" ? ` is reserved by ${policy.holder}` : " is paused";
  return (
    `${ops.project}${who} (${source} deployment.state: ${policy.state}): ${policy.reason}. ` +
    "Nothing was uploaded, synced or deployed. " +
    'A reviewed Site change that sets deployment.state to "authorized" lifts the deployment hold.'
  );
}

// Throws deploymentRefusal(ops) when there is one.
export function assertDeploymentAllowed(ops) {
  const refusal = deploymentRefusal(ops);
  if (refusal) throw new Error(refusal);
}

// The Composer packages a deploy of `ops` verifies (deployment.guardedPackages).
export function guardedPackages(ops) {
  return ops.deployment?.guardedPackages ?? [];
}

// Every policy a release must pass: `manifests` are [{ ops, source }]
// (validated manifests and where each came from). Throws the first refusal:
// an offboarded manifest, or (unless `holds` is false, for preparing a commit
// without deploying it) a held one, or manifests naming different approval
// targets. Resolves to the union of their guarded packages and the approval
// target they name.
export function releasePolicy(manifests, { holds = true } = {}) {
  for (const { ops, source } of manifests) {
    if (ops.offboarded) {
      throw new Error(
        `${ops.project} is offboarded (${source} offboarded): a release would expose it again. Nothing was uploaded, synced or deployed.`,
      );
    }
    const refusal = holds ? deploymentRefusal(ops, source) : null;
    if (refusal) throw new Error(refusal);
  }
  const guarded = [...new Set(manifests.flatMap(({ ops }) => guardedPackages(ops)))];
  const targets = manifests.filter(({ ops }) => ops.deployment?.approval);
  const target = targets[0]?.ops.deployment.approval;
  for (const { ops, source } of targets) {
    const { stage, slot } = ops.deployment.approval;
    if (stage !== target.stage || slot !== target.slot) {
      throw new Error(
        `${source} names approval target ${stage} slot ${slot}, but ${targets[0].source} names ${target.stage} slot ${target.slot}; nothing was uploaded or deployed.`,
      );
    }
  }
  return { guarded, target };
}

// The validated manifest at `manifestPath` on the default branch of `source`
// (origin, or the authoritative remote's URL in CI), read through `git` (a
// runner resolving to stdout or throwing) without touching any working tree:
// only FETCH_HEAD and objects change. Throws when the default branch or its
// manifest can't be read: a release refuses without it. `local` reads the
// fetched commit (no network, so no credential).
export async function readDefaultBranchManifest(git, manifestPath, local = git, source = "origin") {
  const refuse = (detail, cause) =>
    new Error(
      `The default branch's ${manifestPath} can't be read (${detail}), so its current deployment policy can't be checked: a release refuses without it. Nothing was uploaded, synced or deployed.`,
      { cause },
    );
  let branch;
  try {
    const head = await git(["ls-remote", "--symref", source, "HEAD"]);
    branch = /^ref: refs\/heads\/(\S+)\tHEAD$/mu.exec(head)?.[1];
  } catch (error) {
    throw refuse(error.message, error);
  }
  if (!branch) throw refuse(`${source === "origin" ? "origin" : "the remote"} names no default branch`);
  let text;
  try {
    await git(["fetch", "--quiet", "--no-tags", source, `refs/heads/${branch}`]);
    text = await local(["show", `FETCH_HEAD:${manifestPath}`]);
  } catch (error) {
    throw refuse(error.message, error);
  }
  try {
    return validateManifest(JSON.parse(text));
  } catch (error) {
    throw refuse(error.message, error);
  }
}
