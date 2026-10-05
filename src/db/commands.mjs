import { runBackup, runSync } from "./sync.mjs";

// Database sync and backup: live → local only.
// Command → [usage, the options it accepts, runner].
const DB_COMMANDS = new Map([
  ["db sync", ["gq db sync [--yes]", ["yes"], runSync]],
  ["db backup", ["gq db backup", [], runBackup]],
]);

export const DB_USAGE = [...DB_COMMANDS.values()].map(([usage]) => usage);

export function dbCommandOptions(command) {
  return DB_COMMANDS.get(command.join(" "))?.[1];
}

export function isDbCommand(command) {
  return DB_COMMANDS.has(command.join(" "));
}

// Resolves to the command's exit code.
export function runDbCommand(command, dependencies) {
  const [, , runner] = DB_COMMANDS.get(command.join(" "));
  return runner(dependencies);
}
