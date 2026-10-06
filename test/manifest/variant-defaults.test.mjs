// The blueprint's release, verify and doctor defaults for a site's variant,
// plus the additions its gq.ops.json declares, as release push, verify and
// doctor see them through run().
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createFixtureSite, recordingExec } from "../support/fixture-site.mjs";
import {
  CONTENT_CHECKS,
  CONTENT_RELEASE_PATHS,
  CONTENT_REQUIRED_FILES,
  missingFiles,
  releaseExec,
  releaseRun,
  verifyChecks,
  versionedFiles,
} from "../support/site-settings.mjs";

const CONTENT = { schemaVersion: 1, project: "fixture", variant: "content" };

const read = (site, path) => readFile(site.path(path), "utf8");

test("a content site without additions gets the content variant's defaults", async () => {
  const site = await createFixtureSite({ ops: CONTENT, files: versionedFiles("1.2.3") });

  const exec = releaseExec();
  const push = await site.run(["release", "push", "minor"], { exec });
  assert.equal(push.code, 0, push.stderr);
  assert.deepEqual(releaseRun(exec), { checks: CONTENT_CHECKS, paths: CONTENT_RELEASE_PATHS });
  assert.equal(
    await read(site, "apps/frontend/package.json"),
    versionedFiles("1.3.0")["apps/frontend/package.json"],
  );

  const verifyExec = recordingExec();
  const verify = await site.run(["verify", "--ci"], { exec: verifyExec });
  assert.equal(verify.code, 0, verify.stderr);
  assert.deepEqual(verifyChecks(verifyExec), CONTENT_CHECKS);

  const bare = await createFixtureSite({ ops: CONTENT });
  const doctor = await bare.run(["doctor"]);
  assert.equal(doctor.code, 1);
  assert.deepEqual(
    missingFiles(doctor.stdout).filter((path) => path.startsWith("apps/")),
    CONTENT_REQUIRED_FILES,
  );
});

test("additions in gq.ops.json are appended to the variant's defaults", async () => {
  const ops = {
    ...CONTENT,
    release: {
      jsonFiles: ["apps/docs/package.json"],
      textFiles: [
        {
          path: "theme/style.css",
          patterns: [{ regexp: "^Version: .+$", flags: "m", replacement: "Version: {version}" }],
        },
        {
          path: "theme/functions.php",
          patterns: [
            {
              regexp: "define\\( 'THEME_VERSION', '[^']+' \\);",
              replacement: "define( 'THEME_VERSION', '{version}' );",
            },
          ],
        },
      ],
      paths: ["theme"],
    },
    verify: {
      checks: [
        { cmd: "pnpm", args: ["run", "e2e"], cwd: "apps/frontend", env: { CI: "1" } },
        { cmd: "make" },
      ],
    },
    doctor: {
      requiredFiles: { "apps/frontend": ["tsconfig.json"], "apps/docs": ["package.json"] },
    },
  };
  const site = await createFixtureSite({
    ops,
    files: versionedFiles("1.2.3", {
      "apps/docs/package.json": `${JSON.stringify({ name: "docs", version: "1.2.3" }, null, 2)}\n`,
      "theme/style.css": "/*\nTheme Name: Site\nVersion: 1.2.3\n*/\n",
      "theme/functions.php": "<?php\ndefine( 'THEME_VERSION', '1.2.3' );\n",
    }),
  });

  const exec = releaseExec();
  const push = await site.run(["release", "push", "minor"], { exec, env: { PATH: "/bin" } });
  assert.equal(push.code, 0, push.stderr);
  assert.deepEqual(releaseRun(exec), {
    checks: [...CONTENT_CHECKS, "pnpm run e2e", "make"],
    paths: [...CONTENT_RELEASE_PATHS, "theme"],
  });
  const e2e = exec.calls.find(({ args }) => args.includes("e2e"));
  assert.deepEqual([e2e.cwd, e2e.env], [site.path("apps/frontend"), { PATH: "/bin", CI: "1" }]);
  assert.equal(JSON.parse(await read(site, "apps/docs/package.json")).version, "1.3.0");
  assert.equal(await read(site, "theme/style.css"), "/*\nTheme Name: Site\nVersion: 1.3.0\n*/\n");
  assert.equal(
    await read(site, "theme/functions.php"),
    "<?php\ndefine( 'THEME_VERSION', '1.3.0' );\n",
  );

  const verifyExec = recordingExec();
  const verify = await site.run(["verify", "--ci"], { exec: verifyExec });
  assert.equal(verify.code, 0, verify.stderr);
  assert.deepEqual(verifyChecks(verifyExec), [...CONTENT_CHECKS, "pnpm run e2e", "make"]);

  const doctor = await site.run(["doctor"]);
  assert.deepEqual(
    missingFiles(doctor.stdout).filter((path) => path.startsWith("apps/")),
    [
      "apps/cms/composer.json",
      "apps/cms/.ddev/config.yaml",
      "apps/frontend/astro.config.mjs",
      "apps/frontend/tsconfig.json",
    ],
  );
});

test("the release, verify and doctor blocks reject what they don't know", async () => {
  for (const [additions, problems] of [
    [{ release: { branch: "main", paths: ["theme"] } }, "release.branch is not a known key"],
    [
      { verify: { checks: [{ cmd: "pnpm", requires: ["docker"] }] } },
      'verify.checks[0].requires[0] must be "php" or "ddev"',
    ],
    [
      { verify: { checks: [{ cmd: "pnpm", deploy: true }] } },
      "verify.checks[0].deploy is not a known key",
    ],
    [
      { doctor: { requiredFiles: { "apps/cms": "composer.json" } } },
      'doctor.requiredFiles["apps/cms"]: Invalid input: expected array, received string',
    ],
    [
      {
        release: {
          textFiles: [
            { path: "style.css", patterns: [{ regexp: "Version: (", replacement: "x" }] },
          ],
        },
      },
      "release.textFiles[0].patterns[0].regexp must be a valid regular expression; " +
        "release.textFiles[0].patterns[0].replacement must contain {version}",
    ],
  ]) {
    const site = await createFixtureSite({ ops: { ...CONTENT, ...additions } });
    const result = await site.run(["verify", "--ci"]);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, `gq: gq.ops.json is invalid: ${problems}.\n`);
    assert.deepEqual(result.exec.calls, []);
  }
});
