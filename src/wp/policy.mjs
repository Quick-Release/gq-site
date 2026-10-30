// Which WP-CLI commands `gq wp` (break-glass, gq-platform ADR 0011) runs on
// the production CMS. An allowlist: a few reads and single-object writes
// through WordPress's own APIs, so every content write leaves a revision.
// Raw SQL, PHP evaluation and bulk or destructive commands are refused by
// name, everything else as not on the list.

// Command → { write, check(positionals, flags) }: `check` returns a reason to
// refuse, or nothing.
const ALLOWED = new Map([
  ["core version", { write: false }],
  ["post get", { write: false, check: oneId }],
  ["post list", { write: false }],
  ["post meta get", { write: false, check: oneId }],
  ["post meta list", { write: false, check: oneId }],
  ["plugin list", { write: false }],
  ["theme list", { write: false }],
  ["post update", { write: true, check: postUpdate }],
  ["post meta update", { write: true, check: oneId }],
  ["post meta delete", { write: true, check: oneId }],
  ["transient delete", { write: true }],
  ["cache flush", { write: true }],
  ["rewrite flush", { write: true }],
]);

const RAW_SQL = new Set(["db", "eval", "eval-file", "shell"]);
const DESTRUCTIVE = [
  "search-replace",
  "site empty",
  "site delete",
  "post delete",
  "post generate",
  "comment delete",
  "term delete",
  "user delete",
  "user remove-role",
  "plugin delete",
  "plugin uninstall",
  "theme delete",
  "option delete",
  "menu delete",
  "widget reset",
];

// Global parameters that would run code, change the target or bypass gq.
const REFUSED_GLOBALS = new Set(["ssh", "http", "path", "url", "exec", "require", "prompt"]);

function oneId(positionals) {
  if (!/^[1-9][0-9]*$/u.test(positionals[0] ?? "")) return "it needs one post ID first";
  return undefined;
}

function postUpdate(positionals, flags) {
  const [id, file, ...rest] = positionals;
  if (!/^[1-9][0-9]*$/u.test(id ?? "")) return "it needs one post ID";
  if (/^[0-9]+$/u.test(file ?? "") || rest.length > 0) return "it updates one post at a time";
  if (file === "-") return "content comes from a local file, not STDIN";
  if (flags.has("post_content")) return "content comes from a local file, not --post_content";
  return undefined;
}

function split(args) {
  const positionals = [];
  const flags = new Map();
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [name, ...value] = arg.slice(2).split("=");
      flags.set(name, value.length > 0 ? value.join("=") : true);
    } else positionals.push(arg);
  }
  return { positionals, flags };
}

/**
 * Classifies a WP-CLI command line (`wp`'s arguments). Resolves to
 * { command, write, positionals, flags }, or throws why it is refused.
 */
export function classifyWpCommand(args) {
  if (args.length === 0)
    throw new Error("Name a WP-CLI command after --, such as gq wp -- post get 12.");
  const { positionals, flags } = split(args);
  for (const name of flags.keys()) {
    const bare = name.replace(/^no-/u, "");
    if (REFUSED_GLOBALS.has(bare))
      throw new Error(`Refusing --${name}: gq wp chooses the host and runs no PHP of its own.`);
  }
  const [first] = positionals;
  if (RAW_SQL.has(first)) {
    throw new Error(
      `Refusing wp ${first}: raw SQL and PHP evaluation are never break-glass. Back up with gq db backup; read with the commands gq wp allows.`,
    );
  }
  const two = positionals.slice(0, 2).join(" ");
  const three = positionals.slice(0, 3).join(" ");
  const destructive = DESTRUCTIVE.find((name) => name === first || name === two || name === three);
  if (destructive)
    throw new Error(
      `Refusing wp ${destructive}: bulk or destructive commands are never break-glass.`,
    );
  const command = ALLOWED.has(three) ? three : ALLOWED.has(two) ? two : null;
  if (!command) {
    throw new Error(
      `wp ${positionals.slice(0, 2).join(" ")} isn't on gq wp's list: ${[...ALLOWED.keys()].join(", ")}.`,
    );
  }
  const rule = ALLOWED.get(command);
  const rest = positionals.slice(command.split(" ").length);
  if (rule.write && flags.has("all"))
    throw new Error(`Refusing wp ${command} --all: bulk writes are never break-glass.`);
  const reason = rule.check?.(rest, flags);
  if (reason) throw new Error(`Refusing wp ${command}: ${reason}.`);
  return { command, write: rule.write, positionals: rest, flags };
}

export const ALLOWED_WP_COMMANDS = [...ALLOWED.keys()];
