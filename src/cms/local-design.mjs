// The local Design source override:
// a developer opts in with an ignored apps/cms/.local-plugins/config.json
// naming a Design checkout (gq-design or legacy getquick-design), symlinked over the
// registry copy and bind-mounted into DDEV. Composer only ever sees the
// registry copy: dependency changes unlink the checkout, run, and relink under
// a filesystem lock. CI never consults the override.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hostname } from "node:os";

const designSlugs = ["gq-design", "getquick-design"];
const composeHeader =
  "# Generated from ignored .local-plugins/config.json; local development only.\n";
const hooksHeader = "# Generated local-only hooks; not shipped to CI or staging.\n";

function stat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function validateDestinations(cmsRoot) {
  // A symlinked ancestor could alias the checkout despite a normal final entry.
  for (const path of [
    join(cmsRoot, ".local-plugins"),
    join(cmsRoot, "web"),
    join(cmsRoot, "web/app"),
    join(cmsRoot, "web/app/plugins"),
    join(cmsRoot, ".ddev"),
  ]) {
    const entry = stat(path);
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
      throw new Error(`Refusing an unsafe local plugin ancestor: ${path}`);
    }
  }
}

// Opt-in state stays outside Git. CI never consults a developer's override.
export function localDesignOverride(cmsRoot, env) {
  if (env.CI) return null;
  const state = join(cmsRoot, ".local-plugins");
  const config = join(state, "config.json");
  if (!existsSync(config)) return null;
  validateDestinations(cmsRoot);
  const { gqDesign, getquickDesign } = JSON.parse(readFileSync(config, "utf8"));
  if (gqDesign !== undefined && getquickDesign !== undefined && gqDesign !== getquickDesign) {
    throw new Error(`${config} has conflicting gqDesign and getquickDesign checkout paths.`);
  }
  const checkout = gqDesign ?? getquickDesign;
  if (typeof checkout !== "string" || !isAbsolute(checkout)) {
    throw new Error(`${config} needs an absolute gqDesign (or getquickDesign) checkout path.`);
  }
  const source = realpathSync(checkout);
  const withinCms = relative(realpathSync(cmsRoot), source);
  if (!withinCms.startsWith("../") && !isAbsolute(withinCms)) {
    throw new Error("The Design source checkout must be outside apps/cms.");
  }
  const slug = designSlugs.find((name) => stat(join(source, `${name}.php`))?.isFile());
  if (!stat(source)?.isDirectory() || !slug) {
    throw new Error(`Not a Design checkout: ${source}`);
  }
  const slots = designSlugs.map((name) => ({
    slug: name,
    plugin: join(cmsRoot, "web/app/plugins", name),
    backup: join(state, `${name}-release`),
    compose: join(cmsRoot, `.ddev/docker-compose.${name}.local.yaml`),
    hooks: join(cmsRoot, `.ddev/config.${name}.local.yaml`),
  }));
  return {
    source,
    state,
    slug,
    slots,
    ...slots.find((slot) => slot.slug === slug),
    lock: join(state, "design-operation.lock"),
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true; // Permission errors are not evidence that the owner is dead.
  }
}

function recoverLock(override) {
  if (!stat(override.lock)?.isDirectory() || stat(override.lock)?.isSymbolicLink()) {
    throw new Error("The existing operation lock is not a safe directory.");
  }
  const recovery = `${override.lock}.recovery`;
  // Serialize stale-lock reclamation so two callers cannot remove a new lock.
  mkdirSync(recovery);
  try {
    const owner = JSON.parse(readFileSync(join(override.lock, "owner.json"), "utf8"));
    if (
      owner.host !== hostname() ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      processAlive(owner.pid)
    ) {
      throw new Error("The operation owner is still alive or cannot be verified.");
    }
    const command = join(override.lock, "command.pid");
    if (existsSync(command)) {
      const pid = Number(readFileSync(command, "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0 || processAlive(pid)) {
        throw new Error("The Composer/DDEV child is still alive or cannot be verified.");
      }
      unlinkSync(command);
    }
    unlinkSync(join(override.lock, "owner.json"));
    rmdirSync(override.lock);
  } finally {
    rmdirSync(recovery);
  }
}

function locked(override, action) {
  const label = override.label ?? "Design";
  mkdirSync(override.state, { recursive: true });
  if (existsSync(`${override.lock}.recovery`)) {
    const error = new Error(`Another local ${label} operation is recovering its lock.`);
    error.code = "CMS_LOCAL_OPERATION_BUSY";
    throw error;
  }
  try {
    mkdirSync(override.lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      recoverLock(override);
      mkdirSync(override.lock);
    } catch (cause) {
      const error = new Error(
        `Another local ${label} operation is running or needs inspection (${override.lock}): ${cause.message}`,
      );
      error.code = "CMS_LOCAL_OPERATION_BUSY";
      throw error;
    }
  }
  writeFileSync(
    join(override.lock, "owner.json"),
    JSON.stringify({ pid: process.pid, host: hostname() }),
  );
  const release = () => {
    const command = join(override.lock, "command.pid");
    if (existsSync(command)) unlinkSync(command);
    unlinkSync(join(override.lock, "owner.json"));
    rmdirSync(override.lock);
  };
  let result;
  try {
    result = action();
  } catch (error) {
    release();
    throw error;
  }
  if (result instanceof Promise) return result.finally(release);
  release();
  return result;
}

// Also serialize background-start launchers, before they publish a new job.
export function withCmsLocalOperation(cmsRoot, name, action) {
  validateDestinations(cmsRoot);
  if (!/^[a-z-]+$/u.test(name)) throw new Error("Invalid local operation name.");
  const state = join(cmsRoot, ".local-plugins");
  return locked({ state, lock: join(state, `${name}-operation.lock`), label: name }, action);
}

// Record the exec'd child PID before it runs. If this Node process is killed,
// startup may reclaim its lock only after that command is also gone. Pending
// or unverified ownership is conservatively refused, never deleted blindly.
// `options` goes to run()'s exec as is (cwd, env, output streams).
export function runDesignCommand(exec, command, args, override, options) {
  if (!override) return exec(command, args, options);
  const pidFile = join(override.lock, "command.pid");
  writeFileSync(pidFile, "pending");
  return exec(
    "sh",
    ["-c", 'printf "%s\\n" "$$" > "$1"; shift; exec "$@"', "sh", pidFile, command, ...args],
    options,
  );
}

function inspect(override, restored = new Set()) {
  // Validate BOTH names before mutating either. Backups stay under their own
  // slug: an old package's directory must never masquerade as gq-design.
  return override.slots.map((slot) => {
    const plugin = stat(slot.plugin);
    const backup = stat(slot.backup);
    if (backup && (!backup.isDirectory() || backup.isSymbolicLink())) {
      throw new Error(`Refusing an unsafe registry backup: ${slot.backup}`);
    }
    if (stat(`${slot.backup}.previous`)) {
      throw new Error(`A registry backup replacement needs inspection: ${slot.backup}.previous`);
    }
    for (const file of [slot.compose, slot.hooks]) {
      const entry = stat(file);
      if (entry && (!entry.isFile() || entry.isSymbolicLink())) {
        throw new Error(`Refusing an unsafe local DDEV file: ${file}`);
      }
      if (
        entry &&
        !readFileSync(file, "utf8").startsWith(file === slot.compose ? composeHeader : hooksHeader)
      ) {
        throw new Error(`Refusing to replace a non-generated local DDEV file: ${file}`);
      }
    }
    if (plugin?.isSymbolicLink()) {
      const target = resolve(dirname(slot.plugin), readlinkSync(slot.plugin));
      // Only the exact dangling sibling produced by the checkout rename may
      // be migrated. A live checkout or unrelated dangling link is not ours.
      const renamed =
        slot.slug !== override.slug &&
        basename(override.source) === override.slug &&
        target === join(dirname(override.source), slot.slug) &&
        !stat(target) &&
        backup;
      if (target !== override.source && !renamed) {
        throw new Error(`Refusing to replace a different plugin symlink: ${slot.plugin}`);
      }
    } else if (plugin && !plugin.isDirectory()) {
      throw new Error(`Refusing to replace a non-directory: ${slot.plugin}`);
    } else if (plugin && backup && !restored.has(slot.slug)) {
      throw new Error(
        "Both the installed Design directory and its backup exist; refusing to overwrite either.",
      );
    }
    return { ...slot, installed: plugin, saved: backup };
  });
}

function saveRegistry(slot) {
  if (!slot.saved) {
    renameSync(slot.plugin, slot.backup);
    return;
  }
  // Keep the previous release until its replacement is safely in place.
  // Only a copy restored by THIS locked install can reach this branch.
  const previous = `${slot.backup}.previous`;
  renameSync(slot.backup, previous);
  try {
    renameSync(slot.plugin, slot.backup);
  } catch (error) {
    renameSync(previous, slot.backup);
    throw error;
  }
  rmSync(previous, { recursive: true });
}

function link(override, restored) {
  const slots = inspect(override, restored);
  for (const slot of slots) {
    if (slot.installed?.isSymbolicLink()) {
      if (slot.slug !== override.slug) unlinkSync(slot.plugin);
    } else if (slot.installed) {
      saveRegistry(slot);
    }
  }
  if (!stat(override.plugin)) {
    mkdirSync(dirname(override.plugin), { recursive: true });
    symlinkSync(override.source, override.plugin, "dir");
  }
  // Quote paths as YAML strings. Mount the identical absolute path so both
  // Composer on the host and WordPress in DDEV can resolve the same symlink.
  const path = JSON.stringify(override.source);
  const compose = `${composeHeader}services:\n  web:\n    volumes:\n      - type: bind\n        source: ${path}\n        target: ${path}\n        read_only: true\n        bind:\n          create_host_path: false\n`;
  mkdirSync(join(override.compose, ".."), { recursive: true });
  if (!existsSync(override.compose) || readFileSync(override.compose, "utf8") !== compose) {
    writeFileSync(override.compose, compose);
  }
  // DDEV runs exec-host hooks in apps/cms; the site's own gq is the
  // @getquick/site its root package.json pins.
  const hooks = `${hooksHeader}hooks:\n  pre-start:\n    - exec-host: ../../node_modules/.bin/gq cms design\n  post-start:\n    - exec-host: ../../node_modules/.bin/gq cms design refresh\n`;
  if (!existsSync(override.hooks) || readFileSync(override.hooks, "utf8") !== hooks) {
    writeFileSync(override.hooks, hooks);
  }
  for (const slot of slots.filter((slot) => slot.slug !== override.slug)) {
    for (const file of [slot.compose, slot.hooks]) {
      if (stat(file)) unlinkSync(file);
    }
  }
}

export function syncLocalDesign(cmsRoot, env) {
  const override = localDesignOverride(cmsRoot, env);
  if (!override) return false;
  locked(override, () => link(override));
  return true;
}

export function withLinkedLocalDesign(cmsRoot, action, env) {
  const override = localDesignOverride(cmsRoot, env);
  if (!override) return null;
  return locked(override, () => {
    link(override);
    return action(override);
  });
}

// `action` may be async; the checkout is relinked, and `afterRelink` run, once
// it settles, still under the lock and also when it fails, before its error
// is propagated.
export async function withDesignRegistryInstall(cmsRoot, action, { env, afterRelink = () => {} }) {
  const override = localDesignOverride(cmsRoot, env);
  if (!override) {
    // A missing/disabled opt-in must not hand an existing symlink to Composer.
    // Normal CI/staging installs are ordinary directories and take this path.
    validateDestinations(cmsRoot);
    if (
      designSlugs.some((slug) => stat(join(cmsRoot, "web/app/plugins", slug))?.isSymbolicLink())
    ) {
      throw new Error(
        "Refusing Composer dependency changes on a Design symlink without an active local override.",
      );
    }
    return action(null);
  }
  return locked(override, async () => {
    // Capture an ordinary initial install too, before Composer can remove it.
    link(override);
    const slots = inspect(override);
    const restored = new Set();
    try {
      for (const slot of slots) {
        if (slot.installed?.isSymbolicLink()) unlinkSync(slot.plugin);
        if ((!slot.installed || slot.installed.isSymbolicLink()) && slot.saved) {
          // Composer may remove the OLD package during a rename, or delete a
          // directory before failing. Keep its backup until a replacement exists.
          mkdirSync(dirname(slot.plugin), { recursive: true });
          try {
            cpSync(slot.backup, slot.plugin, { recursive: true });
          } catch (error) {
            // A partial copy is not a restored release: keep the intact backup
            // and remove only the destination created by this locked attempt.
            rmSync(slot.plugin, { recursive: true, force: true });
            throw error;
          }
          restored.add(slot.slug);
        }
      }
      return await action(override);
    } finally {
      link(override, restored);
      await afterRelink(override);
    }
  });
}
