// `gq wp` (break-glass WP-CLI) at the run() seam: its command policy, and a
// fixture site with an in-memory Ploi (one-off scripts) and R2 behind a
// recording fetch. Nothing here reaches the network or a server.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import { classifyWpCommand } from "../../src/wp/policy.mjs";
import { parseWpMarker, remoteWpScript } from "../../src/wp/commands.mjs";
import { createFixtureSite, recordingFetch } from "../support/fixture-site.mjs";

const OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  domains: { admin: "admin.example.test", frontend: "www.example.test" },
  ploi: {
    serverId: "12",
    siteId: "34",
    systemUser: "fixture",
    projectRoot: "/",
    database: "fx_db",
  },
  backups: { bucket: "fixture-backups", prefix: "db/" },
  cloudflare: { accountId: "account-1" },
});
const ENV = Object.freeze({
  PLOI_API_TOKEN: "ploi-secret",
  R2_ACCESS_KEY_ID: "r2-key",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  GQ_CMS_AGENT_USERNAME: "agent",
});
const sha = (text) => createHash("sha256").update(text).digest("hex");

test("allows reads and single-object writes through WordPress", () => {
  assert.deepEqual(classifyWpCommand(["post", "get", "12", "--field=post_content"]), {
    command: "post get",
    write: false,
    positionals: ["12"],
    flags: new Map([["field", "post_content"]]),
  });
  assert.equal(
    classifyWpCommand(["post", "list", "--post_type=revision", "--post_parent=12"]).write,
    false,
  );
  assert.equal(classifyWpCommand(["post", "update", "12", "page.html"]).write, true);
  assert.equal(
    classifyWpCommand(["post", "meta", "update", "12", "key", "value"]).command,
    "post meta update",
  );
  assert.equal(classifyWpCommand(["cache", "flush"]).write, true);
});

test("refuses raw SQL, PHP and bulk or destructive commands by name", () => {
  for (const [args, message] of [
    [["db", "query", "DELETE FROM wp_posts"], /raw SQL and PHP evaluation/u],
    [["db", "export", "-"], /raw SQL/u],
    [["eval", "wp_delete_post(1);"], /raw SQL/u],
    [["eval-file", "x.php"], /raw SQL/u],
    [["shell"], /raw SQL/u],
    [["search-replace", "a", "b"], /Refusing wp search-replace: bulk or destructive/u],
    [["site", "empty", "--yes"], /site empty/u],
    [["post", "delete", "12"], /post delete/u],
    [["post", "update", "12", "13", "page.html"], /one post at a time/u],
    [["post", "update", "12", "-"], /local file, not STDIN/u],
    [["post", "update", "12", "--post_content=<p>x</p>"], /not --post_content/u],
    [["post", "update", "--all"], /--all/u],
    [["transient", "delete", "--all"], /bulk writes/u],
    [["post", "get", "12", "--exec=system('id');"], /Refusing --exec/u],
    [["post", "get", "12", "--ssh=elsewhere"], /Refusing --ssh/u],
    [["post", "get", "12", "--path=/tmp"], /Refusing --path/u],
    [["option", "get", "siteurl"], /isn't on gq wp's list/u],
    [["user", "list"], /isn't on gq wp's list/u],
    [[], /Name a WP-CLI command/u],
  ]) {
    assert.throws(() => classifyWpCommand(args), message, args.join(" "));
  }
});

test("the post update script checks the file, and reports revisions and the stored hash", () => {
  const script = remoteWpScript({
    path: "/home/fixture/admin.example.test",
    args: ["post", "update", "12", "page.html", "--user=agent"],
    marker: "FIXTURE_WP_CLI",
    upload: { url: "https://r2.test/x?X-Amz-Signature=s'q", sha256: "a".repeat(64), index: 3 },
    postId: "12",
  });
  assert.match(
    script,
    /^set -euo pipefail\numask 077\ncd '\/home\/fixture\/admin\.example\.test\/apps\/cms'\n/u,
  );
  assert.match(
    script,
    /curl -fsS --retry 3 -o "\$content" 'https:\/\/r2\.test\/x\?X-Amz-Signature=s'\\''q'/u,
  );
  assert.match(script, /\] \|\| \{ echo "FIXTURE_WP_CLI=mismatch"; exit 1; \}/u);
  assert.match(script, /\nwp 'post' 'update' '12' "\$content" '--user=agent'\n/u);
  assert.match(script, /before="\$\(wp 'post' 'list' '--post_type=revision' '--post_parent=12'/u);
  assert.match(
    script,
    /echo "FIXTURE_WP_CLI=done BEFORE=\$\{before:-none\} AFTER=\$\{after:-none\} STORED=\$stored"/u,
  );
  assert.deepEqual(
    parseWpMarker("x\nFIXTURE_WP_CLI=done BEFORE=40 AFTER=41 STORED=ab\n", "FIXTURE_WP_CLI"),
    {
      BEFORE: "40",
      AFTER: "41",
      STORED: "ab",
    },
  );
});

// Ploi runs each one-off script (recorded in `scripts`): the backup export
// reports its marker, a WP-CLI script answers `wpOutput(script)`. R2 takes
// the content upload and its delete.
function fakeProviders({ wpOutput, exitCode = 0 } = {}) {
  const scripts = [];
  const r2 = [];
  const fetch = recordingFetch(({ method, url, body }) => {
    const { hostname, pathname } = new URL(url);
    if (hostname.endsWith(".r2.cloudflarestorage.com")) {
      r2.push(`${method} ${pathname}`);
      return new Response(null, { status: method === "DELETE" ? 204 : 200 });
    }
    const route = `${method} ${pathname}`;
    if (route === "POST /api/servers/12/scripts/run") {
      scripts.push(JSON.parse(body));
      return { data: { id: scripts.length } };
    }
    const poll = /^GET \/api\/servers\/12\/scripts\/run\/(\d+)$/u.exec(route);
    if (poll) {
      const { content } = scripts[Number(poll[1]) - 1];
      if (content.includes("wp db export")) {
        return {
          data: {
            status: "finished",
            exit_code: 0,
            output: `FIXTURE_DB_EXPORT=success PREFIX=wp_ WORDPRESS=7.1.3 BYTES=2048 SHA256=${"b".repeat(64)}\n`,
          },
        };
      }
      return { data: { status: "finished", exit_code: exitCode, output: wpOutput(content) } };
    }
    throw new Error(`Unexpected request: ${route}`);
  });
  return { fetch, scripts, r2 };
}

test("a read runs as the site's system user, with no backup and no prompt", async () => {
  const site = await createFixtureSite({ ops: OPS });
  const { fetch, scripts } = fakeProviders({
    wpOutput: () => "<!-- wp:heading -->\nFIXTURE_WP_CLI=done EXIT=0\n",
  });
  const result = await site.run(["wp", "--", "post", "get", "12", "--field=post_content"], {
    env: ENV,
    fetch,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].user, "fixture");
  assert.match(
    scripts[0].content,
    /cd '\/home\/fixture\/admin\.example\.test\/apps\/cms'\nset \+e\nwp 'post' 'get' '12' '--field=post_content'\n/u,
  );
  assert.match(
    result.stdout,
    /wp post get on admin\.example\.test \(Ploi server 12, as fixture\)/u,
  );
  assert.match(result.stdout, /<!-- wp:heading -->/u);
  assert.doesNotMatch(result.stdout, /FIXTURE_WP_CLI=/u);
});

test("finds the system user from Ploi when gq.ops.json doesn't record it", async () => {
  const site = await createFixtureSite({ ops: { ...OPS, ploi: { serverId: "12" } } });
  const providers = fakeProviders({ wpOutput: () => "7.1.3\nFIXTURE_WP_CLI=done EXIT=0\n" });
  const fetch = recordingFetch((request) =>
    new URL(request.url).pathname === "/api/servers/12/sites"
      ? {
          data: [
            { domain: "other.test", system_user: "other" },
            { domain: "admin.example.test", system_user: "ploi-user", project_root: "/" },
          ],
        }
      : providers.fetch(request.url, request),
  );
  const result = await site.run(["wp", "--", "core", "version"], { env: ENV, fetch });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(providers.scripts[0].user, "ploi-user");
  assert.match(
    providers.scripts[0].content,
    /cd '\/home\/ploi-user\/admin\.example\.test\/apps\/cms'/u,
  );
});

test("a refused command never reaches Ploi", async () => {
  const site = await createFixtureSite({ ops: OPS });
  const fetch = recordingFetch();
  const result = await site.run(["wp", "--yes", "--", "db", "query", "SELECT 1"], {
    env: ENV,
    fetch,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /raw SQL/u);
  assert.equal(fetch.requests.length, 0);
  const noSeparator = await site.run(["wp", "post", "get", "12"], { env: ENV, fetch });
  assert.match(noSeparator.stderr, /after --/u);
});

test("a write needs --yes without a terminal, and a WordPress user", async () => {
  const site = await createFixtureSite({ ops: OPS });
  const fetch = recordingFetch();
  const noYes = await site.run(["wp", "--", "cache", "flush"], { env: ENV, fetch });
  assert.match(noYes.stderr, /Pass --yes/u);
  const noUser = { ...ENV, GQ_CMS_AGENT_USERNAME: "" };
  const anonymous = await site.run(["wp", "--yes", "--", "cache", "flush"], { env: noUser, fetch });
  assert.match(anonymous.stderr, /A write needs --user=<login> \(or GQ_CMS_AGENT_USERNAME\)/u);
  assert.equal(fetch.requests.length, 0);
});

test("post update backs up first, sends the file through R2 and confirms the revision", async () => {
  const site = await createFixtureSite({ ops: OPS });
  const content =
    '<!-- wp:heading -->\n<h2 class="wp-block-heading">Fixed</h2>\n<!-- /wp:heading -->';
  await writeFile(site.path("page.html"), content);
  const { fetch, scripts, r2 } = fakeProviders({
    wpOutput: () =>
      `Success: Updated post 12.\nFIXTURE_WP_CLI=done BEFORE=40 AFTER=41 STORED=${sha(content)}\n`,
  });
  const result = await site.run(["wp", "--yes", "--", "post", "update", "12", "page.html"], {
    env: ENV,
    fetch,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(scripts.length, 2);
  assert.match(scripts[0].content, /wp db export - /u, "the backup runs first");
  assert.match(scripts[1].content, /wp 'post' 'update' '12' "\$content" '--user=agent'/u);
  assert.ok(scripts[1].content.includes(sha(content)));
  assert.ok(
    !scripts[1].content.includes("Fixed"),
    "the content travels through R2, not the script",
  );
  assert.deepEqual(
    r2.map((line) => line.replace(/\d{4}-\d{2}-\d{2}T[\d-]+Z/u, "<time>")),
    [
      "PUT /fixture-backups/content/fixture/<time>-12.html",
      "DELETE /fixture-backups/content/fixture/<time>-12.html",
    ],
  );
  assert.match(result.stdout, /Backed up \(0\.0 MB\) to r2:\/\/fixture-backups\/db\/fx_db\//u);
  assert.match(result.stdout, /✓ Stored exactly; revision 41 holds it \(the one before is 40\)\./u);
});

test("post update fails when no revision is recorded or the bytes differ", async () => {
  const content = "<p>x</p>";
  for (const [marker, message] of [
    [
      `BEFORE=40 AFTER=40 STORED=${sha(content)}`,
      /recorded no new revision; the backup is the rollback/u,
    ],
    [`BEFORE=40 AFTER=41 STORED=${"c".repeat(64)}`, /stored other markup than the file/u],
  ]) {
    const site = await createFixtureSite({ ops: OPS });
    await writeFile(site.path("page.html"), content);
    const { fetch } = fakeProviders({ wpOutput: () => `FIXTURE_WP_CLI=done ${marker}\n` });
    const result = await site.run(
      ["wp", "--yes", "--", "post", "update", "12", "page.html", "--user=editor"],
      { env: ENV, fetch },
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
  }
});
