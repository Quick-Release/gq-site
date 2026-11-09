import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";

const ROOT = "/wp-json/wp/v2/";
const SAFE = /^[a-z][a-z0-9_-]*$/u;
const RESERVED = new Set([
  "users",
  "settings",
  "plugins",
  "themes",
  "search",
  "templates",
  "template-parts",
  "navigation",
  "types",
  "taxonomies",
  "statuses",
  "comments",
  "menu-items",
  "menus",
  "global-styles",
]);

// Discovery is data, never authority to send credentials to an arbitrary URL.
export async function discoverEditorial(request, routes) {
  const types = await request("GET", `${ROOT}types`, { query: { context: "edit" } });
  const taxonomies = await request("GET", `${ROOT}taxonomies`, { query: { context: "edit" } });
  const accepted = {};
  const terms = {};
  const valid = (entry) =>
    entry?.rest_namespace === "wp/v2" &&
    SAFE.test(entry.rest_base) &&
    !RESERVED.has(entry.rest_base);
  for (const [name, entry] of Object.entries(types)) {
    if (
      !SAFE.test(name) ||
      (name.startsWith("wp_") && name !== "wp_block") ||
      !valid(entry) ||
      !entry.supports?.editor ||
      name === "attachment"
    )
      continue;
    accepted[name] = entry;
    routes.add(`${ROOT}${entry.rest_base}`);
  }
  // Media is a fixed editorial route, independent of its editor support.
  routes.add(`${ROOT}media`);
  for (const [name, entry] of Object.entries(taxonomies)) {
    if (!SAFE.test(name) || !valid(entry) || !entry.types?.some((type) => accepted[type])) continue;
    terms[name] = entry;
    routes.add(`${ROOT}${entry.rest_base}`);
  }
  return { types: accepted, taxonomies: terms };
}

export function parseEditorial(argv) {
  const [action, ...args] = argv;
  const allowed = {
    types: [],
    list: ["type", "search", "page"],
    terms: ["taxonomy", "search", "page"],
    media: ["search", "page"],
    upload: ["file", "yes"],
    create: ["type", "file", "yes"],
  }[action];
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: Object.fromEntries(
      allowed.map((key) => [key, { type: key === "yes" ? "boolean" : "string" }]),
    ),
  });
  if (positionals.length) throw new Error("Editorial commands take named options only.");
  if (["create", "upload"].includes(action) && !values.file) throw new Error("--file is required.");
  if (["create", "list"].includes(action) && !SAFE.test(values.type ?? ""))
    throw new Error("--type is required.");
  if (action === "terms" && !SAFE.test(values.taxonomy ?? ""))
    throw new Error("--taxonomy is required.");
  if (values.page && !/^[1-9][0-9]*$/u.test(values.page))
    throw new Error("--page must be positive.");
  return { action, ...values };
}

export async function runEditorial({ command, file, request, catalog, io }) {
  const { action } = command;
  if (action === "types") {
    io.out(JSON.stringify(catalog, null, 2));
    return 0;
  }
  const type = catalog.types[command.type];
  let result;
  const query = {
    context: "edit",
    per_page: 100,
    page: command.page ?? 1,
    ...(command.search ? { search: command.search } : {}),
  };
  if (action === "list")
    result = await request("GET", ROOT + type.rest_base, { query: { ...query, status: "any" } });
  if (action === "terms") {
    const taxonomy = catalog.taxonomies[command.taxonomy];
    if (!taxonomy) throw new Error("Unknown editorial taxonomy.");
    result = await request("GET", ROOT + taxonomy.rest_base, {
      query: { ...query, hide_empty: false },
    });
  }
  if (action === "media") result = await request("GET", ROOT + "media", { query });
  if (action === "upload") {
    if (!command.yes) throw new Error("Pass --yes to upload one PDF.");
    const bytes = await readFile(file);
    if (
      !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
      !bytes.subarray(-2048).includes(Buffer.from("%%EOF"))
    )
      throw new Error(
        "Expected a PDF with header and EOF marker; validate the document before upload.",
      );
    const name = basename(file);
    if (!/^[a-zA-Z0-9_.-]+\.pdf$/u.test(name)) throw new Error("Use a simple .pdf filename.");
    result = await request("POST", ROOT + "media", { binary: bytes, filename: name });
  }
  if (action === "create") {
    const body = JSON.parse(await readFile(file, "utf8"));
    const allowed = new Set([
      "title",
      "slug",
      "excerpt",
      "meta",
      ...Object.values(catalog.taxonomies)
        .filter((entry) => entry.types.includes(command.type))
        .map((entry) => entry.rest_base),
    ]);
    if (!body || Array.isArray(body) || typeof body !== "object")
      throw new Error("Expected one item object.");
    for (const key of Object.keys(body)) {
      if (!allowed.has(key))
        throw new Error(
          `Unsupported creation field: ${key}. Add block content through get/validate/put after creating the draft.`,
        );
      if (
        !["title", "slug", "excerpt", "meta"].includes(key) &&
        (!Array.isArray(body[key]) || body[key].some((id) => !Number.isSafeInteger(id) || id < 1))
      )
        throw new Error("Taxonomy assignments require positive term IDs.");
    }
    if (typeof body.title !== "string" || !body.title.trim())
      throw new Error("A title is required.");
    io.out(JSON.stringify({ type: command.type, ...body, status: "draft" }, null, 2));
    if (!command.yes) throw new Error("Review the draft payload and pass --yes to create once.");
    result = await request("POST", ROOT + type.rest_base, {
      query: { context: "edit" },
      body: { ...body, status: "draft" },
    });
    if (!Number.isSafeInteger(result?.id) || result.status !== "draft")
      throw new Error("CMS did not confirm a draft; inspect CMS before retrying.");
  }
  io.out(JSON.stringify(result, null, 2));
  return 0;
}
