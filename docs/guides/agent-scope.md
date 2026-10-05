# Agent scope

[Documentation](../README.md)

An agent session works in one GETQUICK repository. Work another repository
owns starts a new session there, in a worktree of it
([gq-platform ADR 0001](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0001-ownership-of-work-across-getquick-repositories.md)).
`gq scope` holds that line for agent harnesses, in two hooks. Both work from
any GETQUICK repository, without `gq.ops.json`.

```text
gq scope route [--hook] [<request>...]
gq scope fence --hook
```

## The router

`gq scope route` finds the other repositories a request names, by name or by a
distinctive identifier (`GQ eCommerce`, `CartBearerIsolation`,
`@getquick/content`), and says who owns each one and where its clone is. As a
`UserPromptSubmit` hook it adds that note to the agent's context, so the agent
answers a request for another repository by naming it and suggesting a new
session there. Reading other repositories for evidence stays allowed. Without
`--hook` it answers a request given as words, for a harness without hooks or
for a person:

```sh
gq scope route rename getquick-theme to gq-theme
```

## The fence

`gq scope fence --hook`, a `PreToolUse` hook, denies a tool call that writes
outside the repository and says who owns the target:

- edits and file writes to a path outside it;
- `git` writes (`commit`, `push`, `worktree add`, …) in another repository,
  whether by `git -C` or after `cd`;
- `gh` writes aimed at another repository (`-R`, `--repo`, a
  `repos/<owner>/<name>` API path), and every `gh issue transfer` and
  `gh repo create`;
- `rm`, `mv`, `cp`, `mkdir`, `tee`, `sed -i` and redirections into a path
  outside it.

Another checkout of the same repository (its main clone, a sibling worktree)
counts as inside. So do the temporary directory, `/data/agents/scratch` and
`~/.claude`; `GQ_SCOPE_ALLOW` adds more, separated by `:`. The fence reads a
command the way a reviewer would, without expanding variables or
substitutions: it stops accidents, and isn't a sandbox.

## Where the repositories are

The ownership map is `src/scope/repositories.mjs`. Clones are found under
`GQ_CODE_ROOT` (default `/data/code/getquick`) and worktrees under
`GQ_WORKSPACES_ROOT` (default `/data/agents/workspaces`, as
`<agent>/<repository>/<task>`). A new repository joins the map in the same
change that adds it to the ADR's table.

## Orchestrating on purpose

A session that coordinates several repositories on purpose runs with
`GQ_SCOPE=off`, which turns both hooks off:

```sh
GQ_SCOPE=off claude
```

## Wiring the hooks

This repository's `.claude/settings.json` runs both hooks from its own
checkout. To cover every repository on a machine, including plugins and Sites,
add them to the user settings (`~/.claude/settings.json`) with the `gq` of a
clone or a global install:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "gq scope route --hook", "timeout": 10 }] }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash",
        "hooks": [{ "type": "command", "command": "gq scope fence --hook", "timeout": 10 }]
      }
    ]
  }
}
```

Harnesses without these hooks follow the Scope section of `AGENTS.md`, and
can call `gq scope route` themselves.
