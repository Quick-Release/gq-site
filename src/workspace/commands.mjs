import { loadProjectContext } from "../ops/project-context.mjs";
import { runDoctor } from "./doctor.mjs";
import { runSetup } from "./setup.mjs";
import { runVerify } from "./verify.mjs";

// The site's workspace runners: bootstrap, health check and the check list.
// Like the CMS commands, these parse their own (few) arguments: each takes at
// most the flags listed here, which reach it as `{ <option>: true }`.
const WORKSPACE_COMMANDS = new Map([
  ["setup", { usage: "gq setup [--no-ddev]", flags: { "--no-ddev": "noDdev" }, run: runSetup }],
  ["doctor", { usage: "gq doctor", flags: {}, run: runDoctor }],
  ["verify", { usage: "gq verify [--ci]", flags: { "--ci": "ci" }, run: runVerify }],
]);

export const WORKSPACE_USAGE = [...WORKSPACE_COMMANDS.values()].map(({ usage }) => usage);

export function isWorkspaceCommand(argv) {
  return WORKSPACE_COMMANDS.has(argv[0]);
}

// Resolves to the exit code.
export async function runWorkspaceCommand([name, ...args], { cwd, env, fetch, exec, io }) {
  const command = WORKSPACE_COMMANDS.get(name);
  const options = {};
  for (const argument of args) {
    const option = command.flags[argument];
    if (!option || options[option]) throw new Error(`Usage: ${command.usage}`);
    options[option] = true;
  }
  const context = await loadProjectContext({ cwd, env });
  return command.run(options, { context, env, fetch, exec, io });
}
