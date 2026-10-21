import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runGq, temporaryDirectory } from "../support/fixture-site.mjs";

for (const variant of ["content", "commerce"]) {
  test(`${variant}: metadata candidate is explicit, integrity checked, and has one managed writer`, async () => {
    const parent = await temporaryDirectory();
    const artifact = join(parent, "content.tgz");
    // This test exercises ownership/integrity, not npm package validity. The HTTP proof installs the real pack.
    await writeFile(artifact, "packed candidate bytes");
    const root = join(parent, "candidate");
    const created = await runGq(
      [
        "new",
        root,
        "--project",
        "candidate",
        "--variant",
        variant,
        "--metadata-candidate",
        artifact,
      ],
      { cwd: parent },
    );
    assert.equal(created.code, 0, created.stderr);
    const pkg = JSON.parse(await readFile(join(root, "apps/frontend/package.json"), "utf8"));
    assert.equal(pkg.dependencies["@getquick/content"], `file:${artifact}`);
    const lock = JSON.parse(await readFile(join(root, "gq.lock.json"), "utf8"));
    assert.ok(lock.keys["apps/frontend/package.json"]["dependencies.@getquick/content"]);
    assert.ok(lock.files["apps/frontend/src/lib/document-head.ts"]);
    assert.equal((await runGq(["sync", "--check"], { cwd: root })).code, 0);

    const defaults = join(root, "apps/frontend/src/site-metadata.ts");
    await writeFile(defaults, "// Site's reviewed configuration\n");
    assert.equal((await runGq(["sync"], { cwd: root })).code, 0);
    assert.equal(await readFile(defaults, "utf8"), "// Site's reviewed configuration\n");

    await writeFile(artifact, "changed candidate bytes");
    const changed = await runGq(["sync"], { cwd: root });
    assert.equal(changed.code, 1);
    assert.match(changed.stderr, /artifact changed or is invalid/u);
    assert.equal(
      JSON.parse(await readFile(join(root, "apps/frontend/package.json"), "utf8")).dependencies[
        "@getquick/content"
      ],
      `file:${artifact}`,
    );
  });

  test(`${variant}: ordinary generation has no metadata package import or unavailable pin`, async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "ordinary");
    const created = await runGq(["new", root, "--project", "ordinary", "--variant", variant], {
      cwd: parent,
    });
    assert.equal(created.code, 0, created.stderr);
    const pkg = JSON.parse(await readFile(join(root, "apps/frontend/package.json"), "utf8"));
    assert.equal(pkg.dependencies["@getquick/content"], undefined);
    assert.doesNotMatch(
      await readFile(join(root, "apps/frontend/src/lib/document-head.ts"), "utf8"),
      /@getquick\/content/u,
    );
    const sheet = await readFile(join(root, "apps/frontend/src/styles/site.css"), "utf8");
    await writeFile(
      join(root, "apps/frontend/src/styles/site.css"),
      sheet + "\n/* Site customization */\n",
    );
    assert.equal((await runGq(["sync"], { cwd: root })).code, 0);
    assert.equal(
      await readFile(join(root, "apps/frontend/src/styles/site.css"), "utf8"),
      sheet + "\n/* Site customization */\n",
    );
  });
}
