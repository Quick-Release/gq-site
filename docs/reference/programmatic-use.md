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
  approvals, // { confirm(request) }: a guarded package's approval (none by default)
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

`approvals` is the seam an authenticated package approval service plugs into
([Package expectations](package-expectations.md)). Without it, every
deploy of a Site guarding a Composer package refuses; `bin/gq.mjs` passes
none yet.
