// Candidate integration proof: real CLI generation, installed pack, framework builds and HTTP HTML.
// No deployment, registry publication, source alias for the package, or CMS write is involved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const artifact = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "/missing-metadata-candidate.tgz",
);
const directory =
  process.argv.find((arg) => arg.startsWith("--directory="))?.slice("--directory=".length) ??
  process.env.GQ_FRONTEND_PROOF_DIR ??
  (await mkdtemp(join(tmpdir(), "gq-foundations-")));
await mkdir(directory, { recursive: true });
const images = [
  {
    url: "https://www.w3.org/assets/website-2021/images/w3c-opengraph-image.png",
    alt: "W3C",
    width: 1200,
    height: 600,
    type: "image/png",
  },
  {
    url: "https://www.w3.org/assets/logos/w3c-2025-transitional/w3c-72x48.png",
    alt: "W3C logo",
    width: 72,
    height: 48,
    type: "image/png",
  },
];
const report = {
  directory,
  artifact,
  sha256: createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex"),
  assets: [],
  checks: [],
  servers: [],
};
async function write(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function command(label, binary, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "NODE_PATH" && !key.startsWith("VP_")),
  );
  if (binary === "vp" && args[0] === "-C") {
    const local = join(args[1], "node_modules/.bin/vp");
    try {
      await access(local);
      binary = local;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const child = spawn(binary, args, {
    cwd: repo,
    env: { ...env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const code = await new Promise((done) => child.on("exit", done));
  await write(join(directory, `${label}.log`), output);
  assert.equal(code, 0, `${label}: ${output.slice(-6000)}`);
  report.checks.push(label);
  console.log(`PASS ${label}`);
}
// Inspect real public bytes and signatures rather than guessing dimensions/MIME from names.
for (const image of images) {
  const response = await fetch(image.url, { redirect: "error" });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^image\/png/u);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), image.width);
  assert.equal(bytes.readUInt32BE(20), image.height);
  report.assets.push({
    ...image,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    verifiedAt: new Date().toISOString(),
  });
}

const title = 'A & "friends" < 3';
const summary = 'Public summary & "quotes" < 3';
const languages = {
  en: { lang: "en-US", locale: "en_US", dir: "ltr" },
  pt: { lang: "pt-PT", locale: "pt_PT_ao90", dir: "ltr" },
  ar: { lang: "ar-EG", locale: "ar_EG", dir: "rtl" },
};
const servers = [];
async function startServer(frontend, framework, port) {
  // A local HTTP driver around the actual built framework handler, with real client assets.
  const entry = framework === "astro" ? "./dist/server/entry.mjs" : "./dist/server/server.js";
  await write(
    join(frontend, "serve-proof.mjs"),
    `import {createServer} from "node:http";\nimport {readFile} from "node:fs/promises";\nimport {extname,join} from "node:path";\nconst module=await import(${JSON.stringify(entry)});\nconst handler=module.handler??module.default.fetch;\ncreateServer(async(req,res)=>{try{const url=new URL(req.url,"http://localhost:${port}");const path=join(import.meta.dirname,"dist/client",decodeURI(url.pathname));if(!url.pathname.includes("..")){try{const bytes=await readFile(path);res.setHeader("Content-Type",({".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml"})[extname(path)]??"application/octet-stream");res.end(bytes);return;}catch{}}const response=await handler(new Request(url,{headers:req.headers}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(error){console.error(error);res.writeHead(500);res.end("Proof driver failure");}}).listen(${port},"0.0.0.0",()=>console.log("READY"));\n`,
  );
  const server = spawn("node", [join(frontend, "serve-proof.mjs")], {
    cwd: repo,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(server);
  let logs = "";
  server.stdout.on("data", (data) => {
    logs += data;
  });
  server.stderr.on("data", (data) => {
    logs += data;
  });
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(logs || "server not ready")), 10000);
    server.stdout.on("data", (data) => {
      if (String(data).includes("READY")) {
        clearTimeout(timeout);
        done();
      }
    });
  });

  return { server, logs: () => logs };
}
try {
  for (const [variant, framework] of [
    ["content", "astro"],
    ["commerce", "tanstack"],
  ]) {
    const root = join(directory, `ordinary-${framework}`);
    const frontend = join(root, "apps/frontend");
    await command(`ordinary-${framework}-generate`, "node", [
      join(repo, "bin/gq.mjs"),
      "new",
      root,
      "--project",
      "orbit",
      "--variant",
      variant,
    ]);
    await command(`ordinary-${framework}-install`, "vp", [
      "-C",
      root,
      "install",
      "--filter",
      "@orbit/frontend...",
      "--filter",
      ".",
    ]);
    const pkg = JSON.parse(await readFile(join(frontend, "package.json"), "utf8"));
    assert.equal(pkg.dependencies["@getquick/content"], undefined);
    for (const task of ["test", "check", "build", "lint"])
      await command(`ordinary-${framework}-${task}`, "vp", ["-C", frontend, "run", task]);
    await command(`ordinary-${framework}-format`, "vp", ["-C", frontend, "fmt", "--check", "."]);
    const port = framework === "astro" ? 4383 : 4384;
    const running = await startServer(frontend, framework, port);
    for (const path of ["/", "/missing"]) {
      const response = await fetch(`http://localhost:${port}${path}`);
      const html = await response.text();
      assert.equal(response.status, framework === "astro" ? 503 : path === "/" ? 200 : 404);
      assert.match(html, /<!doctype html>/iu);
      assert.match(html, /<html[^>]*lang="en-US"[^>]*dir="ltr"/u);
      assert.match(html, /<header[^>]*>/u);
      assert.match(html, /<main[^>]*id="main-content"[^>]*tabindex="-1"/iu);
      assert.match(html, /<footer[^>]*>/u);
      assert.match(html, /href="#main-content"/u);
      assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/u);
      assert.doesNotMatch(html, /property="og:/u);
      await write(join(directory, `ordinary-${framework}-${path.replaceAll("/", "_")}.html`), html);
      report.checks.push(`ordinary-${framework} HTTP ${path} semantic accessible shell`);
    }
    report.servers.push({
      framework: `ordinary-${framework}`,
      port,
      frontend,
      pid: running.server.pid,
    });
    await write(join(directory, `ordinary-${framework}-server.log`), running.logs());
  }
  for (const [variant, framework, port] of [
    ["content", "astro", 4381],
    ["commerce", "tanstack", 4382],
  ]) {
    const root = join(directory, framework);
    const frontend = join(root, "apps/frontend");
    await command(`${framework}-generate`, "node", [
      join(repo, "bin/gq.mjs"),
      "new",
      root,
      "--project",
      "orbit",
      "--variant",
      variant,
      "--metadata-candidate",
      artifact,
    ]);
    await command(`${framework}-install`, "vp", [
      "-C",
      root,
      "install",
      "--filter",
      "@orbit/frontend...",
      "--filter",
      ".",
    ]);

    const pendingFacts = {
      title: "Pending origin",
      route: "/pending",
      state: "public",
      status: 200,
      language: languages.en,
      translations: [{ language: languages.pt, route: "/pt", translation: true }],
    };
    if (framework === "astro")
      await write(
        join(frontend, "src/pages/pending.astro"),
        `---\nimport Layout from "../layouts/Layout.astro";\nconst alternates=[{language:{locale:"pt_PT_ao90",lang:"pt-PT",slug:"pt",code:"PT",isDefault:false,home:"/pt/"},route:"/pt/",translation:true}];\n---\n<Layout title="Pending origin" chrome={null} alternates={alternates}><main id="main-content" tabindex="-1"><h1>Pending origin</h1></main></Layout>\n`,
      );
    else
      await write(
        join(frontend, "src/routes/pending.tsx"),
        `import {createFileRoute} from "@tanstack/react-router";\nimport {documentMetadata} from "../lib/document-head";\nimport {publicRouteError} from "../lib/public-route-error";\nexport const Route=createFileRoute("/pending")({onError:publicRouteError,loader:()=>({documentMetadata:documentMetadata(${JSON.stringify(pendingFacts)})}),component:()=> <main id="main-content" tabIndex={-1}><h1>Pending origin</h1></main>});\n`,
      );
    await command(`${framework}-unconfigured-build`, "vp", ["-C", frontend, "run", "build"]);
    await command(`${framework}-unconfigured-check`, "vp", ["-C", frontend, "run", "check"]);
    const metadata = await import(
      pathToFileURL(join(frontend, "node_modules/@getquick/content/dist/metadata.js"))
    );
    const testing = await import(
      pathToFileURL(join(frontend, "node_modules/@getquick/content/dist/metadata-testing.js"))
    );
    const initial = await startServer(frontend, framework, port);
    const initialResponse = await fetch(`http://localhost:${port}/`);
    const initialHtml = await initialResponse.text();
    testing.assertMetadataHtml(initialHtml, {
      baseline: "OG-1",
      graph: false,
      applicable: framework !== "astro",
      title: framework === "astro" ? "Temporarily unavailable — Orbit" : "Orbit",
      lang: "en-US",
      dir: "ltr",
      robots: framework === "astro" ? "noindex, nofollow" : "index, follow",
    });
    assert.equal(initialResponse.status, framework === "astro" ? 503 : 200);
    await write(join(directory, `${framework}-unconfigured.html`), initialHtml);

    const pendingResponse = await fetch(`http://localhost:${port}/pending`);
    const pendingHtml = await pendingResponse.text();
    assert.equal(
      pendingResponse.status,
      200,
      "Missing origin with published translations must reach provider diagnostics, not throw",
    );
    testing.assertMetadataHtml(pendingHtml, {
      baseline: "OG-1",
      graph: false,
      applicable: true,
      title: framework === "astro" ? "Pending origin — Orbit" : "Pending origin",
      lang: "en-US",
      dir: "ltr",
      robots: "index, follow",
    });
    await write(join(directory, `${framework}-pending-origin.html`), pendingHtml);
    report.checks.push(
      `${framework} pending origin with published translations HTTP200/diagnostics/no graph`,
    );
    initial.server.kill("SIGTERM");
    await new Promise((done) => initial.server.once("exit", done));
    report.checks.push(`${framework} unconfigured HTTP honest pending head`);
    await write(
      join(frontend, "src/site-metadata.ts"),
      `export const metadataSite = ${JSON.stringify({ origin: "not a public origin", name: "Orbit", language: languages.en })} as const;\n`,
    );
    await command(`${framework}-invalid-origin-build`, "vp", ["-C", frontend, "run", "build"]);
    const invalidServer = await startServer(frontend, framework, port);
    const invalidResponse = await fetch(`http://localhost:${port}/pending`);
    const invalidHtml = await invalidResponse.text();
    assert.equal(
      invalidResponse.status,
      200,
      "Invalid origin must not throw before provider validation",
    );
    testing.assertMetadataHtml(invalidHtml, {
      baseline: "OG-1",
      graph: false,
      applicable: true,
      title: framework === "astro" ? "Pending origin — Orbit" : "Pending origin",
      lang: "en-US",
      dir: "ltr",
      robots: "index, follow",
    });
    await write(join(directory, `${framework}-invalid-origin.html`), invalidHtml);
    invalidServer.server.kill("SIGTERM");
    await new Promise((done) => invalidServer.server.once("exit", done));
    report.checks.push(`${framework} invalid origin with published translations HTTP200/no graph`);

    const unconfigured = metadata.resolveMetadata({
      site: { origin: "", name: "Orbit", language: languages.en },
      status: 200,
      state: "public",
      page: { title: "Orbit" },
    });
    assert.equal(unconfigured.ready, false);
    assert.ok(unconfigured.diagnostics.some((d) => d.field === "site.origin"));
    assert.ok(unconfigured.diagnostics.some((d) => d.field === "images"));
    assert.ok(
      !unconfigured.head.some(
        (node) => node.tag === "meta" && node.attrs.property?.startsWith("og:"),
      ),
    );
    await write(
      join(frontend, "src/site-metadata.ts"),
      `export const metadataSite = ${JSON.stringify({ origin: "https://example.com", name: "Orbit", language: languages.en, description: summary, images })} as const;\n`,
    );

    if (framework === "astro") {
      const ops = JSON.parse(await readFile(join(root, "gq.ops.json"), "utf8"));
      ops.domains = { admin: "admin.example.com", frontend: "example.com" };
      ops.wordpress.plugins.push("polylang", "gq-polylang-graphql");
      ops.wordpress.languages = [{ locale: "pt_PT_ao90", slug: "pt" }];
      await write(join(root, "gq.ops.json"), JSON.stringify(ops, null, 2));
      const sqlHelper = (await readFile(join(frontend, "src/test/sqlite-d1.ts"), "utf8")).replace(
        'new URL("../../migrations/", import.meta.url)',
        `new URL(${JSON.stringify(pathToFileURL(join(frontend, "migrations/")).href)})`,
      );
      await write(join(frontend, "src/proof/sqlite-d1.ts"), sqlHelper);
      const home = (heading) => ({
        settings: { title: "Orbit", description: summary },
        page: {
          title: heading,
          content: `<h1>${heading.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</h1><p>Public content.</p><a href="/about/">About</a>`,
          hasVideoHero: false,
        },
        spacingSizes: [],
        colors: [],
      });
      const chrome = {
        siteLogo: null,
        siteIcon: null,
        menuItems: [{ id: "about", label: "About", href: "/about/", target: null, children: [] }],
      };
      const entry = {
        id: "page-1",
        title,
        excerpt: summary,
        content: '<h2>Details</h2><p>Public content.</p><a href="/">Home</a>',
        uri: "/about/",
        date: "",
        featuredImage: null,
        hasVideoHero: false,
        spacingSizes: [],
        colors: [],
        language: "en",
        translations: [{ uri: "/pt/sobre/", language: "pt" }],
      };
      const rows = [
        ["home", "published", home("Home")],
        ["home:pt", "published", home("Início")],
        ["chrome", "published", chrome],
        ["chrome:pt", "published", chrome],
        ["design", "published", { spacingSizes: [], colors: [] }],
        ["entry:/about/", "published", entry],
        [
          "entry:/article/",
          "published",
          {
            ...entry,
            id: "post-2",
            title: "Article",
            date: "2026-10-21T09:30:00",
            uri: "/article/",
            translations: [],
          },
        ],
        [
          "entry:/pt/sobre/",
          "published",
          {
            ...entry,
            title: "Sobre",
            language: "pt",
            uri: "/pt/sobre/",
            translations: [{ uri: "/about/", language: "en" }],
          },
        ],
        ["entry:/missing/", "missing", null],
        ["entry:/withdrawn/", "withdrawn", null],
        ["entry:/upstream-error/", "published", { invalid: true }],
      ];
      await write(
        join(frontend, "src/proof/bindings.ts"),
        `import { openTestD1 } from "./sqlite-d1";\nconst db=openTestD1();\nfor (const [key,state,body] of ${JSON.stringify(rows)}) db.exec("INSERT INTO publications (key,state,format,body,read_started_at,promoted_at) VALUES ("+[key,state,1,JSON.stringify(body),1,1].map(v=>"'"+String(v).replaceAll("'","''")+"'").join(",")+")");\nexport const env={PUBLICATION_DB:db};\n`,
      );
      await write(
        join(frontend, "scripts/build-proof.mjs"),
        `import {build} from "astro";\nimport {distilledNode} from "@alchemy.run/frontend-frameworks/astro/node";\nawait build({integrations:[distilledNode()],vite:{resolve:{alias:{"cloudflare:workers":${JSON.stringify(join(frontend, "src/proof/bindings.ts"))}}}}});\n`,
      );
      await write(
        join(frontend, "src/pages/private.astro"),
        `---\nimport Layout from "../layouts/Layout.astro";\n---\n<Layout title="Private page" state="private" chrome={null}><main id="main-content" tabindex="-1"><h1>Sign in required</h1></main></Layout>\n`,
      );
      await write(
        join(frontend, "src/pages/forbidden.astro"),
        `---\nimport Layout from "../layouts/Layout.astro";\nAstro.response.status=403;\n---\n<Layout title="Access denied" state="private" chrome={null}><main id="main-content" tabindex="-1"><h1>Access denied</h1></main></Layout>\n`,
      );
      await write(
        join(frontend, "src/pages/rtl.astro"),
        `---\nimport Layout from "../layouts/Layout.astro";\nconst language={locale:"ar_EG",lang:"ar-EG",slug:"ar",code:"AR",isDefault:false,home:"/rtl/"};\n---\n<Layout title="العربية" description="صفحة عامة" language={language} chrome={null}><main id="main-content" tabindex="-1"><h1>العربية</h1></main></Layout>\n`,
      );
      await command(`${framework}-configured-check`, "vp", ["-C", frontend, "run", "check"]);
      await command(`${framework}-configured-build`, "vp", [
        "-C",
        frontend,
        "exec",
        "node",
        "scripts/build-proof.mjs",
      ]);
    } else {
      // Site-owned routes exercise the installed adapter; no catalog, BFF or commerce behavior is invented.
      for (const [path, heading, language, state, status] of [
        ["about", title, languages.en, "public", 200],
        ["pt", "Sobre", languages.pt, "public", 200],
        ["rtl", "العربية", languages.ar, "public", 200],
        ["private", "Private page", languages.en, "private", 200],
        ["forbidden", "Access denied", languages.en, "private", 403],
        ["upstream-error", "Temporarily unavailable", languages.en, "error", 503],
      ]) {
        const translated =
          path === "about"
            ? [{ language: languages.pt, route: "/pt", translation: true }]
            : path === "pt"
              ? [{ language: languages.en, route: "/about", translation: true }]
              : [];
        const facts = {
          title: heading,
          description: summary,
          route: `/${path}`,
          language,
          state,
          status,
          translations: translated,
        };
        const fail =
          status === 503
            ? 'throw new Error("private upstream detail must not leak");'
            : `${status === 403 ? "applyStatus();" : ""}return { documentMetadata: documentMetadata(${JSON.stringify(facts)}) };`;
        await write(
          join(frontend, `src/routes/${path}.tsx`),
          `import {createFileRoute,Link} from "@tanstack/react-router";\n${status === 403 ? 'import {createIsomorphicFn} from "@tanstack/react-start";\nimport {setResponseStatus} from "@tanstack/react-start/server";\nconst applyStatus=createIsomorphicFn().server(()=>setResponseStatus(403)).client(()=>{});\n' : ""}import {documentMetadata} from "../lib/document-head";\nimport {publicRouteError} from "../lib/public-route-error";\nexport const Route=createFileRoute("/${path}")({onError:publicRouteError,loader:()=>{${fail}},staticData:{documentLanguage:${JSON.stringify(language)}},component:()=> <main id="main-content" tabIndex={-1}><h1>${heading.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</h1><p>Public content.</p><Link to="/about">About</Link><Link to="/pt">Português</Link><Link to="/private">Private</Link><Link to="/upstream-error">Error</Link><Link to="/rtl">العربية</Link><Link to="/">Home</Link></main>});\n`,
        );
      }
      await command(`${framework}-configured-build`, "vp", ["-C", frontend, "run", "build"]);
      await command(`${framework}-configured-check`, "vp", ["-C", frontend, "run", "check"]);
    }
    const running = await startServer(frontend, framework, port);
    const server = running.server;
    const versions = {};
    for (const name of [
      "astro",
      "@tanstack/react-start",
      "@tanstack/react-router",
      "react",
      "vite-plus",
      "typescript",
      "@getquick/content",
      "@alchemy.run/frontend-frameworks",
    ]) {
      try {
        versions[name] = JSON.parse(
          await readFile(join(frontend, "node_modules", name, "package.json"), "utf8"),
        ).version;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await command(`${framework}-node-version`, "vp", ["-C", frontend, "exec", "node", "--version"]);
    report.servers.push({ framework, port, frontend, pid: server.pid, versions });
    const cases =
      framework === "astro"
        ? [
            ["/", "Home — Orbit", languages.en],
            ["/pt/", "Início — Orbit", languages.pt],
            ["/about/", `${title} — Orbit`, languages.en],
            ["/article/", "Article — Orbit", languages.en],
            ["/pt/sobre/", "Sobre — Orbit", languages.pt],
            ["/rtl/", "العربية — Orbit", languages.ar],
            ["/private", "Private page — Orbit", languages.en, "private", 200],
            ["/forbidden", "Access denied — Orbit", languages.en, "private", 403],
            ["/missing/", "Page not found — Orbit", languages.en, "error", 404],
            ["/withdrawn/", "Page not found — Orbit", languages.en, "error", 404],
            ["/upstream-error/", "Temporarily unavailable — Orbit", languages.en, "error", 503],
          ]
        : [
            ["/", "Orbit", languages.en],
            ["/about", title, languages.en],
            ["/pt", "Sobre", languages.pt],
            ["/rtl", "العربية", languages.ar],
            ["/private", "Private page", languages.en, "private", 200],
            ["/forbidden", "Access denied", languages.en, "private", 403],
            ["/missing", "Page not found", languages.en, "error", 404],
            ["/upstream-error", "Temporarily unavailable", languages.en, "error", 500],
          ];
    for (const [path, expectedTitle, language, state = "public", status = 200] of cases) {
      const response = await fetch(`http://localhost:${port}${path}`);
      const html = await response.text();
      await write(
        join(directory, `${framework}-${path.replaceAll("/", "_") || "home"}.html`),
        html,
      );
      assert.equal(response.status, status, `${framework} ${path}`);
      const translated =
        framework === "astro" && ["/", "/pt/"].includes(path)
          ? path === "/"
            ? [
                { lang: "en-US", url: "https://example.com/" },
                { lang: "pt-PT", url: "https://example.com/pt/" },
              ]
            : [
                { lang: "pt-PT", url: "https://example.com/pt/" },
                { lang: "en-US", url: "https://example.com/" },
              ]
          : framework === "astro" && ["/about/", "/pt/sobre/"].includes(path)
            ? path === "/about/"
              ? [
                  { lang: "en-US", url: "https://example.com/about/" },
                  { lang: "pt-PT", url: "https://example.com/pt/sobre/" },
                ]
              : [
                  { lang: "pt-PT", url: "https://example.com/pt/sobre/" },
                  { lang: "en-US", url: "https://example.com/about/" },
                ]
            : framework === "tanstack" && ["/about", "/pt"].includes(path)
              ? path === "/about"
                ? [
                    { lang: "en-US", url: "https://example.com/about" },
                    { lang: "pt-PT", url: "https://example.com/pt" },
                  ]
                : [
                    { lang: "pt-PT", url: "https://example.com/pt" },
                    { lang: "en-US", url: "https://example.com/about" },
                  ]
              : [];
      const expected = {
        baseline: "OG-1",
        applicable: state === "public",
        title: expectedTitle,
        lang: language.lang,
        dir: language.dir,
        robots: state === "public" ? "index, follow" : "noindex, nofollow",
        ...(state === "public"
          ? {
              canonical: `https://example.com${path}`,
              description: path === "/rtl/" ? "صفحة عامة" : summary,
              siteName: "Orbit",
              locale: language.locale === "pt_PT_ao90" ? "pt_PT" : language.locale,
              type: framework === "astro" && path === "/article/" ? "article" : "website",
              images,
              alternates: translated.length
                ? [
                    ...translated,
                    {
                      lang: "x-default",
                      url: translated.find((item) => item.lang === "en-US").url,
                    },
                  ]
                : [],
              localeAlternates: translated
                .filter((item) => item.lang !== language.lang)
                .map((item) => (item.lang === "pt-PT" ? "pt_PT" : "en_US")),
            }
          : {}),
      };
      testing.assertMetadataHtml(html, expected);
      assert.match(html, /<main[^>]*id="main-content"/u);
      assert.match(html, /href="#main-content"/u);
      assert.doesNotMatch(html, /private upstream detail must not leak/u);
      report.checks.push(`${framework} HTTP ${path} ${status} final head`);
    }
    await write(join(directory, `${framework}-server.log`), running.logs());
  }
  assert.equal(
    createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex"),
    report.sha256,
    "Candidate changed during integration proof; rerun against one immutable artifact",
  );
  await write(join(directory, "result.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${directory}/result.json`);
  if (process.argv.includes("--keep") || process.env.KEEP_FRONTEND_SERVERS === "1") {
    console.log("Keeping framework servers for collaborative browser checks.");
    await new Promise((done) => {
      process.once("SIGTERM", done);
      process.once("SIGINT", done);
    });
  }
} finally {
  servers.forEach((server) => server.kill("SIGTERM"));
}
