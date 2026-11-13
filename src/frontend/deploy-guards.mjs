// The managed Frontend deploy's guards around `alchemy deploy`, shared by the
// content and commerce `infra/scripts/deploy-frontend.mjs`. They exist for
// Alchemy hop 2 (docs/research/alchemy-cloudflare-package-migration.md):
//
// - From 2.0.0-beta.85 a full deploy unbinds every secret it doesn't declare,
//   and frontend.run.ts declares a secret only when its variable is set. A
//   deploy that would drop a secret the Worker has bound is refused unless
//   `--drop-secret <NAME>` names it.
// - From beta.85 Alchemy upgrades the account's Cloudflare state store to v8
//   whenever `--yes` is passed, a `--dry-run` included, and older Alchemy
//   can't plan or deploy against a v8 store. The upgrade happens only with
//   `--upgrade-state-store`.
// - A plan (`--dry-run`) is read by a machine check: a replaced, deleted or
//   orphaned resource, an unbound binding or a removed env entry fails it,
//   and a compatibility-flag change is reported.
// - A deploy compares the Worker's bindings and compatibility flags before
//   and after: a binding that disappeared fails it, a flag change is reported.
//
// Secret values are never read or printed: the Cloudflare API returns names.
import { stripVTControlCharacters } from "node:util";

const API = "https://api.cloudflare.com/client/v4";
export const STATE_STORE_WORKER = "alchemy-state-store";
const STATE_STORE_VERSION_BINDING = "ALCHEMY_STATE_STORE_VERSION";

/** The deploy wrapper's own flags, removed before the rest reach Alchemy. */
export function parseDeployArguments(argv) {
  const alchemyArgs = [];
  const dropSecrets = new Set();
  let upgradeStateStore = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--drop-secret" || argument.startsWith("--drop-secret=")) {
      const name = argument.includes("=")
        ? argument.slice(argument.indexOf("=") + 1)
        : argv[++index];
      if (!name || name.startsWith("-")) {
        throw new Error("--drop-secret needs the secret's name: --drop-secret <NAME>.");
      }
      dropSecrets.add(name);
    } else if (argument === "--upgrade-state-store") {
      upgradeStateStore = true;
    } else {
      alchemyArgs.push(argument);
    }
  }
  return {
    alchemyArgs,
    dropSecrets,
    upgradeStateStore,
    dryRun: alchemyArgs.includes("--dry-run"),
    detailed: alchemyArgs.includes("--detailed"),
  };
}

async function cloudflare(fetch, token, path) {
  const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 404) return undefined;
  const body = await response.json().catch(() => undefined);
  if (!response.ok || !body?.success) {
    const codes = (body?.errors ?? []).map((error) => error.code).join(", ");
    throw new Error(
      `the Cloudflare API refused GET ${path.replace(/^\/accounts\/[^/]+/u, "/accounts/…")} (HTTP ${response.status}${codes ? `, error ${codes}` : ""}).`,
    );
  }
  return body.result;
}

/**
 * A Worker's bindings (names and types only) and compatibility settings, or
 * `undefined` when the account has no Worker of that name.
 */
export async function workerSettings({ accountId, token, scriptName, fetch = globalThis.fetch }) {
  const result = await cloudflare(
    fetch,
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
  );
  if (result === undefined) return undefined;
  const bindings = (result.bindings ?? []).map(({ name, type }) => ({ name, type }));
  return {
    bindings,
    secrets: bindings.filter((binding) => binding.type === "secret_text").map(({ name }) => name),
    compatibilityDate: result.compatibility_date,
    compatibilityFlags: [...(result.compatibility_flags ?? [])],
  };
}

/**
 * The protocol version the account's state store runs, as Alchemy beta.85+
 * reads it: the version binding its Worker records, `7` for a Worker an
 * older Alchemy deployed without one, `undefined` for no store.
 */
export async function stateStoreVersion({ accountId, token, fetch = globalThis.fetch }) {
  const result = await cloudflare(
    fetch,
    token,
    `/accounts/${accountId}/workers/scripts/${STATE_STORE_WORKER}/settings`,
  );
  if (result === undefined) return undefined;
  const binding = (result.bindings ?? []).find((b) => b.name === STATE_STORE_VERSION_BINDING);
  const version = Number(binding?.text);
  return Number.isInteger(version) ? version : 7;
}

/** The state-store protocol an `@alchemy.run/cloudflare` version speaks. */
export function storeProtocolOf(cloudflareVersion) {
  const beta = /^2\.0\.0-beta\.(\d+)$/u.exec(cloudflareVersion ?? "");
  if (beta === null) {
    throw new Error(
      `@alchemy.run/cloudflare ${cloudflareVersion} isn't a 2.0.0 beta this deploy knows the state-store protocol of.`,
    );
  }
  return Number(beta[1]) >= 85 ? 8 : 7;
}

/**
 * The secrets the Worker has bound that this deploy would unbind: the managed
 * frontend.run.ts binds a secret under the name of the variable it comes
 * from, and only when that variable is set.
 */
export function droppedSecrets({ bound, env, allowed = new Set() }) {
  return bound.filter((name) => !env[name]?.trim() && !allowed.has(name));
}

const LOG_PREFIX = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] [A-Z]+(?: \(#\d+\))?: /u;
const RESOURCE_LINE = /^\[([^\]]+)\] ([a-z]+)\b/u;

/**
 * Reads `alchemy deploy --dry-run` text output (beta.86's plain renderer;
 * Alchemy has no structured plan output: `--log-format json` prints no plan)
 * into what the hop-2 review refuses.
 */
export function checkPlan(output) {
  const lines = stripVTControlCharacters(output)
    .split(/\r?\n/u)
    .map((line) => line.replace(LOG_PREFIX, ""));
  const result = {
    summary: undefined,
    resources: [],
    replaced: [],
    deleted: [],
    orphaned: [],
    unbound: [],
    removedEnv: [],
    compatibility: [],
    detailed: false,
  };
  let resource;
  let section; // { kind: "env" | "flags", indent }
  let envChanges; // per resource: Map key -> Set("-" | "+")
  let flags; // per resource: { "-": [], "+": [] }
  const flush = () => {
    if (resource === undefined) return;
    for (const [key, markers] of envChanges) {
      if (markers.has("-") && !markers.has("+")) result.removedEnv.push(`${resource}.env.${key}`);
    }
    const removed = flags["-"].filter((flag) => !flags["+"].includes(flag));
    const added = flags["+"].filter((flag) => !flags["-"].includes(flag));
    if (removed.length > 0 || added.length > 0) {
      result.compatibility.push({ resource, removed, added });
    }
  };
  for (const line of lines) {
    if (line.startsWith("Plan:")) {
      result.summary = line;
      continue;
    }
    const match = RESOURCE_LINE.exec(line);
    if (match !== null) {
      const [, fqn, action] = match;
      if (fqn.includes("/") && action === "unbind") {
        result.unbound.push(fqn);
        continue;
      }
      if (fqn.includes("/") && resource !== undefined && fqn.startsWith(`${resource}/`)) continue;
      flush();
      resource = fqn;
      section = undefined;
      envChanges = new Map();
      flags = { "-": [], "+": [] };
      result.resources.push({ fqn, action });
      if (action === "replace") result.replaced.push(fqn);
      if (action === "delete") result.deleted.push(fqn);
      if (action === "orphaned") result.orphaned.push(fqn);
      continue;
    }
    if (resource === undefined || !line.startsWith("  ")) continue;
    // A detailed plan's property document, two spaces in: an unchanged line
    // is the YAML line itself (`properties:` at column 0, its keys from
    // column 2), a changed one is `- ` or `+ ` and then the YAML line.
    const body = line.slice(2);
    if (body.trim() === "properties:") {
      result.detailed = true;
      continue;
    }
    const changed = (body[0] === "-" || body[0] === "+") && body[1] === " ";
    const marker = changed ? body[0] : " ";
    const yaml = changed ? body.slice(2) : body;
    const indent = yaml.length - yaml.trimStart().length;
    const text = yaml.trim();
    if (section !== undefined && indent <= section.indent && text !== "") section = undefined;
    if (text === "env:") {
      section = { kind: "env", indent };
      continue;
    }
    if (text === "flags:") {
      section = { kind: "flags", indent };
      continue;
    }
    if (section?.kind === "env" && indent === section.indent + 2 && marker !== " ") {
      const key = /^([^:\s]+):/u.exec(text)?.[1];
      if (key !== undefined) {
        if (!envChanges.has(key)) envChanges.set(key, new Set());
        envChanges.get(key).add(marker);
      }
    }
    if (section?.kind === "flags" && marker !== " " && text.startsWith("- ")) {
      flags[marker].push(text.slice(2).trim());
    }
  }
  flush();
  result.blocking =
    result.replaced.length +
      result.deleted.length +
      result.orphaned.length +
      result.unbound.length +
      result.removedEnv.length >
    0;
  return result;
}

/** What a deploy changed on the Worker: bindings by name, and compatibility. */
export function compareWorkerSettings(before, after) {
  const names = (settings) => new Set((settings?.bindings ?? []).map((b) => b.name));
  const was = names(before);
  const is = names(after);
  const flagsBefore = before?.compatibilityFlags ?? [];
  const flagsAfter = after?.compatibilityFlags ?? [];
  return {
    removedBindings: [...was].filter((name) => !is.has(name)),
    addedBindings: [...is].filter((name) => !was.has(name)),
    flagsRemoved: flagsBefore.filter((flag) => !flagsAfter.includes(flag)),
    flagsAdded: flagsAfter.filter((flag) => !flagsBefore.includes(flag)),
    dateBefore: before?.compatibilityDate,
    dateAfter: after?.compatibilityDate,
  };
}

const list = (names) => names.join(", ");

/**
 * Runs `alchemy deploy` for the production Frontend Worker behind the guards.
 * `runAlchemy(args)` runs the CLI, streaming its output, and resolves to
 * `{ status, output }`. Returns the process exit code; `log` and `error`
 * receive the guards' messages.
 */
export async function guardedFrontendDeploy({
  argv,
  env,
  accountId,
  scriptName,
  cloudflareVersion,
  runAlchemy,
  fetch = globalThis.fetch,
  log = console.log,
  error = console.error,
}) {
  let parsed;
  try {
    parsed = parseDeployArguments(argv);
  } catch (cause) {
    error(cause.message);
    return 1;
  }
  const { alchemyArgs, dropSecrets, upgradeStateStore, dryRun, detailed } = parsed;
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token || !accountId) {
    error(
      "The Frontend deploy reads the Worker's bindings and the account's state store through the " +
        "Cloudflare API before Alchemy runs: CLOUDFLARE_API_TOKEN and the account " +
        "(gq.ops.json cloudflare.accountId) must be set. Run it through gq sigillo run staging.",
    );
    return 1;
  }

  let protocol;
  let store;
  let before;
  try {
    protocol = storeProtocolOf(cloudflareVersion);
    store = await stateStoreVersion({ accountId, token, fetch });
    before = await workerSettings({ accountId, token, scriptName, fetch });
  } catch (cause) {
    error(`Before deploying, ${cause.message}`);
    return 1;
  }

  // The account's store and this Alchemy. beta.85+ upgrades a v7 store on
  // any `--yes` run, and the upgrade can't be undone: every Alchemy project
  // in the account still on beta.84 or older stops deploying.
  if (store !== undefined && store > protocol) {
    error(
      `The account's Alchemy state store runs v${store}, newer than the v${protocol} this ` +
        `@alchemy.run/cloudflare ${cloudflareVersion} speaks: Alchemy can't plan or deploy against ` +
        "it. Update @getquick/site to the release that moves Alchemy (gq sync, pnpm install).",
    );
    return 1;
  }
  const upgrading = store !== undefined && store < protocol;
  if (upgrading && !upgradeStateStore) {
    error(
      `The account's Alchemy state store runs v${store}; @alchemy.run/cloudflare ${cloudflareVersion} ` +
        `upgrades it to v${protocol} on this ${dryRun ? "plan" : "deploy"}. The upgrade is account-wide ` +
        "and can't be undone: afterwards no Alchemy project in the account on beta.84 or older can " +
        "plan or deploy. It happens once, in the hop-2 cutover window, on the first Site " +
        "(CHANGELOG 0.44.0). If this is that run, pass --upgrade-state-store.",
    );
    return 1;
  }
  if (!upgrading && upgradeStateStore) {
    log(
      `The account's state store already runs v${store ?? "(none yet)"}; --upgrade-state-store does nothing.`,
    );
  }

  // Secrets the deploy would unbind.
  if (before !== undefined) {
    const dropped = droppedSecrets({ bound: before.secrets, env, allowed: dropSecrets });
    if (dropped.length > 0) {
      error(
        `${scriptName} has ${list(dropped)} bound, and this ${dryRun ? "plan" : "deploy"} would unbind ` +
          `${dropped.length === 1 ? "it" : "them"}: frontend.run.ts binds a secret only when its ` +
          "variable is set, and Alchemy removes the rest. Set it in Sigillo staging (or the CI " +
          `Worker), or, to remove it on purpose, pass --drop-secret ${dropped[0]}` +
          `${dropped.length > 1 ? " for each" : ""}.`,
      );
      return 1;
    }
    for (const name of dropSecrets) {
      if (!before.secrets.includes(name)) {
        log(`--drop-secret ${name}: ${scriptName} has no such secret bound.`);
      } else if (env[name]?.trim()) {
        log(`--drop-secret ${name}: its variable is set, so this deploy keeps it bound.`);
      }
    }
    log(
      `${scriptName}: compatibility ${before.compatibilityDate ?? "(no date)"}, flags ` +
        `[${before.compatibilityFlags.join(", ")}]; ${before.secrets.length} secret(s) bound, ` +
        `each kept by this ${dryRun ? "plan" : "deploy"}.`,
    );
  }

  // `--yes` lets Alchemy upgrade the store, so a plan passes it only when the
  // upgrade was asked for. A plan needs no approval either way.
  const args = [
    "deploy",
    "--stage",
    "prod",
    "--config",
    "frontend.run.ts",
    ...(dryRun && !upgradeStateStore ? [] : ["--yes"]),
    "--no-input",
    ...alchemyArgs,
  ];
  const { status, output } = await runAlchemy(args);
  if (status !== 0) return status ?? 1;

  if (dryRun) {
    const plan = checkPlan(output);
    log("");
    log(`Plan check (${scriptName}): ${plan.summary ?? "no plan summary found"}`);
    if (plan.summary === undefined) {
      error("No plan was found in Alchemy's output, so nothing was checked.");
      return 1;
    }
    for (const change of plan.compatibility) {
      log(
        `  compatibility flags of ${change.resource}: ` +
          [
            ...change.added.map((flag) => `+${flag}`),
            ...change.removed.map((flag) => `-${flag}`),
          ].join(", "),
      );
    }
    if (!detailed || !plan.detailed) {
      log("  (no --detailed property diff: removed env entries and flag changes aren't checked)");
    }
    const findings = [
      ["replaced", plan.replaced],
      ["deleted", plan.deleted],
      ["orphaned (dropped from state)", plan.orphaned],
      ["unbound", plan.unbound],
      ["env entries removed", plan.removedEnv],
    ].filter(([, names]) => names.length > 0);
    for (const [what, names] of findings) error(`  ✗ ${what}: ${list(names)}`);
    if (plan.blocking) {
      error(
        "The plan replaces, deletes or unbinds something: hop 2 allows none of that. Read it in full " +
          "and fix the cause before deploying.",
      );
      return 1;
    }
    log("  ✓ no replacement, deletion or removed binding");
    return 0;
  }

  let after;
  try {
    after = await workerSettings({ accountId, token, scriptName, fetch });
  } catch (cause) {
    error(`The deploy finished, but reading ${scriptName} back failed: ${cause.message}`);
    return 1;
  }
  const change = compareWorkerSettings(before, after);
  if (change.flagsAdded.length > 0 || change.flagsRemoved.length > 0) {
    log(
      `${scriptName}'s compatibility flags changed: ` +
        [
          ...change.flagsAdded.map((flag) => `+${flag}`),
          ...change.flagsRemoved.map((flag) => `-${flag}`),
        ].join(", ") +
        ". Check the Site works with them.",
    );
  }
  if (before !== undefined && change.dateBefore !== change.dateAfter) {
    log(`${scriptName}'s compatibility date changed: ${change.dateBefore} → ${change.dateAfter}.`);
  }
  if (change.removedBindings.length > 0) {
    error(
      `✗ The deploy removed ${list(change.removedBindings)} from ${scriptName}. Rebind ` +
        `${change.removedBindings.length === 1 ? "it" : "them"} (set the variable and deploy again), ` +
        "or roll back to the previous Worker version in Cloudflare.",
    );
    return 1;
  }
  return 0;
}
