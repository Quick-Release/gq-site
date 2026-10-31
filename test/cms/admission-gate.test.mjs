// The request admission's gate (deploy/ploi/admission.sh renders it into
// .gq/admission.php) under a non-CLI PHP SAPI: PHP's built-in server with the
// gate as auto_prepend_file. It answers 503 unless it reads exactly "open"
// from the admission state. This checks the gate's own decision only; that a
// PHP-FPM pool enforces the prepend against per-directory INI files is the
// real-stack smoke's (scripts/smoke/admission.sh). Needs php on PATH.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { createFixtureSite, temporaryDirectory } from "../support/fixture-site.mjs";
import { readSite } from "../support/generated-site.mjs";

const PHP = spawnSync("php", ["-v"]).status === 0;
const NONCE = "0123456789abcdef0123456789abcdef";

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

// A Site with the gate prepare installs, and a script under its web root.
async function gatedSite() {
  const fixture = await createFixtureSite({
    ops: {
      project: "acme",
      variant: "content",
      domains: { admin: "cms.acme.test", frontend: "www.acme.test" },
      deployment: {
        protected: true,
        state: "authorized",
        guardedPackages: ["getquick/gq-support"],
        approval: { slot: "acme/production", stage: "prod" },
      },
    },
  });
  assert.equal((await fixture.run(["sync"])).code, 0);
  const site = await temporaryDirectory();
  const web = join(site, "apps/cms/web");
  await mkdir(join(web, "app/plugins/x"), { recursive: true });
  await writeFile(join(web, "app/plugins/x/x.php"), '<?php echo "APP RAN\\n";\n');
  await writeFile(
    join(site, "admission.sh"),
    await readSite(fixture.root, "deploy/ploi/admission.sh"),
  );
  execFileSync("bash", [join(site, "admission.sh"), "prepare"], {
    env: { PATH: process.env.PATH, SITE_PATH: site, APP_PATH: "apps/cms" },
  });
  return { site, web, gate: join(site, ".gq/admission.php"), state: join(site, ".gq/state") };
}

// Serves `web` with the gate prepended (and `ini`); resolves to a request
// function and a stop.
async function serve({ web, gate }, ini = []) {
  const port = await freePort();
  const server = spawn(
    "php",
    [
      "-d",
      `auto_prepend_file=${gate}`,
      ...ini.flatMap((setting) => ["-d", setting]),
      "-S",
      `127.0.0.1:${port}`,
      "-t",
      web,
    ],
    { stdio: "ignore" },
  );
  const request = async (path) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return {
      status: response.status,
      gate: response.headers.get("x-gq-gate"),
      body: await response.text(),
    };
  };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await request("/app/plugins/x/x.php");
      return { request, stop: () => server.kill() };
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  server.kill();
  throw new Error("PHP's built-in server didn't start");
}

test(
  'the gate serves only on a positive read of exactly "open"; every other state is held',
  { skip: !PHP && "needs php" },
  async () => {
    const site = await gatedSite();
    const { request, stop } = await serve(site);
    try {
      const at = (path = "/app/plugins/x/x.php") => request(path);

      // No state at all (a Site prepare just bootstrapped): held.
      assert.deepEqual(await at(), {
        status: 503,
        gate: "invalid",
        body: "This site is temporarily unavailable.\n",
      });

      await writeFile(site.state, "open\n");
      assert.deepEqual(await at(), { status: 200, gate: null, body: "APP RAN\n" });

      await writeFile(site.state, `held ${NONCE}\n`);
      const held = await at();
      assert.deepEqual([held.status, held.gate], [503, NONCE]);
      assert.ok(!held.body.includes("APP RAN"));

      for (const content of ["open", "opened\n", "open\nopen\n", "OPEN\n", "held xyz\n", ""]) {
        await writeFile(site.state, content);
        const result = await at();
        assert.deepEqual([result.status, result.gate], [503, "invalid"], JSON.stringify(content));
      }

      // A symlink to a file that says "open" is held.
      const elsewhere = join(site.site, "elsewhere");
      await writeFile(elsewhere, "open\n");
      await rm(site.state);
      await symlink(elsewhere, site.state);
      assert.equal((await at()).status, 503);
      await rm(site.state);

      // A directory where the state goes is held.
      await mkdir(site.state);
      assert.equal((await at()).status, 503);
      await rm(site.state, { recursive: true });

      // A state PHP can't read is held (not as root, which reads anything).
      if (process.getuid?.() !== 0) {
        await writeFile(site.state, "open\n");
        await chmod(site.state, 0o000);
        assert.equal((await at()).status, 503);
        await chmod(site.state, 0o644);
      }

      // A challenge probe is answered by the gate, open or held.
      await mkdir(join(site.web, `gq-admission/${NONCE}`), { recursive: true });
      await writeFile(
        join(site.web, `gq-admission/${NONCE}/probe.php`),
        '<?php echo "UNGATED\\n";\n',
      );
      await writeFile(site.state, "open\n");
      const probe = await at(`/gq-admission/${NONCE}/probe.php`);
      assert.deepEqual(
        [probe.status, probe.gate, probe.body],
        [200, "open", "gq admission probe\n"],
      );
    } finally {
      stop();
    }
  },
);

test(
  "an open_basedir that lets the gate load but not read the state holds, even while the state says open",
  { skip: !PHP && "needs php" },
  async () => {
    const site = await gatedSite();
    await writeFile(site.state, "open\n");
    // The exploit's setting: the gate file and the web root, not the state.
    const { request, stop } = await serve(site, [`open_basedir=${site.gate}:${site.web}/`]);
    try {
      const result = await request("/app/plugins/x/x.php");
      assert.equal(result.status, 503);
      assert.ok(!result.body.includes("APP RAN"));
    } finally {
      stop();
    }
  },
);
