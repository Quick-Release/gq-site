// What the Frontend's runtime proofs share (frontend-runtime.mjs,
// frontend-languages.mjs, cms-events.mjs): a stub WordPress they can take down, Alchemy's Astro
// Cloudflare build of a generated site's Frontend (`buildInChild`, what
// `pnpm deploy:frontend` runs in its build child), and that build served in
// workerd (Wrangler's local mode) with a local D1 publication store migrated
// from the Frontend's own migrations. Nothing reaches Cloudflare.

import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const gq = fileURLToPath(new URL("../../bin/gq.mjs", import.meta.url));

export function checker() {
  const state = { failures: 0 };
  state.check = (label, condition, detail = "") => {
    console.log(`${condition ? "✓" : "✗"} ${label}${condition || !detail ? "" : `: ${detail}`}`);
    if (!condition) state.failures += 1;
  };
  return state;
}

/**
 * When WordPress last modified an entry, as WPGraphQL's modifiedGmt: the
 * entry's `modified` (ms) if it has one, else a time in 2026's first months
 * derived from its content, so an edit changes it, and it is older than
 * anything a proof withdraws.
 */
function modifiedGmt(entry) {
  const seconds = createHash("sha256")
    .update(`${entry.title}\n${entry.content}`)
    .digest()
    .readUInt32BE(0);
  const ms = entry.modified ?? Date.parse("2026-01-01T00:00:00Z") + (seconds % 5_000_000) * 1000;
  return new Date(ms).toISOString().slice(0, 19);
}

/**
 * WordPress, answering the Frontend's queries by name from `entries`
 * (published entries by URI: { id, title, content, modified? }), `heading`
 * (the front page's) and the shared settings: `menuLabel`, `logo`, `icon`,
 * `title`, `tagline` and `color` (the brand preset's). `requests` counts the
 * queries it answered.
 */
export function stubCms(entries) {
  const cms = {
    heading: "Welcome to Acme",
    menuLabel: "About us",
    logo: "https://media.example/logo.svg",
    icon: null,
    title: "Acme",
    tagline: "Things",
    color: "#c00",
    entries: new Map(entries),
    server: null,
    port: 0,
    requests: 0,
    start() {
      this.server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          this.requests += 1;
          const { query, variables } = JSON.parse(body);
          const name = /query (\w+)/.exec(query)?.[1];
          const entry = name === "EntryByUri" ? this.entries.get(decodeURI(variables.uri)) : null;
          const brand = { colors: [{ slug: "brand", color: this.color }], spacingSizes: [] };
          const data = {
            EntryByUri: {
              postBy: null,
              pageBy: entry
                ? {
                    id: entry.id,
                    title: entry.title,
                    content: `<p class="has-brand-color">${entry.content}</p>`,
                    uri: decodeURI(variables.uri),
                    status: "publish",
                    isRestricted: false,
                    modifiedGmt: modifiedGmt(entry),
                    featuredImage: null,
                  }
                : null,
              designTokens: brand,
            },
            PublishedRoutes: {
              contentNodes: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { uri: "/", id: null, modifiedGmt: null },
                  ...[...this.entries].map(([uri, entry]) => ({
                    uri,
                    id: entry.id,
                    modifiedGmt: modifiedGmt(entry),
                  })),
                ],
              },
            },
            DesignPresets: { designTokens: brand },
            HomePage: {
              generalSettings: { title: this.title, description: this.tagline },
              nodeByUri: {
                __typename: "Page",
                isFrontPage: true,
                title: "Home",
                content: `<h1 class="has-brand-color">${this.heading}</h1>`,
              },
              designTokens: brand,
            },
            SiteChrome: {
              generalSettings: {
                siteIcon: this.icon ? { node: { sourceUrl: this.icon, altText: "" } } : null,
                siteLogo: { node: { sourceUrl: this.logo, altText: "Acme" } },
              },
              menuItems: {
                nodes: [
                  { id: "a", parentId: null, label: this.menuLabel, url: "/about/", target: null },
                ],
              },
            },
          }[name];
          response.writeHead(data ? 200 : 400, { "content-type": "application/json" });
          response.end(
            JSON.stringify(data ? { data } : { errors: [{ message: "unknown query" }] }),
          );
        });
      });
      return new Promise((done) => this.server.listen(this.port, "127.0.0.1", done)).then(() => {
        this.port = this.server.address().port;
      });
    },
    stop() {
      this.server.closeAllConnections();
      return new Promise((done) => this.server.close(done));
    },
  };
  return cms;
}

export async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

/** Alchemy's Astro build, in the Frontend's directory so its dependencies resolve. */
export function buildFrontend(frontend, siteUrl, graphqlUrl) {
  const script = `
    import { buildInChild } from "@alchemy.run/frontend-frameworks/astro/source";
    import * as Effect from "effect/Effect";
    import * as NodeServices from "@effect/platform-node/NodeServices";
    await Effect.runPromise(buildInChild({
      rootDir: process.cwd(), compatibilityDate: "2026-03-10", compatibilityFlags: ["nodejs_compat"],
      env: {}, sessionKVBindingName: false, sessions: undefined, sessionDevKV: undefined,
      prerenderEnvironment: undefined, astro: { output: "server", site: ${JSON.stringify(siteUrl)} },
      config: undefined,
    }).pipe(Effect.provide(NodeServices.layer)));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: frontend,
    env: { ...process.env, PUBLIC_WORDPRESS_GRAPHQL_URL: graphqlUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`The Alchemy Astro build failed:\n${result.stderr}`);
}

/**
 * A local Worker for the built Frontend: its Wrangler config in `work`, with
 * the publication store persisted under `work/state`, and the Worker's
 * secrets passed as `vars`.
 */
export function localWorker({ site, work, vars }) {
  const frontend = join(site, "apps/frontend");
  const wrangler = join(site, "infra/ci/node_modules/.bin/wrangler");
  const persist = join(work, "state");
  const config = join(work, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify(
      {
        name: "acme-fe-runtime-proof",
        main: join(frontend, "dist/server/entry.mjs"),
        compatibility_date: "2026-03-10",
        compatibility_flags: ["nodejs_compat"],
        no_bundle: true,
        find_additional_modules: true,
        rules: [{ type: "ESModule", globs: ["**/*.mjs"] }],
        assets: { directory: join(frontend, "dist/client"), binding: "ASSETS" },
        d1_databases: [
          {
            binding: "PUBLICATION_DB",
            database_name: "acme-fe-publications",
            database_id: "00000000-0000-0000-0000-000000000000",
            migrations_dir: join(frontend, "migrations"),
          },
        ],
      },
      null,
      2,
    ),
  );

  return {
    // In production Alchemy applies the migrations on deploy; here Wrangler
    // applies the same files to the local store the Worker is served with.
    migrate() {
      return spawnSync(
        wrangler,
        [
          "d1",
          "migrations",
          "apply",
          "PUBLICATION_DB",
          "--local",
          "--persist-to",
          persist,
          "--config",
          config,
        ],
        {
          env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
          encoding: "utf8",
          input: "",
        },
      );
    },
    // Runs SQL on the local store, as an operator's `wrangler d1 execute`
    // would on the real one. Only while the Worker is stopped.
    execute(sql) {
      return spawnSync(
        wrangler,
        [
          "d1",
          "execute",
          "PUBLICATION_DB",
          "--local",
          "--persist-to",
          persist,
          "--config",
          config,
          "--command",
          sql,
        ],
        {
          env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
          encoding: "utf8",
          input: "",
        },
      );
    },
    async start(port) {
      const child = spawn(
        wrangler,
        [
          "dev",
          "--config",
          config,
          "--local",
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--persist-to",
          persist,
          ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
          "--show-interactive-dev-session=false",
        ],
        {
          env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
          await fetch(`http://127.0.0.1:${port}/robots.txt`);
          return child;
        } catch {
          await new Promise((done) => setTimeout(done, 500));
        }
      }
      child.kill();
      throw new Error(`The Worker didn't start:\n${output}`);
    },
  };
}

export async function stopWorker(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  await exited;
}

export async function visit(port, path = "/") {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });
  return {
    status: response.status,
    location: response.headers.get("location"),
    cacheControl: response.headers.get("cache-control"),
    html: await response.text(),
  };
}

/**
 * Posts an event to the Frontend's /gq/events as the Site's CMS does: signed
 * with `secret` (HMAC-SHA256 of "<timestamp>.<body>") at `signedAt` (seconds,
 * default now). Resolves to the HTTP
 * status and the answer.
 */
export async function deliverEvent(port, secret, event, signedAt = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const timestamp = String(signedAt);
  const response = await fetch(`http://127.0.0.1:${port}/gq/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "GQ-Event-Timestamp": timestamp,
      "GQ-Event-Signature": `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`,
    },
    body,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * Runs a command without blocking this process (the stub CMS answers the
 * Worker from it). Resolves to its exit code and output.
 */
export function run(command, args, options = {}) {
  const child = spawn(command, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((done) => child.on("exit", (code) => done({ code, stdout, stderr })));
}

/** `gq <args>` from the site, as an operator runs it, with `env` added. */
export async function runGq(site, args, env) {
  const result = await run(process.execPath, [gq, ...args], {
    cwd: site,
    env: { ...process.env, ...env },
  });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { ...result, json };
}

export function servedEntry(html, text, menuLabel) {
  return (
    html.includes(text) &&
    new RegExp(`<a href="/about/"[^>]*>${menuLabel}</a>`).test(html) &&
    html.includes('src="https://media.example/logo.svg"') &&
    html.includes("--wp--preset--color--brand:#c00")
  );
}
