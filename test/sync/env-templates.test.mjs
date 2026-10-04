// The local env files a Site's apps start from (blueprint env.example
// templates, which gq setup copies to .env) hold only non-secret wiring:
// secrets come from Sigillo through gq sigillo run. The CMS's
// env.production.example is the shape of Ploi's server-side .env, the
// platform's own store, and isn't one of them.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parseDotenv } from "../../src/dotenv-text.mjs";

const APPS = new URL("../../blueprint/templates/apps/", import.meta.url);
const SECRET_SHAPED = /(?:TOKEN|SECRET|PASSWORD|AUTH|ACCESS_KEY|API_KEY)$|^S3_UPLOADS_KEY$/u;
// Published local values, the same on every machine.
const PUBLISHED_LOCAL = new Set([
  // DDEV's own database password for its local container.
  "DB_PASSWORD",
]);

test("a new Site's local env templates declare no secret", async () => {
  const apps = await readdir(APPS);
  const templates = [];
  for (const app of apps) {
    const path = join(APPS.pathname, app, "env.example");
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null) templates.push({ app, names: Object.keys(parseDotenv(text)) });
  }

  assert.ok(templates.length >= 2, "the CMS and Frontend templates are found");
  for (const { app, names } of templates) {
    const secrets = names.filter((name) => SECRET_SHAPED.test(name) && !PUBLISHED_LOCAL.has(name));
    assert.deepEqual(secrets, [], `apps/${app}/env.example declares a secret`);
  }
});
