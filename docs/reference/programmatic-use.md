# Programmatic use

[Documentation](../README.md)

The CLI is a thin shell over `run()`, which resolves to an exit code:

```js
import { run } from "@getquick/site";

const code = await run(["ploi", "site", "show", "--json"], {
  cwd, // where discovery starts
  env, // replaces process.env
  fetch, // every provider request
  exec, // every child process: (command, args, { cwd, env, input, stdio, timeout, background, stdout, stderr }) => { code, stdout, stderr, pid? }
  lookup, // every DNS lookup, as node:dns/promises' lookup
  approvals, // { lookup(request) }: a guarded package's approval record (none by default)
  approvalLookup, // ({ project, projectRoot }) => approvals, for the Site released (bin/gq.mjs: the Operator CLI's)
  stdin, // a readable stream, for git's credential request
  stdout, // anything with write()
  stderr,
});
```

No command reads `process.env` or `process.cwd()`; `bin/gq.mjs` is the only
place that passes the real ones. `exec` is asked for `stdio: "inherit"` when a
child needs the terminal (`gq sigillo`, `gq cms`); it then captures nothing.
With `background: { log }` (`gq cms start`'s worker) it starts the child
detached in its own process group, writing its output to `log`, and resolves
with its `pid` once it has started.

`approvals` is the package approval lookup ([Package expectations](package-expectations.md)),
and `approvalLookup` builds one for the Site being released, only when a
lookup happens. Without either, every guarded package refuses. Only
`bin/gq.mjs` passes `approvalLookup`: the Operator CLI adapter that
`~/.config/gq/support-approval.json`, in the home directory the user database
gives the user running gq, configures. The approval lookup's bounded process
is the one child process that doesn't go through `exec`.
