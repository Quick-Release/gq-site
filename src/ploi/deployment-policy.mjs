// A Site's deployment policy (gq.ops.json `deployment`, see
// docs/reference/deployment-policy.md). A Site without the block deploys as
// it always has. A protected Site states its state explicitly: only
// "authorized" deploys; "paused" and "reserved" refuse every deploy, before
// anything is uploaded, synced or deployed. No flag lifts a hold: a reviewed
// Site change to gq.ops.json does. Offboarding is refused separately and
// earlier, for every command that could expose the Site (offboard/guard.mjs).

// Why `ops` (a validated manifest) can't be deployed now, or null.
export function deploymentRefusal(ops) {
  const policy = ops.deployment;
  if (!policy || policy.state === "authorized") return null;
  const who = policy.state === "reserved" ? ` is reserved by ${policy.holder}` : " is paused";
  return (
    `${ops.project}${who} (gq.ops.json deployment.state: ${policy.state}): ${policy.reason}. ` +
    "Nothing was uploaded, synced or deployed. " +
    'A reviewed Site change that sets deployment.state to "authorized" lifts the hold.'
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
