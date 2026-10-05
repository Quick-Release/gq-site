import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { recordingExec, runGq } from "../support/fixture-site.mjs";

const ROOT = "/data/agents/workspaces/claude/gq-site/scope";

// git as a GETQUICK repository's worktree answers it: its root and its origin.
function gitIn(origin = "git@github.com:Quick-Release/gq-site.git") {
  return recordingExec(({ args }) => {
    if (args.join(" ") === "rev-parse --show-toplevel") return { stdout: `${ROOT}\n` };
    if (args.join(" ") === "remote get-url origin") return { stdout: `${origin}\n` };
    return { code: 1 };
  });
}

const hookCall = (value) => Readable.from([JSON.stringify(value)]);

test("gq scope fence --hook denies a write outside the repository with Claude Code's hook JSON", async () => {
  const result = await runGq(["scope", "fence", "--hook"], {
    cwd: ROOT,
    env: { GQ_CODE_ROOT: "/data/code/getquick" },
    exec: gitIn(),
    stdin: hookCall({
      hook_event_name: "PreToolUse",
      cwd: ROOT,
      tool_name: "Edit",
      tool_input: { file_path: "/data/code/getquick/gq-platform/docs/adr/0001-x.md" },
    }),
  });

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /Quick-Release\/gq-platform/u);
});

test("gq scope fence --hook says nothing for a write inside the repository", async () => {
  const result = await runGq(["scope", "fence", "--hook"], {
    cwd: ROOT,
    exec: gitIn(),
    stdin: hookCall({ tool_name: "Bash", tool_input: { command: "git commit -am x" } }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("gq scope route --hook adds the owners a prompt names as context", async () => {
  const result = await runGq(["scope", "route", "--hook"], {
    cwd: ROOT,
    exec: gitIn(),
    stdin: hookCall({
      hook_event_name: "UserPromptSubmit",
      prompt: "getquick-theme should be renamed to gq-theme",
    }),
  });

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /Quick-Release\/getquick-theme/u);
  assert.match(output.hookSpecificOutput.additionalContext, /start a new session there/u);
});

test("gq scope route answers a request given as words, for any harness", async () => {
  const named = await runGq(["scope", "route", "fix", "the", "GQ", "Config", "options", "page"], {
    cwd: ROOT,
    exec: gitIn(),
  });
  assert.match(named.stdout, /gq-config \(Quick-Release\/gq-config/u);

  const unnamed = await runGq(["scope", "route", "speed", "up", "gq", "sync"], {
    cwd: ROOT,
    exec: gitIn(),
  });
  assert.match(unnamed.stdout, /no repository besides gq-site/u);
});

test("both hooks step aside with GQ_SCOPE=off, and outside a GETQUICK repository", async () => {
  const call = {
    tool_name: "Write",
    tool_input: { file_path: "/data/code/getquick/clients/ekis/x" },
  };
  const off = await runGq(["scope", "fence", "--hook"], {
    cwd: ROOT,
    env: { GQ_SCOPE: "off" },
    exec: gitIn(),
    stdin: hookCall(call),
  });
  assert.equal(off.stdout, "");
  assert.equal(off.exec.calls.length, 0);

  const elsewhere = await runGq(["scope", "fence", "--hook"], {
    cwd: ROOT,
    exec: gitIn("git@github.com:someone/else.git"),
    stdin: hookCall(call),
  });
  assert.equal(elsewhere.stdout, "");
});
