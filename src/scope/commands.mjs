import { tmpdir } from "node:os";
import { join } from "node:path";

import { fenceToolCall } from "./fence.mjs";
import {
  DEFAULT_CODE_ROOT,
  DEFAULT_WORKSPACES_ROOT,
  ORGANIZATION,
  REPOSITORIES,
} from "./repositories.mjs";
import { mentionedRepositories, routingNote } from "./route.mjs";

export const SCOPE_USAGE = ["gq scope route [--hook] [<request>...]", "gq scope fence --hook"];

// Agent harness hooks that keep a session in the repository it works in
// (gq-platform ADR 0001). `route` tells the agent which other repositories a
// request names and who owns them; `fence` denies tool calls that write
// outside the repository. Both read Claude Code's hook JSON on stdin with
// --hook, and step aside when GQ_SCOPE=off.
export function isScopeCommand(argv) {
  return argv[0] === "scope";
}

// Resolves to an exit code.
export async function runScopeCommand(argv, { cwd, env, exec, stdin, io }) {
  const [, action, ...rest] = argv;
  const hook = rest.includes("--hook");
  const words = rest.filter((arg) => arg !== "--hook");
  if (action !== "route" && action !== "fence") {
    throw new Error(`Usage:\n${SCOPE_USAGE.map((usage) => `  ${usage}`).join("\n")}`);
  }
  if (action === "fence" && !hook)
    throw new Error("gq scope fence reads a hook call: pass --hook.");
  if (String(env.GQ_SCOPE ?? "").toLowerCase() === "off") return 0;

  const input = hook ? JSON.parse((await readAll(stdin)) || "{}") : {};
  const directory = env.CLAUDE_PROJECT_DIR || input.cwd || cwd;
  const place = await locate(directory, { env, exec });
  if (!place) return 0;

  if (action === "route") {
    const request = hook ? (input.prompt ?? input.prompt_text ?? "") : words.join(" ");
    const mentioned = mentionedRepositories(request, { current: place.repository });
    if (mentioned.length === 0) {
      if (!hook)
        io.out(
          `${request ? "The request names" : "Nothing names"} no repository besides ${place.repository}.`,
        );
      return 0;
    }
    const note = routingNote(mentioned, { current: place.repository, codeRoot: place.codeRoot });
    io.out(
      hook
        ? JSON.stringify({
            hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: note },
          })
        : note,
    );
    return 0;
  }

  const reason = fenceToolCall({ toolName: input.tool_name, toolInput: input.tool_input }, place);
  if (reason) {
    io.out(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
  }
  return 0;
}

// The repository a directory belongs to: its worktree root and its name in
// the ownership map, from the `origin` remote. Null outside a GETQUICK
// repository, where neither hook has anything to say.
async function locate(directory, { env, exec }) {
  const root = await gitOutput(exec, directory, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;
  const origin = await gitOutput(exec, root, ["remote", "get-url", "origin"]);
  const match = origin?.match(new RegExp(`[/:]${ORGANIZATION}/([^/]+?)(?:\\.git)?$`, "u"));
  if (!match) return null;
  const repository = match[1];
  if (!REPOSITORIES.some((entry) => entry.name === repository)) return null;
  return {
    root,
    repository,
    codeRoot: env.GQ_CODE_ROOT || DEFAULT_CODE_ROOT,
    workspacesRoot: env.GQ_WORKSPACES_ROOT || DEFAULT_WORKSPACES_ROOT,
    allowed: [
      tmpdir(),
      "/tmp",
      env.TMPDIR,
      "/data/agents/scratch",
      env.HOME && join(env.HOME, ".claude"),
      ...String(env.GQ_SCOPE_ALLOW ?? "").split(":"),
    ].filter(Boolean),
  };
}

async function gitOutput(exec, cwd, args) {
  try {
    const result = await exec("git", args, { cwd });
    const output = String(result?.stdout ?? "").trim();
    return result?.code === 0 && output ? output : null;
  } catch {
    return null;
  }
}

async function readAll(stream) {
  if (!stream) return "";
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}
