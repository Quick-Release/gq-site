// `gq content` at the run() seam: a fixture site, an in-memory CMS behind a
// recording fetch (a page, its revisions, WordPress's revision on update),
// a recording exec standing in for cloudflared and ddev, and receipts in a
// temporary state directory. `validate` runs through runContentCommand with
// a stand-in editor. Nothing here reaches the network, DDEV or a browser.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { runContentCommand } from "../../src/content/commands.mjs";
import { parseBlocks } from "../../src/content/blocks.mjs";
import { CHECK_USER, localApplyScript, parseApplyReport } from "../../src/content/validate.mjs";
import {
  createFixtureSite,
  json,
  recordingExec,
  recordingFetch,
  temporaryDirectory,
} from "../support/fixture-site.mjs";

const OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  domains: { admin: "admin.example.test", frontend: "www.example.test" },
});
const ORIGIN = "https://admin.example.test";
const HOME = "https://fixture.ddev.site";
const LOCAL_ENV = "DB_HOST='db'\nWP_ENV='development'\nWP_HOME='https://fixture.ddev.site'\n";
const PAGE = `<!-- wp:heading -->
<h2 class="wp-block-heading">Hello</h2>
<!-- /wp:heading -->`;
const EDIT = PAGE.replace("Hello", "Hello again");

async function fixture() {
  const site = await createFixtureSite({
    ops: OPS,
    files: { "apps/cms/.env": LOCAL_ENV, "apps/cms/composer.lock": "{}\n" },
  });
  const env = {
    GQ_CMS_AGENT_USERNAME: "agent",
    GQ_CMS_AGENT_APPLICATION_PASSWORD: "abcd efgh",
    XDG_STATE_HOME: await temporaryDirectory(),
  };
  return { site, env };
}

// One page (12) with one revision; a POST stores the content and, unless
// `revise` is false or WordPress would store something else (`stores`),
// records a revision of it, as WordPress does after an update.
function fakeCms({ raw = PAGE, revise = true, stores = (content) => content } = {}) {
  const state = { raw, modified: "2026-10-30T09:00:00", revisions: [{ id: 40, raw }] };
  const fetch = recordingFetch(({ method, url, body }) => {
    const { origin, pathname } = new URL(url);
    assert.equal(origin, ORIGIN);
    const post = () => ({
      id: 12,
      type: "page",
      status: "publish",
      link: `${ORIGIN}/about/`,
      modified_gmt: state.modified,
      content: { raw: state.raw, rendered: "" },
    });
    if (pathname === "/wp-json/wp/v2/pages/12" && method === "GET") return post();
    if (pathname === "/wp-json/wp/v2/pages/12" && method === "POST") {
      state.raw = stores(JSON.parse(body).content);
      state.modified = "2026-10-30T10:00:00";
      if (revise) state.revisions.unshift({ id: state.revisions[0].id + 1, raw: state.raw });
      return post();
    }
    if (pathname === "/wp-json/wp/v2/pages/12/revisions") {
      return state.revisions.map(({ id }) => ({ id }));
    }
    const revision = /^\/wp-json\/wp\/v2\/pages\/12\/revisions\/(\d+)$/u.exec(pathname);
    if (revision) {
      const found = state.revisions.find(({ id }) => id === Number(revision[1]));
      return found
        ? { id: found.id, parent: 12, content: { raw: found.raw } }
        : json({ code: "rest_post_invalid_id" }, 404);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return { fetch, state };
}

const noSession = () =>
  recordingExec(({ command }) => (command === "cloudflared" ? { code: 1 } : {}));
const lines = (fetch) =>
  fetch.requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`);

test("get writes content.raw as stored, reading at context=edit as the agent", async () => {
  const { site, env } = await fixture();
  const { fetch } = fakeCms();
  const result = await site.run(["content", "get", "12", "--out", "page.html"], {
    env,
    fetch,
    exec: noSession(),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(site.path("page.html"), "utf8"), PAGE);
  const [read] = fetch.requests;
  assert.equal(new URL(read.url).searchParams.get("context"), "edit");
  assert.equal(
    read.headers.Authorization,
    `Basic ${Buffer.from("agent:abcd efgh").toString("base64")}`,
  );
  assert.match(result.stdout, /Wrote page 12 \(publish\) to page\.html: 1 top-level blocks/u);
  assert.match(result.stdout, /Edge: none\./u);
});

test("get writes the block tree to a .json file", async () => {
  const { site, env } = await fixture();
  const result = await site.run(["content", "get", "12", "--out", "page.json"], {
    env,
    fetch: fakeCms().fetch,
    exec: noSession(),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(site.path("page.json"), "utf8")), parseBlocks(PAGE));
});

test("get refuses a tree that wouldn't serialize back to the same bytes", async () => {
  const { site, env } = await fixture();
  const raw = "<!-- wp:spacer --><!-- /wp:spacer -->";
  const result = await site.run(["content", "get", "12", "--out", "page.json"], {
    env,
    fetch: fakeCms({ raw }).fetch,
    exec: noSession(),
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /doesn't serialize back .* get it as \.html/u);
});

test("get fetches a revision, checking it belongs to the page", async () => {
  const { site, env } = await fixture();
  const result = await site.run(["content", "get", "12", "--revision", "40", "--out", "old.html"], {
    env,
    fetch: fakeCms().fetch,
    exec: noSession(),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(site.path("old.html"), "utf8"), PAGE);
  assert.match(result.stdout, /Wrote revision 40 of page 12/u);
});

test("the agent's credentials come from the environment and are required", async () => {
  const { site } = await fixture();
  const result = await site.run(["content", "get", "12", "--out", "page.html"], {
    env: {},
    fetch: recordingFetch(),
    exec: noSession(),
  });
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /GQ_CMS_AGENT_USERNAME and GQ_CMS_AGENT_APPLICATION_PASSWORD are required/u,
  );
});

test("arguments are checked before anything runs", async () => {
  const { site, env } = await fixture();
  for (const [args, message] of [
    [["content"], /Usage:/u],
    [["content", "get", "--out", "x.html"], /Name one post ID/u],
    [["content", "get", "12"], /--out <file> is required/u],
    [
      ["content", "put", "12", "--file", "x.html", "--out", "y"],
      /--out is not valid for gq content put/u,
    ],
    [["content", "diff", "12", "--file", "x", "--type", "product"], /--type is page or post/u],
  ]) {
    const result = await site.run(args, { env, fetch: recordingFetch(), exec: recordingExec() });
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, message, args.join(" "));
  }
});

test("diff shows the block outline and markup changes against the CMS", async () => {
  const { site, env } = await fixture();
  await writeFile(
    site.path("edit.html"),
    `${PAGE}\n\n<!-- wp:separator -->\n<hr class="wp-block-separator"/>\n<!-- /wp:separator -->`,
  );
  const result = await site.run(["content", "diff", "12", "--file", "edit.html"], {
    env,
    fetch: fakeCms().fetch,
    exec: noSession(),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /Blocks:\n--- cms page 12\n\+\+\+ edit\.html\n@@[^\n]*\n core\/heading\n\+core\/separator/u,
  );
  assert.match(result.stdout, /Markup:[\s\S]*\+<!-- wp:separator -->/u);
});

// Validates `file` through the command with DDEV running and a stand-in
// editor answering `checked`.
async function validate(site, env, file, { checked, stored = true } = {}) {
  const exec = recordingExec(({ command, args, input }) => {
    if (command !== "ddev") return { code: 127 };
    if (args.join(" ") === "describe -j")
      return { stdout: JSON.stringify({ raw: { status: "running" } }) };
    if (args.join(" ") === "wp eval-file -") {
      assert.match(input, /wp_update_post/u);
      const report = {
        stored,
        storedContent: stored ? null : Buffer.from("<p>stripped</p>").toString("base64"),
        editUrl: `${HOME}/wp/wp-admin/post.php?post=12&action=edit`,
        cookies: [{ name: "wordpress_sec_x", value: "session", path: "/wp/wp-admin" }],
      };
      return { stdout: `Notice: noise\n\nGQ_CONTENT_APPLY=${JSON.stringify(report)}\n` };
    }
    return { code: 1 };
  });
  const opened = [];
  const openEditor = async (page) => {
    opened.push(page);
    return checked;
  };
  const io = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const out = [];
  const err = [];
  const code = await runContentCommand(["validate", "12", "--file", file], {
    cwd: site.root,
    env,
    exec,
    io,
    openEditor,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), opened, exec };
}

test("validate writes the file to the local post and records a pass for those bytes", async () => {
  const { site, env } = await fixture();
  await writeFile(site.path("edit.html"), EDIT);
  const ready = { state: "ready", postId: 12, count: 1, freeform: 0, problems: [], migrated: [] };
  const result = await validate(site, env, "edit.html", { checked: ready });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /✓ 1 blocks valid in the Site's editor/u);
  const [page] = result.opened;
  assert.equal(page.url, `${HOME}/wp/wp-admin/post.php?post=12&action=edit`);
  assert.deepEqual(page.cookies, [
    {
      name: "wordpress_sec_x",
      value: "session",
      domain: "fixture.ddev.site",
      path: "/wp/wp-admin",
      secure: true,
      httpOnly: true,
    },
  ]);
  assert.ok(!result.out.includes("session"), "cookies are never printed");
});

test("validate fails on blocks the editor marks invalid, naming them", async () => {
  const { site, env } = await fixture();
  await writeFile(site.path("edit.html"), EDIT);
  const checked = {
    state: "ready",
    postId: 12,
    count: 2,
    freeform: 0,
    problems: [
      {
        path: "0.1",
        name: "core/button",
        reason: "invalid",
        issues: ["Expected tag name `div`, instead saw `a`."],
      },
    ],
    migrated: [],
  };
  const result = await validate(site, env, "edit.html", { checked });
  assert.equal(result.code, 1);
  assert.match(result.err, /0\.1 core\/button: invalid\n {6}Expected tag name `div`/u);
});

test("validate fails when WordPress stores other bytes (KSES)", async () => {
  const { site, env } = await fixture();
  await writeFile(site.path("edit.html"), EDIT);
  const result = await validate(site, env, "edit.html", { stored: false });
  assert.equal(result.code, 1);
  assert.match(result.err, /stored other markup than given/u);
  assert.match(result.err, /\+<p>stripped<\/p>/u);
  assert.equal(result.opened.length, 0);
});

test("validate refuses a local CMS that isn't DDEV's", async () => {
  const site = await createFixtureSite({
    ops: OPS,
    files: { "apps/cms/.env": "DB_HOST='db'\nWP_HOME='https://admin.example.test'\n" },
  });
  await writeFile(site.path("edit.html"), EDIT);
  const env = { XDG_STATE_HOME: await temporaryDirectory() };
  await assert.rejects(
    validate(site, env, "edit.html", { checked: {} }),
    /not a local DDEV setup/u,
  );
});

test("put refuses bytes that didn't pass validate, and a page it hasn't read", async () => {
  const { site, env } = await fixture();
  await writeFile(site.path("edit.html"), EDIT);
  const { fetch } = fakeCms();
  const unvalidated = await site.run(["content", "put", "12", "--file", "edit.html", "--yes"], {
    env,
    fetch,
    exec: noSession(),
  });
  assert.equal(unvalidated.code, 1);
  assert.match(unvalidated.stderr, /haven't passed gq content validate 12 --file edit\.html/u);
  assert.equal(fetch.requests.length, 0);

  const unread = await site.run(
    ["content", "put", "12", "--file", "edit.html", "--yes", "--without-validation"],
    { env, fetch, exec: noSession() },
  );
  assert.equal(unread.code, 1);
  assert.match(
    unread.stderr,
    /--without-validation: writing markup the Site's editor hasn't validated/u,
  );
  assert.match(unread.stderr, /Run gq content get 12 first/u);
  assert.deepEqual(lines(fetch), ["GET /wp-json/wp/v2/pages/12"]);
});

test("put writes validated bytes once and confirms the revision holding them", async () => {
  const { site, env } = await fixture();
  const { fetch, state } = fakeCms();
  const exec = noSession();
  await site.run(["content", "get", "12", "--out", "page.html"], { env, fetch, exec });
  await writeFile(site.path("edit.html"), EDIT);
  const ready = { state: "ready", postId: 12, count: 1, freeform: 0, problems: [], migrated: [] };
  assert.equal((await validate(site, env, "edit.html", { checked: ready })).code, 0);
  fetch.requests.length = 0;

  const put = await site.run(["content", "put", "12", "--file", "edit.html", "--yes"], {
    env,
    fetch,
    exec,
  });
  assert.equal(put.code, 0, put.stderr);
  assert.equal(state.raw, EDIT);
  assert.deepEqual(lines(fetch), [
    "GET /wp-json/wp/v2/pages/12",
    "GET /wp-json/wp/v2/pages/12/revisions",
    "GET /wp-json/wp/v2/pages/12/revisions/40",
    "POST /wp-json/wp/v2/pages/12",
    "GET /wp-json/wp/v2/pages/12/revisions",
    "GET /wp-json/wp/v2/pages/12/revisions/41",
  ]);
  const post = fetch.requests.find(({ method }) => method === "POST");
  assert.deepEqual(JSON.parse(post.body), { content: EDIT });
  assert.match(put.stdout, /✓ Wrote page 12; revision 41 holds it\./u);
  assert.match(put.stdout, /Roll back: gq content get 12 --revision 40 --out <file>/u);
  assert.match(put.stdout, /gq frontend refresh --uri \/about\//u);

  const again = await site.run(["content", "put", "12", "--file", "edit.html", "--yes"], {
    env,
    fetch,
    exec,
  });
  assert.match(again.stdout, /already holds edit\.html; nothing to write/u);
});

test("put refuses a page changed since get, and needs --yes without a terminal", async () => {
  const { site, env } = await fixture();
  const { fetch, state } = fakeCms();
  const exec = noSession();
  await site.run(["content", "get", "12", "--out", "page.html"], { env, fetch, exec });
  await writeFile(site.path("edit.html"), EDIT);
  const confirm = await site.run(
    ["content", "put", "12", "--file", "edit.html", "--without-validation"],
    { env, fetch, exec },
  );
  assert.equal(confirm.code, 1);
  assert.match(confirm.stderr, /Pass --yes/u);

  state.raw = PAGE.replace("Hello", "Someone else's");
  const stale = await site.run(
    ["content", "put", "12", "--file", "edit.html", "--yes", "--without-validation"],
    { env, fetch, exec },
  );
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /changed in the CMS since gq content get/u);
  assert.ok(!fetch.requests.some(({ method }) => method === "POST"));
});

test("put fails loudly when WordPress changes the markup or records no revision", async () => {
  for (const [cms, message] of [
    [{ stores: () => "<p>stripped</p>" }, /stored other markup than edit\.html/u],
    [{ revise: false }, /recorded no new revision/u],
  ]) {
    const { site, env } = await fixture();
    const { fetch } = fakeCms(cms);
    const exec = noSession();
    await site.run(["content", "get", "12", "--out", "page.html"], { env, fetch, exec });
    await writeFile(site.path("edit.html"), EDIT);
    const put = await site.run(
      ["content", "put", "12", "--file", "edit.html", "--yes", "--without-validation"],
      { env, fetch, exec },
    );
    assert.equal(put.code, 1);
    assert.match(put.stderr, message);
    assert.match(put.stderr, /Roll back: gq content get 12 --revision 40/u);
  }
});

test("the local apply script writes as the Editor check user and reports after its marker", () => {
  const script = localApplyScript({ id: 12, type: "page", content: "it's <b>bold</b> \\ ok" });
  assert.match(script, /^<\?php\n\$id = 12;\n\$type = 'page';/u);
  assert.match(script, new RegExp(`\\$login = '${CHECK_USER}';`, "u"));
  assert.match(script, /'role' => 'editor'/u);
  assert.match(script, /wp_set_current_user\(\$user->ID\);\n\$updated = wp_update_post/u);
  assert.ok(script.includes(Buffer.from("it's <b>bold</b> \\ ok").toString("base64")));
  assert.deepEqual(parseApplyReport('Warning\nGQ_CONTENT_APPLY={"stored":true}\n'), {
    stored: true,
  });
  assert.equal(parseApplyReport("PHP Fatal error"), null);
});
