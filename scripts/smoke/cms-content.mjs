#!/usr/bin/env node
//
// The agent's content route on a real WordPress (see cms-content.sh): the
// version the CMS skeleton pins, on SQLite, with the generated site's
// content-api.php as a must-use plugin, served over HTTP by PHP's built-in
// server, and a headless Chrome for the block editor. As the Site's agent
// user (an Editor, by an application password over Basic auth):
//
//   1. gq content get writes content.raw exactly, and its block tree as JSON;
//   2. the tree is edited (a block moved, as in the Nomia incident), and
//      gq content diff shows the move;
//   3. gq content put refuses the edit until it is validated;
//   4. the editor validation (validate.mjs) passes the edit, and fails markup
//      the editor marks invalid and an unregistered block;
//   5. gq content put writes it, WordPress stores the bytes as given and a
//      new revision holds them; a stale base is refused;
//   6. the break-glass server script gq wp sends for `post update <id>
//      <file>` stores the bytes and leaves a revision (WP-CLI on this
//      WordPress), and reports it.
//
// Cloudflare Access isn't in the path: no edge credential is sent here.
//
//   node scripts/smoke/cms-content.mjs <generated site directory> <download cache>

import { createServer } from "node:http";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { serializeBlocks } from "../../src/content/blocks.mjs";
import { evaluateInPage, findChrome } from "../../src/content/browser.mjs";
import { createReceipts, sha256 } from "../../src/content/receipts.mjs";
import { validateLocally } from "../../src/content/validate.mjs";
import { exec } from "../../src/exec.mjs";
import { run } from "../../src/index.mjs";
import { parseWpMarker, remoteWpScript } from "../../src/wp/commands.mjs";
import { checker, freePort } from "./frontend-runtime-lib.mjs";
import { realWordPress } from "./wordpress-lib.mjs";

const site = resolve(process.argv[2] ?? ".");
const cache = resolve(process.argv[3] ?? ".");
const ADMIN = "cms.smoke.test";

const results = checker();
const { check } = results;

const HEADING = `<!-- wp:heading -->
<h2 class="wp-block-heading">Pick up where you left off</h2>
<!-- /wp:heading -->`;
const BUTTONS = `<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="https://example.test/">Play</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons -->`;
const ORIGINAL = `<!-- wp:group {"layout":{"type":"constrained"}} -->
<div class="wp-block-group">${HEADING}</div>
<!-- /wp:group -->

${BUTTONS}`;
// Not what the paragraph's save() writes. (An extra class alone isn't
// invalid: the editor keeps it as the block's className.)
// Not what the heading's save() writes.
const INVALID = `<!-- wp:heading -->
<p>Edited by hand</p>
<!-- /wp:heading -->`;
// Not what the paragraph's save() writes now, but what an old version's did:
// valid, through a deprecation.
const DEPRECATED = `<!-- wp:paragraph -->
<h3>Edited by hand</h3>
<!-- /wp:paragraph -->`;
const UNREGISTERED = "<!-- wp:acme/not-registered /-->";

const chrome = findChrome(process.env);
if (!chrome) {
  console.error("Needs Chrome or Chromium (set CHROMIUM).");
  process.exit(1);
}

const wordpressSite = realWordPress({
  name: "gq-cms-content",
  cache,
  version: process.env.WORDPRESS_VERSION,
});
const { wordpress, wp, serve, install, remove } = wordpressSite;
const work = await mkdtemp(join(tmpdir(), "gq-cms-content-work-"));
const mu = join(wordpress, "wp-content/mu-plugins");
mkdirSync(mu);
copyFileSync(
  join(site, "apps/cms/web/app/mu-plugins/content-api.php"),
  join(mu, "content-api.php"),
);

// The site's manifest, naming a production CMS this proof reaches locally.
const manifestPath = join(site, "gq.ops.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
writeFileSync(
  manifestPath,
  `${JSON.stringify({ ...manifest, domains: { admin: ADMIN, frontend: "www.smoke.test" } }, null, 2)}\n`,
);

let server;
let files;
try {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  await install(origin, "Smoke");
  // Application passwords over plain HTTP need a local environment.
  await wp(["config", "set", "WP_ENVIRONMENT_TYPE", "local", "--type=constant"]);
  await wp(["user", "create", "agent", "agent@example.test", "--role=editor"]);
  const password = await wp([
    "user",
    "application-password",
    "create",
    "agent",
    "smoke",
    "--porcelain",
  ]);
  writeFileSync(join(work, "original.html"), ORIGINAL);
  const id = Number(
    await wp([
      "post",
      "create",
      join(work, "original.html"),
      "--post_type=page",
      "--post_status=publish",
      "--post_title=Home",
      "--user=agent",
      "--porcelain",
    ]),
  );
  check(
    "WP-CLI stores the page's markup as given",
    (await wp(["post", "get", String(id), "--field=post_content"])) === ORIGINAL.trim(),
  );
  server = await serve(port);

  // gq as an agent runs it: the agent user's credentials injected, no
  // cloudflared session, the production origin reached on this machine.
  const env = {
    ...process.env,
    GQ_CMS_AGENT_USERNAME: "agent",
    GQ_CMS_AGENT_APPLICATION_PASSWORD: password,
    XDG_STATE_HOME: join(work, "state"),
  };
  delete env.GQ_CMS_AGENT_ACCESS_CLIENT_ID;
  delete env.GQ_CMS_AGENT_ACCESS_CLIENT_SECRET;
  const requests = [];
  const localFetch = (url, init) => {
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      authorization: Boolean(init?.headers?.Authorization),
    });
    return fetch(String(url).replace(`https://${ADMIN}`, origin), init);
  };
  const noSession = (command, args, options) =>
    command === "cloudflared"
      ? Promise.resolve({ code: 1, stdout: "", stderr: "" })
      : exec(command, args, options);
  const gq = async (args) => {
    let stdout = "";
    let stderr = "";
    const code = await run(["content", ...args], {
      cwd: work,
      env,
      fetch: localFetch,
      exec: noSession,
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
    });
    return { code, stdout, stderr };
  };
  symlinkSync(manifestPath, join(work, "gq.ops.json"));
  mkdirSync(join(work, ".git"));
  files = (name) => join(work, name);

  // 1. Read.
  const got = await gq(["get", String(id), "--out", "page.html"]);
  check("get reads the page at context=edit", got.code === 0, got.stderr);
  check(
    "get writes content.raw byte for byte",
    (await readFile(files("page.html"), "utf8")) === ORIGINAL,
  );
  check(
    "get used the agent's Basic auth on the page route only",
    requests.every(
      (request) => request.authorization && /\/wp-json\/wp\/v2\/pages\/\d+/u.test(request.url),
    ),
  );
  const tree = await gq(["get", String(id), "--out", "page.json"]);
  check("get writes the block tree", tree.code === 0, tree.stderr);

  // 2. Edit the tree: move the buttons into the group, after the heading.
  const blocks = JSON.parse(await readFile(files("page.json"), "utf8"));
  const group = blocks.find((block) => block.blockName === "core/group");
  const buttons = blocks.find((block) => block.blockName === "core/buttons");
  group.innerBlocks.push(buttons);
  group.innerContent.splice(group.innerContent.length - 1, 0, "\n\n", null);
  const edited = blocks.filter((block) => block === group);
  await writeFile(files("edited.json"), JSON.stringify(edited, null, 2));
  const markup = serializeBlocks(edited);
  check(
    "the edited tree serializes to the moved markup",
    markup ===
      `<!-- wp:group {"layout":{"type":"constrained"}} -->
<div class="wp-block-group">${HEADING}\n\n${BUTTONS}</div>
<!-- /wp:group -->`,
    markup,
  );
  const diff = await gq(["diff", String(id), "--file", "edited.json"]);
  check(
    "diff shows the buttons moving into the group",
    diff.code === 0 &&
      /^-core\/buttons$/mu.test(diff.stdout) &&
      /^\+ {2}core\/buttons$/mu.test(diff.stdout),
    diff.stdout,
  );

  // 3. Unvalidated bytes are refused.
  const unvalidated = await gq(["put", String(id), "--file", "edited.json", "--yes"]);
  check(
    "put refuses bytes that haven't passed validate",
    unvalidated.code === 1 && /validate them first/u.test(unvalidated.stderr),
    unvalidated.stderr,
  );

  // 4. The Site's editor judges the markup (on this WordPress, the local CMS).
  const localWp = (args, options = {}) =>
    exec("wp", args, { env: wordpressSite.env(), ...options });
  const openEditor = (page) => evaluateInPage({ binary: chrome, ...page });
  const validate = (content) =>
    validateLocally({ wp: localWp, openEditor, origin, id, type: "page", content });
  const valid = await validate(markup);
  check(
    "the editor finds every block of the edit valid",
    valid.ok && valid.count === 4,
    JSON.stringify(valid),
  );
  const invalid = await validate(`${markup}\n\n${INVALID}`);
  check(
    "the editor marks hand-edited markup invalid",
    !invalid.ok &&
      invalid.problems.some(
        (problem) =>
          problem.name === "core/heading" &&
          problem.reason === "invalid" &&
          /Expected tag name `h2`, instead saw `p`/u.test(problem.issues.join(" ")),
      ),
    JSON.stringify(invalid),
  );
  const deprecated = await validate(`${markup}\n\n${DEPRECATED}`);
  check(
    "markup only a deprecation accepts is valid, and flagged",
    deprecated.ok && deprecated.migrated.some((block) => block.name === "core/paragraph"),
    JSON.stringify(deprecated),
  );
  const unknown = await validate(`${markup}\n\n${UNREGISTERED}`);
  check(
    "an unregistered block fails validation",
    !unknown.ok && unknown.problems.some((problem) => problem.name === "acme/not-registered"),
    JSON.stringify(unknown),
  );
  // As gq content validate records a pass; here the local CMS is this one,
  // not DDEV, so the receipt is written the same way by hand. The local
  // writes left the page as the last validation wrote it: put it back.
  check("the original validates too", (await validate(ORIGINAL)).ok);
  const lock = await readFile(join(site, "apps/cms/composer.lock"), "utf8").catch(() => "");
  await createReceipts({ env, admin: ADMIN }).recordValidation("page", id, sha256(markup), {
    validatedAt: new Date().toISOString(),
    composerLock: lock ? sha256(lock) : null,
    blocks: valid.count,
  });

  // 5. Write once; the revision is the rollback. Someone else's edit since
  // get is refused; after a fresh get the write goes through.
  writeFileSync(join(work, "theirs.html"), ORIGINAL.replace("left off", "left it"));
  await wp(["post", "update", String(id), join(work, "theirs.html"), "--user=editor"]);
  const stale = await gq(["put", String(id), "--file", "edited.json", "--yes"]);
  check(
    "put refuses a page changed since get",
    stale.code === 1 && /changed in the CMS since gq content get/u.test(stale.stderr),
    stale.stderr,
  );
  await gq(["get", String(id), "--out", "page.html"]);
  const revisionsBefore = (
    await wp([
      "post",
      "list",
      "--post_type=revision",
      `--post_parent=${id}`,
      "--post_status=inherit",
      "--format=count",
    ])
  ).trim();
  const put = await gq(["put", String(id), "--file", "edited.json", "--yes"]);
  check(
    "put writes the validated edit and confirms a new revision",
    put.code === 0 && /revision \d+ holds it/u.test(put.stdout),
    `${put.stdout}${put.stderr}`,
  );
  check(
    "put names the revision to roll back to",
    /Roll back: gq content get \d+ --revision \d+/u.test(put.stdout),
    put.stdout,
  );
  check(
    "WordPress stored the edit byte for byte",
    (await wp(["post", "get", String(id), "--field=post_content"])) === markup,
  );
  const revisionsAfter = (
    await wp([
      "post",
      "list",
      "--post_type=revision",
      `--post_parent=${id}`,
      "--post_status=inherit",
      "--format=count",
    ])
  ).trim();
  check(
    "a REST update recorded one revision",
    Number(revisionsAfter) === Number(revisionsBefore) + 1,
    `${revisionsBefore} → ${revisionsAfter}`,
  );
  const again = await gq(["put", String(id), "--file", "edited.json", "--yes"]);
  check(
    "put of the same bytes writes nothing",
    again.code === 0 && /nothing to write/u.test(again.stdout),
    again.stdout,
  );

  // 6. Break-glass: the server script gq wp sends, with the content file
  // served as R2 would serve its presigned URL, run in a Ploi-like site path.
  const breakGlass = ORIGINAL.replace("Pick up where you left off", "Back from break-glass");
  const fileServer = createServer((request, response) => response.end(breakGlass));
  const filePort = await freePort();
  await new Promise((done) => fileServer.listen(filePort, "127.0.0.1", done));
  try {
    const path = join(work, "home");
    mkdirSync(join(path, "apps"), { recursive: true });
    symlinkSync(wordpress, join(path, "apps/cms"));
    const before = await wp([
      "post",
      "list",
      "--post_type=revision",
      `--post_parent=${id}`,
      "--post_status=inherit",
      "--orderby=ID",
      "--order=DESC",
      "--posts_per_page=1",
      "--field=ID",
    ]);
    const script = remoteWpScript({
      path,
      args: ["post", "update", String(id), "page.html", "--user=agent"],
      marker: "SMOKE_WP_CLI",
      upload: {
        url: `http://127.0.0.1:${filePort}/page.html`,
        sha256: sha256(breakGlass),
        index: 3,
      },
      postId: String(id),
    });
    const ran = await exec("bash", ["-c", script], { env: wordpressSite.env() });
    const marker = parseWpMarker(ran.stdout, "SMOKE_WP_CLI");
    check(
      "the break-glass script runs",
      ran.code === 0 && marker !== null,
      `${ran.stdout}${ran.stderr}`,
    );
    check(
      "it reports the bytes stored as sent",
      marker?.STORED === sha256(breakGlass),
      JSON.stringify(marker),
    );
    check(
      "wp post update recorded a new revision",
      marker &&
        marker.AFTER !== "none" &&
        marker.AFTER !== marker.BEFORE &&
        marker.BEFORE === before,
      JSON.stringify(marker),
    );
    check(
      "WordPress holds the break-glass content",
      (await wp(["post", "get", String(id), "--field=post_content"])) === breakGlass,
    );
  } finally {
    fileServer.close();
  }
} finally {
  server?.kill();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  remove();
}

if (results.failures > 0) {
  console.error(`${results.failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  "The agent's content route reads, validates and writes block markup on a real WordPress.",
);
