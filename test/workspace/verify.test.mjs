// Which checks run locally and
// in CI. The runner itself is covered at the run() seam in
// workspace-workflows.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import { selectChecks } from "../../src/workspace/verify.mjs";

const checks = [
  { cmd: "pnpm", args: ["run", "lint"] },
  { cmd: "composer", args: ["--working-dir=apps/cms", "run", "test"] },
];

test("runs every check in CI, even without a local PHP toolchain", () => {
  assert.deepEqual(selectChecks(checks, { ci: true, phpAvailable: false }).run, checks);
});

test("skips (and reports) the Composer checks locally without PHP", () => {
  const { run, skipped } = selectChecks(checks, { ci: false, phpAvailable: false });
  assert.deepEqual(run, [checks[0]]);
  assert.deepEqual(skipped, [checks[1]]);
});
