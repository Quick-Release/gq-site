// `gq frontend secrets` at the run() seam: the Frontend's per-Site refresh
// token and event key, generated into Sigillo staging when missing or too
// short. An in-memory Sigillo stands behind a recording exec; nothing here
// reaches the network or a real secret store.
import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureSite, recordingExec } from "../support/fixture-site.mjs";

const OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  sigillo: {
    apiUrl: "https://secrets.example.test",
    projectId: "PROJECT123",
    environments: { operations: "ops", staging: "stage" },
  },
  domains: { admin: "admin.example.test", frontend: "www.example.test" },
});

const SIGILLO_BIN = "node_modules/.bin/sigillo";

function site() {
  return createFixtureSite({
    ops: OPS,
    files: {
      "package.json": `${JSON.stringify({ devDependencies: { sigillo: "0.13.0" } })}\n`,
      [SIGILLO_BIN]: "#!/bin/sh\n",
    },
  });
}

// Sigillo staging: lists names, stores what it is given over stdin.
function fakeSigillo(stored = {}) {
  const secrets = { ...stored };
  const exec = recordingExec(({ command, args, input }) => {
    assert.ok(command.endsWith(SIGILLO_BIN), `unexpected child: ${command}`);
    assert.equal(args[args.indexOf("--env") + 1], "stage", "secrets go to staging");
    if (args[0] === "secrets" && args[1] === "set") {
      assert.ok(!args.includes(input), "a value never goes in argv");
      secrets[args[2]] = input;
      return {};
    }
    if (args[0] === "secrets") return { stdout: Object.keys(secrets).join("\n") };
    return { code: 1, stderr: `unexpected sigillo ${args.join(" ")}` };
  });
  return { exec, secrets };
}

test("frontend secrets generates the refresh token and event key Sigillo staging lacks", async () => {
  const fixture = await site();
  const { exec, secrets } = fakeSigillo({ CLOUDFLARE_API_TOKEN: "deploy" });

  const result = await fixture.run(["frontend", "secrets"], { exec });

  assert.equal(result.code, 0, result.stderr);
  assert.match(secrets.FRONTEND_REFRESH_TOKEN, /^[0-9a-f]{64}$/u);
  assert.match(secrets.PUBLICATION_EVENT_SECRET, /^[0-9a-f]{64}$/u);
  assert.notEqual(secrets.FRONTEND_REFRESH_TOKEN, secrets.PUBLICATION_EVENT_SECRET);
  for (const value of [secrets.FRONTEND_REFRESH_TOKEN, secrets.PUBLICATION_EVENT_SECRET]) {
    assert.ok(!result.stdout.includes(value), "a value is never printed");
  }
  assert.match(result.stdout, /pnpm ci:deploy/u);
  assert.match(result.stdout, /pnpm ploi:events/u);
});

test("frontend secrets generates the consent read token the Site's Worker and CMS share", async () => {
  const fixture = await site();
  const { exec, secrets } = fakeSigillo({
    FRONTEND_REFRESH_TOKEN: "a",
    PUBLICATION_EVENT_SECRET: "b",
  });

  const result = await fixture.run(["frontend", "secrets"], { exec });

  assert.equal(result.code, 0, result.stderr);
  assert.match(secrets.CONSENT_READ_TOKEN, /^[0-9a-f]{64}$/u);
  assert.ok(!result.stdout.includes(secrets.CONSENT_READ_TOKEN), "a value is never printed");
  assert.match(
    result.stdout,
    /\+ generate CONSENT_READ_TOKEN \(the CMS's bearer for consent record reads\)/u,
  );
});

test("frontend secrets keeps what Sigillo already has, and replaces a value too short to use", async () => {
  const fixture = await site();
  const { exec, secrets } = fakeSigillo({
    FRONTEND_REFRESH_TOKEN: "kept-token-0123456789abcdef0123456789",
    PUBLICATION_EVENT_SECRET: "short",
  });

  const result = await fixture.run(["frontend", "secrets"], {
    exec,
    env: {
      FRONTEND_REFRESH_TOKEN: "kept-token-0123456789abcdef0123456789",
      PUBLICATION_EVENT_SECRET: "short",
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(secrets.FRONTEND_REFRESH_TOKEN, "kept-token-0123456789abcdef0123456789");
  assert.match(secrets.PUBLICATION_EVENT_SECRET, /^[0-9a-f]{64}$/u);
  assert.match(result.stdout, /✓ FRONTEND_REFRESH_TOKEN in Sigillo stage/u);
  assert.match(result.stdout, /~ PUBLICATION_EVENT_SECRET is shorter than 32 characters/u);
});

test("frontend secrets changes nothing when all three are stored", async () => {
  const fixture = await site();
  const { exec } = fakeSigillo({
    FRONTEND_REFRESH_TOKEN: "a",
    PUBLICATION_EVENT_SECRET: "b",
    CONSENT_READ_TOKEN: "c",
  });

  const result = await fixture.run(["frontend", "secrets"], { exec });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Nothing to do\./u);
  assert.ok(exec.calls.every(({ args }) => args[1] !== "set"));
});

test("frontend secrets --dry-run only reports the plan", async () => {
  const fixture = await site();
  const { exec, secrets } = fakeSigillo();

  const result = await fixture.run(["frontend", "secrets", "--dry-run"], { exec });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\+ generate FRONTEND_REFRESH_TOKEN/u);
  assert.match(result.stdout, /\+ generate PUBLICATION_EVENT_SECRET/u);
  assert.match(result.stdout, /Dry run: nothing changed\./u);
  assert.deepEqual(secrets, {});
});
