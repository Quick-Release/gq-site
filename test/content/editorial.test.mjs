import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverEditorial, parseEditorial, runEditorial } from "../../src/content/editorial.mjs";
import { agentClient } from "../../src/content/transport.mjs";

const entry = (rest_base, extra = {}) => ({
  rest_namespace: "wp/v2",
  rest_base,
  supports: { editor: true },
  ...extra,
});
async function catalog() {
  const routes = new Set();
  const data = await discoverEditorial(
    async (_, path) =>
      path.endsWith("/types")
        ? {
            biblioteca: entry("biblioteca"),
            evil: entry("users"),
            traversal: entry("../settings"),
            wp_template: entry("templates"),
            foreign: entry("foreign", { rest_namespace: "admin/v1" }),
          }
        : {
            library_category: entry("library_category", { types: ["biblioteca"] }),
            unrelated: entry("unrelated", { types: ["evil"] }),
          },
    routes,
  );
  return { data, routes };
}
test("discovery admits editorial core namespace routes and related taxonomies only", async () => {
  const { data, routes } = await catalog();
  assert.deepEqual(Object.keys(data.types), ["biblioteca"]);
  assert.deepEqual(Object.keys(data.taxonomies), ["library_category"]);
  assert.deepEqual(
    [...routes],
    ["/wp-json/wp/v2/biblioteca", "/wp-json/wp/v2/media", "/wp-json/wp/v2/library_category"],
  );
});
test("dynamic transport keeps exact paths, origin, methods and manual redirects", async () => {
  const { routes } = await catalog();
  const calls = [];
  const request = agentClient({
    origin: "https://cms.example",
    authorization: "Basic secret",
    edge: { headers: {}, kind: "none" },
    routes,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response("{}");
    },
  });
  for (const path of [
    "/wp-json/wp/v2/users",
    "/wp-json/wp/v2/biblioteca/../users",
    "https://evil.example/wp-json/wp/v2/biblioteca",
    "/wp-json/wp/v2/biblioteca/1/meta",
  ])
    await assert.rejects(request("GET", path), /Refusing/);
  await assert.rejects(request("DELETE", "/wp-json/wp/v2/biblioteca/1"), /GET and POST/);
  await request("GET", "/wp-json/wp/v2/biblioteca/1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, "https://cms.example");
  assert.equal(calls[0].options.redirect, "manual");
});
test("creates one draft with metadata and related positive term IDs; refuses content and status", async () => {
  const { data } = await catalog();
  const file = join(await mkdtemp(join(tmpdir(), "editorial-")), "draft.json");
  const calls = [];
  const shared = {
    file,
    catalog: data,
    io: { out() {} },
    command: { action: "create", type: "biblioteca", yes: true },
    request: async (...args) => {
      calls.push(args);
      return { id: 42, status: "draft" };
    },
  };
  await writeFile(
    file,
    JSON.stringify({ title: "Publication", meta: { year: 2024 }, library_category: [12] }),
  );
  await runEditorial(shared);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].body.status, "draft");
  for (const field of [{ content: "unsafe" }, { status: "publish" }, { library_category: [-1] }]) {
    await writeFile(file, JSON.stringify({ title: "Publication", ...field }));
    await assert.rejects(runEditorial(shared));
  }
  assert.equal(calls.length, 1);
});
test("PDF upload is explicit, local, binary and rejects truncated input", async () => {
  const { data } = await catalog();
  const file = join(await mkdtemp(join(tmpdir(), "editorial-")), "report.pdf");
  const calls = [];
  const shared = {
    file,
    catalog: data,
    io: { out() {} },
    command: { action: "upload", yes: true },
    request: async (...args) => {
      calls.push(args);
      return { id: 7 };
    },
  };
  await writeFile(file, "%PDF-1.7\ntruncated");
  await assert.rejects(runEditorial(shared), /EOF/);
  await writeFile(file, "%PDF-1.7\n%%EOF");
  await runEditorial(shared);
  assert.equal(calls[0][1], "/wp-json/wp/v2/media");
  assert.equal(calls[0][2].filename, "report.pdf");
  assert.ok(Buffer.isBuffer(calls[0][2].binary));
  assert.throws(() => parseEditorial(["upload", "https://elsewhere/report.pdf"]));
});

test("reusable blocks remain editorial while templates stay excluded", async () => {
  const routes = new Set();
  const data = await discoverEditorial(
    async (_, path) =>
      path.endsWith("/types") ? { wp_block: entry("blocks"), wp_template: entry("templates") } : {},
    routes,
  );
  assert.deepEqual(Object.keys(data.types), ["wp_block"]);
  assert.ok(routes.has("/wp-json/wp/v2/blocks"));
  assert.ok(!routes.has("/wp-json/wp/v2/templates"));
});

test("content list explicitly includes drafts for duplicate and timeout recovery", async () => {
  const { data } = await catalog();
  const calls = [];
  const output = [];
  await runEditorial({
    command: { action: "list", type: "biblioteca", search: "Title" },
    catalog: data,
    io: { out: (value) => output.push(value) },
    request: async (...args) => {
      calls.push(args);
      return [{ id: 42, status: "draft" }];
    },
  });
  assert.equal(calls[0][2].query.status, "any");
  assert.equal(calls[0][2].query.context, "edit");
  assert.equal(JSON.parse(output[0])[0].status, "draft");
});
