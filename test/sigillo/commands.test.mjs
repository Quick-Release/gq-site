// The Sigillo wrapper at the run() seam: a fixture site with a `sigillo` block
// in gq.ops.json, driven in-process with a recording exec. Secrets reach a
// command only through `sigillo run`'s per-command injection; nothing here may
// mount, download, or write an environment.
//
// Covered cases: argv-safe form, separator, environment mapping, unmapped environment,
// bootstrap scrubbing, CLI helper routing, download refusal, installed CLI,
// npx fallback and per-checkout login.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FIXTURE_OPS, createFixtureSite, recordingExec } from "../support/fixture-site.mjs";

const SIGILLO = Object.freeze({
  apiUrl: "https://secrets.example.test",
  projectId: "PROJECT123",
  environments: { local: "dev", staging: "staging" },
});
const GQ_BIN = fileURLToPath(new URL("../../bin/gq.mjs", import.meta.url));
const SITE_PACKAGE = `${JSON.stringify({ devDependencies: { sigillo: "0.13.0" } })}\n`;

// `sigillo: null` leaves the block out of gq.ops.json.
function sigilloSite({ sigillo = SIGILLO, installed = true, files = {} } = {}) {
  return createFixtureSite({
    ops: sigillo === null ? FIXTURE_OPS : { ...FIXTURE_OPS, sigillo },
    files: {
      "package.json": SITE_PACKAGE,
      ...(installed ? { "node_modules/.bin/sigillo": "#!/bin/sh\n" } : {}),
      ...files,
    },
  });
}

const routing = (environment) => [
  "--api-url",
  SIGILLO.apiUrl,
  "--project",
  SIGILLO.projectId,
  "--env",
  environment,
];

// Every argument any recorded child received, flattened.
const allArguments = (exec) => exec.calls.flatMap((call) => [call.command, ...call.args]);

async function siteFiles(site) {
  const entries = await readdir(site.root, { recursive: true });
  return entries.filter((entry) => !entry.startsWith(".git")).sort();
}

test("run wraps the command in sigillo run for the mapped environment", async () => {
  const site = await sigilloSite();
  const exec = recordingExec(() => ({ code: 7 }));
  const result = await site.run(
    ["sigillo", "run", "staging", "--", "pnpm", "--filter", "@site/frontend", "dev", "--json"],
    { env: { PATH: "/bin", HOME: "/home/dev" }, exec },
  );

  assert.equal(result.stderr, "");
  assert.equal(result.code, 7, "the wrapper exits with sigillo's code");
  assert.deepEqual(exec.calls, [
    {
      command: site.path("node_modules/.bin/sigillo"),
      args: [
        "run",
        ...routing("staging"),
        "--",
        process.execPath,
        GQ_BIN,
        "sigillo",
        "run",
        "--inside",
        "--",
        "pnpm",
        "--filter",
        "@site/frontend",
        "dev",
        "--json",
      ],
      cwd: site.root,
      env: { PATH: "/bin", HOME: "/home/dev", GQ_SIGILLO_REENTRY: "1" },
      input: undefined,
    },
  ]);
});

test("run hands the terminal to sigillo instead of buffering it", async () => {
  const site = await sigilloSite();
  const exec = recordingExec();
  await site.run(["sigillo", "run", "local", "--", "ddev", "start"], { exec });
  assert.equal(exec.options[0].stdio, "inherit");
});

test("run falls back to the site's pinned sigillo via npx before the first install", async () => {
  const site = await sigilloSite({ installed: false });
  const exec = recordingExec();
  const result = await site.run(["sigillo", "run", "local", "--", "pnpm", "install"], { exec });

  assert.equal(result.code, 0);
  assert.equal(exec.calls[0].command, "npx");
  assert.deepEqual(exec.calls[0].args.slice(0, 3), ["--yes", "sigillo@0.13.0", "run"]);
});

test("run never mounts, downloads, or writes an environment", async () => {
  const site = await sigilloSite();
  const before = await siteFiles(site);
  const exec = recordingExec();
  for (const environment of ["local", "staging"]) {
    await site.run(["sigillo", "run", environment, "--", "node", "deploy.mjs"], { exec });
  }

  const sigilloArguments = exec.calls.map((call) => call.args.slice(0, call.args.indexOf("--")));
  for (const args of sigilloArguments) {
    assert.deepEqual(args, ["run", ...routing(args.at(-1))]);
  }
  for (const forbidden of ["--mount", "download", "--force", "export"]) {
    assert.ok(!allArguments(exec).includes(forbidden), `never passes ${forbidden}`);
  }
  assert.deepEqual(await siteFiles(site), before, "no file is written to the site");
});

test("run requires the argv-safe <environment> -- <command> form", async () => {
  const site = await sigilloSite();
  for (const argv of [
    ["sigillo", "run", "local", "pnpm", "start"],
    ["sigillo", "run", "local", "--"],
    ["sigillo", "run", "--", "pnpm", "start"],
    ["sigillo", "run"],
  ]) {
    const result = await site.run(argv);
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.stderr, /^gq: Usage: gq sigillo run <environment> -- <command>/);
    assert.deepEqual(result.exec.calls, []);
  }
});

test("run rejects an environment gq.ops.json does not map", async () => {
  const site = await sigilloSite();
  const result = await site.run(["sigillo", "run", "production", "--", "pnpm", "start"]);
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "gq: Unknown Sigillo environment: production. gq.ops.json sigillo.environments maps local, staging.\n",
  );
  assert.deepEqual(result.exec.calls, []);
});

test("a missing or incomplete sigillo block is an actionable configuration error", async () => {
  for (const [sigillo, message] of [
    [null, "gq.ops.json is missing the sigillo block (apiUrl, projectId, environments)."],
    [
      { ...SIGILLO, apiUrl: "http://secrets.example.test" },
      "gq.ops.json sigillo.apiUrl must be an HTTPS URL.",
    ],
    [{ ...SIGILLO, projectId: " " }, "gq.ops.json sigillo.projectId is required."],
    [
      { ...SIGILLO, projectId: "REPLACE_WITH_PROJECT_ID" },
      "gq.ops.json sigillo.projectId is still a placeholder; set it to the site's Sigillo project ID.",
    ],
    [{ ...SIGILLO, environments: undefined }, "gq.ops.json sigillo.environments is required."],
  ]) {
    const site = await sigilloSite({ sigillo });
    const result = await site.run(["sigillo", "run", "local", "--", "pnpm", "start"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, `gq: ${message}\n`);
    assert.deepEqual(result.exec.calls, []);
  }
});

test("the inner step runs the command in the site root without Sigillo's bootstrap", async () => {
  const site = await sigilloSite();
  const exec = recordingExec(() => ({ code: 3 }));
  const result = await site.run(
    ["sigillo", "run", "--inside", "--", "pnpm", "deploy", "--", "--force"],
    {
      env: {
        SIGILLO: "1",
        SIGILLO_TOKEN: "bootstrap-token",
        SIGILLO_API_URL: SIGILLO.apiUrl,
        SIGILLO_PROJECT: SIGILLO.projectId,
        SIGILLO_ENVIRONMENT: "staging",
        GQ_SIGILLO_REENTRY: "1",
        APPLICATION_SECRET: "application-secret",
        PATH: "/bin",
      },
      exec,
    },
  );

  assert.equal(result.stderr, "");
  assert.equal(result.code, 3, "the inner step exits with the command's code");
  assert.deepEqual(exec.calls, [
    {
      command: "pnpm",
      args: ["deploy", "--", "--force"],
      cwd: site.root,
      env: { SIGILLO: "1", APPLICATION_SECRET: "application-secret", PATH: "/bin" },
      input: undefined,
    },
  ]);
  assert.equal(exec.options[0].stdio, "inherit");
});

test("the inner step refuses to run outside a wrapped sigillo run", async () => {
  const site = await sigilloSite();
  for (const env of [
    {},
    { SIGILLO: "1" },
    { GQ_SIGILLO_REENTRY: "1" },
    { LARKSPUR_SIGILLO_REENTRY: "1", SIGILLO: "1" },
  ]) {
    const result = await site.run(["sigillo", "run", "--inside", "--", "pnpm", "start"], { env });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "gq: Refusing to run an untrusted Sigillo inner command.\n");
    assert.deepEqual(result.exec.calls, []);
  }
});

test("the inner step takes no environment and needs a command", async () => {
  const site = await sigilloSite();
  const env = { SIGILLO: "1", GQ_SIGILLO_REENTRY: "1" };
  for (const argv of [
    ["sigillo", "run", "--inside", "pnpm"],
    ["sigillo", "run", "--inside", "--"],
  ]) {
    const result = await site.run(argv, { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^gq: Usage: gq sigillo run <environment> -- <command>/);
  }
});

test("login is per checkout, without a project or environment", async () => {
  const site = await sigilloSite();
  const exec = recordingExec();
  const result = await site.run(["sigillo", "login"], { exec, env: { HOME: "/home/dev" } });

  assert.equal(result.code, 0);
  assert.deepEqual(exec.calls, [
    {
      command: site.path("node_modules/.bin/sigillo"),
      args: ["login", "--api-url", SIGILLO.apiUrl, "--scope", "."],
      cwd: site.root,
      env: { HOME: "/home/dev" },
      input: undefined,
    },
  ]);
  assert.equal(exec.options[0].stdio, "inherit");
});

test("setup and secrets route to the configured project and environment", async () => {
  const site = await sigilloSite();
  const exec = recordingExec();
  for (const argv of [
    ["sigillo", "setup", "local"],
    ["sigillo", "secrets", "staging"],
    ["sigillo", "secrets", "local", "set", "API_TOKEN"],
  ]) {
    assert.equal((await site.run(argv, { exec })).code, 0, argv.join(" "));
  }

  assert.deepEqual(
    exec.calls.map((call) => call.args),
    [
      ["setup", ...routing("dev")],
      ["secrets", ...routing("staging")],
      ["secrets", "set", "API_TOKEN", ...routing("dev")],
    ],
  );
  // `secrets set` reads the value from stdin, so the terminal is passed through.
  assert.ok(exec.options.every((options) => options.stdio === "inherit"));
});

test("setup and secrets refuse a bulk download or a mount", async () => {
  const site = await sigilloSite();
  for (const argv of [
    ["sigillo", "secrets", "staging", "download"],
    ["sigillo", "secrets", "staging", "download", "--force"],
    ["sigillo", "secrets", "local", "list", "--mount"],
    ["sigillo", "secrets", "local", "--mount=/tmp/secrets"],
    ["sigillo", "setup", "local", "--mount", "/tmp/secrets"],
  ]) {
    const result = await site.run(argv);
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.stderr, /^gq: Refusing sigillo (download|--mount): /);
    assert.deepEqual(result.exec.calls, []);
  }
});

test("unknown sigillo commands list the supported forms", async () => {
  const site = await sigilloSite();
  for (const argv of [["sigillo"], ["sigillo", "export", "local"], ["sigillo", "secrets"]]) {
    const result = await site.run(argv);
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.stderr, /gq sigillo login/);
    assert.deepEqual(result.exec.calls, []);
  }
});

test("--help lists the sigillo commands", async () => {
  const site = await sigilloSite();
  const result = await site.run(["--help"]);
  for (const form of [
    "gq sigillo run <environment> -- <command> [arguments...]",
    "gq sigillo login",
    "gq sigillo setup <environment>",
    "gq sigillo secrets <environment> [arguments...]",
  ]) {
    assert.ok(result.stdout.includes(form), form);
  }
});

test("the wrapper finds the site from a subdirectory", async () => {
  const site = await sigilloSite({ files: { "apps/frontend/.keep": "" } });
  const exec = recordingExec();
  const result = await site.run(["sigillo", "run", "local", "--", "pnpm", "dev"], {
    cwd: join(site.root, "apps/frontend"),
    exec,
  });
  assert.equal(result.code, 0);
  assert.equal(exec.calls[0].cwd, site.root);
});
