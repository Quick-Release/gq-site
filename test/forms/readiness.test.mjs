// Headless forms readiness (gq-platform ADR 0009) for a Site whose gq.ops.json
// declares `forms`: the production checks gq site check runs against the CMS's
// public GraphQL and Sigillo's names, and the local CMS's wp gq-forms status.
// The CMS is a stub answering as gq-content 0.4.0's forms module does, with
// @getquick/content's own form fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { CONTACT_FORM, UNSUPPORTED_FORM } from "@getquick/content/forms/testing";

import {
  FORMS_QUERY,
  FORMS_SCHEMA_QUERY,
  localFormsStatus,
  siteFormsReadiness,
} from "../../src/forms/readiness.mjs";
import { createFixtureSite, recordingExec, recordingFetch } from "../support/fixture-site.mjs";

const GRAPHQL = "https://cms.example.test/wp/graphql";

const OPS = {
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  contentRuntime: "package",
  domains: { admin: "cms.example.test", frontend: "www.example.test" },
  wordpress: { plugins: ["wp-graphql", "gravityforms"] },
  forms: { provider: "gravityforms", spam: ["honeypot"] },
};
const TURNSTILE = { ...OPS, forms: { provider: "gravityforms", spam: ["honeypot", "turnstile"] } };
const TURNSTILE_ENV = { TURNSTILE_SECRET_KEY: "secret-value", TURNSTILE_SITE_KEY: "site-key" };

// A CMS whose published entries reference `pages` (each a list of
// { uri, forms }), one GraphQL page each; without Gravity Forms its schema
// has no getquickForms.
function cms({ active = true, pages = [[{ uri: "/contactos/", forms: [CONTACT_FORM] }]] } = {}) {
  return recordingFetch(({ url, body }) => {
    assert.equal(url, GRAPHQL);
    const { query, variables } = JSON.parse(body);
    if (!active) {
      return {
        errors: [{ message: 'Cannot query field "getquickForms" on type "ContentNode".' }],
      };
    }
    if (query === FORMS_SCHEMA_QUERY) return { data: {} };
    assert.equal(query, FORMS_QUERY);
    const index = variables.after === null ? 0 : Number(variables.after);
    return {
      data: {
        contentNodes: {
          pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) },
          nodes: pages[index].map(({ uri, forms }) => ({
            uri,
            getquickForms: forms ? JSON.stringify(forms) : null,
          })),
        },
      },
    };
  });
}

async function check({ ops = OPS, env = {}, fetch = cms() } = {}) {
  const checks = await siteFormsReadiness({ ops, env, fetch });
  for (const entry of checks) assert.equal(entry.area, "forms");
  return {
    checks,
    fetch,
    byName: Object.fromEntries(checks.map((entry) => [entry.name, entry])),
    ready: !checks.some(({ status }) => status === "not-ready"),
  };
}

test("a Site without forms has no forms checks and asks the CMS nothing", async () => {
  const fetch = recordingFetch();
  assert.deepEqual(
    await siteFormsReadiness({ ops: { ...OPS, forms: undefined }, env: {}, fetch }),
    [],
  );
  assert.equal(fetch.requests.length, 0);
});

test("a honeypot-only Site whose published forms are all supported is ready", async () => {
  const { ready, byName, checks } = await check({
    fetch: cms({
      pages: [
        [
          { uri: "/contactos/", forms: [CONTACT_FORM] },
          { uri: "/sobre/", forms: null },
        ],
        [{ uri: "/en/contacts/", forms: [CONTACT_FORM] }],
      ],
    }),
  });

  assert.equal(ready, true, JSON.stringify(checks));
  assert.deepEqual(
    checks.map(({ name, status }) => [name, status]),
    [
      ["gravity-forms", "ok"],
      ["form-fields", "ok"],
      ["spam-controls", "ok"],
    ],
  );
  assert.match(byName["form-fields"].detail, /^form 1 \(Contactos\) can be sent$/u);
  assert.match(byName["spam-controls"].detail, /honeypot: nothing to provision/u);
});

test("Gravity Forms not active on the CMS is not ready, and its forms aren't read", async () => {
  const { ready, byName, fetch } = await check({ fetch: cms({ active: false }) });

  assert.equal(ready, false);
  assert.equal(byName["gravity-forms"].status, "not-ready");
  assert.match(byName["gravity-forms"].detail, /Gravity Forms isn't active there/u);
  assert.match(byName["gravity-forms"].action, /wordpress\.plugins.*wp gq-forms status/u);
  assert.equal(byName["form-fields"].status, "skipped");
  assert.equal(fetch.requests.length, 1);
});

test("a published form with an unsupported field is not ready, naming the form, its page and why", async () => {
  const { ready, byName } = await check({
    fetch: cms({
      pages: [
        [
          { uri: "/contactos/", forms: [CONTACT_FORM] },
          { uri: "/candidatura/", forms: [UNSUPPORTED_FORM] },
        ],
      ],
    }),
  });

  assert.equal(ready, false);
  const fields = byName["form-fields"];
  assert.equal(fields.status, "not-ready");
  assert.match(
    fields.detail,
    /form 2 \(Candidatura\) on \/candidatura\/: unsupported-captcha, unsupported-file-upload, unsupported-payment, unsupported-multi-page/u,
  );
  assert.doesNotMatch(fields.detail, /form 1/u);
  assert.match(fields.action, /wp gq-forms status/u);
});

test("Turnstile chosen without its keys is not ready, naming the keys, never a value", async () => {
  const missing = await check({ ops: TURNSTILE, env: {} });
  assert.equal(missing.ready, false);
  assert.equal(missing.byName["spam-controls"].status, "not-ready");
  assert.match(
    missing.byName["spam-controls"].detail,
    /lacks TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY/u,
  );

  const half = await check({ ops: TURNSTILE, env: { TURNSTILE_SITE_KEY: "site-key" } });
  assert.equal(half.ready, false);
  assert.match(half.byName["spam-controls"].detail, /lacks TURNSTILE_SECRET_KEY:/u);

  const both = await check({ ops: TURNSTILE, env: TURNSTILE_ENV });
  assert.equal(both.ready, true, JSON.stringify(both.checks));
  assert.doesNotMatch(JSON.stringify(both.checks), /secret-value/u);
});

test("the submissions path's Access token must be a whole pair; Access on GraphQL alone warns", async () => {
  const partial = await check({ env: { GQ_FORMS_ACCESS_CLIENT_ID: "id" } });
  assert.equal(partial.ready, false);
  assert.match(partial.byName["cms-access"].detail, /without GQ_FORMS_ACCESS_CLIENT_SECRET/u);

  const graphqlOnly = await check({
    env: { GQ_AUTH_GRAPHQL_CLIENT_ID: "id", GQ_AUTH_GRAPHQL_CLIENT_SECRET: "secret" },
  });
  assert.equal(graphqlOnly.ready, true);
  assert.equal(graphqlOnly.byName["cms-access"].status, "warn");
  // Access headers go to GraphQL only (docs/guides/cms-access.md).
  for (const request of graphqlOnly.fetch.requests) {
    assert.equal(request.headers["CF-Access-Client-Id"], "id");
  }
});

test("a form without Gravity Forms' honeypot on a Site relying on it warns", async () => {
  const { ready, byName } = await check({
    fetch: cms({ pages: [[{ uri: "/contactos/", forms: [{ ...CONTACT_FORM, honeypot: null }] }]] }),
  });
  assert.equal(ready, true);
  assert.equal(byName["form-fields"].status, "warn");
  assert.match(byName["form-fields"].detail, /honeypot/u);
});

test("no published form yet is ready", async () => {
  const { ready, byName } = await check({ fetch: cms({ pages: [[{ uri: "/", forms: null }]] }) });
  assert.equal(ready, true);
  assert.match(byName["form-fields"].detail, /no published content references a form yet/u);
});

// --- wp gq-forms status on the local CMS ---------------------------------------

function status(report, code = report.ok === false ? 1 : 0) {
  return { code, stdout: `${JSON.stringify(report)}\n` };
}

const FORM_ROW = {
  id: 1,
  title: "Contactos",
  available: true,
  honeypot: true,
  diagnostics: [],
  referencedBy: ["/contactos/"],
};

test("wp gq-forms status: inactive Gravity Forms, unsupported fields and a missing command fail", () => {
  const inactive = localFormsStatus(
    status({ gravityForms: { active: false, version: null }, forms: [], ok: true }),
  );
  assert.deepEqual(
    inactive.map(({ name, status }) => [name, status]),
    [["gravity-forms", "not-ready"]],
  );

  const unsupported = localFormsStatus(
    status({
      gravityForms: { active: true, version: "3.2.0" },
      forms: [
        FORM_ROW,
        {
          ...FORM_ROW,
          id: 2,
          title: "Candidatura",
          diagnostics: [{ code: "unsupported-captcha", fieldId: 10, type: "captcha" }],
          referencedBy: ["/candidatura/"],
        },
      ],
      ok: false,
    }),
  );
  assert.deepEqual(
    unsupported.map(({ name, status }) => [name, status]),
    [
      ["gravity-forms", "ok"],
      ["form-fields", "ok"],
      ["form-fields", "not-ready"],
    ],
  );
  assert.match(unsupported[0].detail, /Gravity Forms 3\.2\.0 is active/u);
  assert.match(
    unsupported[2].detail,
    /form 2 \(Candidatura\) on \/candidatura\/ has unsupported-captcha/u,
  );

  const old = localFormsStatus({
    code: 1,
    stdout: "Error: 'gq-forms' is not a registered wp command.",
  });
  assert.equal(old[0].status, "not-ready");
  assert.match(old[0].detail, /older than 0\.4\.0/u);
});

test("gq site check --local runs wp gq-forms status for a Site with forms", async () => {
  const fixture = await createFixtureSite({
    ops: OPS,
    files: { "apps/cms/.env": "WP_HOME='https://fixture-admin.ddev.site'\n" },
  });
  const exec = recordingExec(({ command, args }) => {
    if (command === "mkcert") return { code: 1 };
    if (command === "ddev" && args[0] === "describe") {
      return { stdout: JSON.stringify({ raw: { status: "running" } }) };
    }
    if (command === "ddev" && args.join(" ") === "wp gq-forms status --format=json") {
      return status({
        gravityForms: { active: true, version: "3.2.0" },
        forms: [FORM_ROW],
        ok: true,
      });
    }
    return { code: 1, stderr: `unexpected ${command} ${args.join(" ")}` };
  });
  const fetch = recordingFetch(({ body }) =>
    JSON.parse(body).query === "{ __typename }"
      ? { data: { __typename: "RootQuery" } }
      : { data: {} },
  );

  const result = await fixture.run(["site", "check", "--local", "--json"], { exec, fetch });

  assert.equal(result.code, 0, result.stdout + result.stderr);
  const forms = JSON.parse(result.stdout).checks.filter(({ area }) => area === "forms");
  assert.deepEqual(
    forms.map(({ name, status }) => [name, status]),
    [
      ["gravity-forms", "ok"],
      ["form-fields", "ok"],
    ],
  );
});
