import { Miniflare } from "miniflare";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const root = new URL("../apps/frontend/dist/server/", import.meta.url).pathname;
const modules = {};
for (const path of await readdir(root, { recursive: true })) {
  if (path.endsWith(".js"))
    modules[path] = { type: "esm", contents: await readFile(join(root, path), "utf8") };
}
const mf = new Miniflare({
  workers: [
    {
      config: {
        name: "site",
        compatibilityDate: "2026-10-26",
        compatibilityFlags: ["nodejs_compat"],
        manifest: { mainModule: "worker.js", modulesRoot: root, modules },
      },
    },
  ],
});
try {
  const worker = await mf.getWorker();
  for (const [path, method, status] of [
    ["/", "GET", 503],
    ["/missing", "GET", 503],
    ["/gq/events", "GET", 405],
    ["/gq/events", "POST", 403],
    ["/gq/refresh", "GET", 405],
    ["/gq/consent", "GET", 503],
  ]) {
    const res = await worker.fetch(new Request("https://example.com" + path, { method }));
    console.log(method, path, res.status);
    assert.equal(res.status, status);
  }
} finally {
  await mf.dispose();
}
