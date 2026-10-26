// Headless forms readiness (gq-platform ADR 0009), for a Site whose
// gq.ops.json declares `forms`. @getquick/content owns the forms themselves:
// their descriptors, their renderer and the submission handler. The Blueprint
// checks that what the Site chose can work:
//
//   gravity-forms   the CMS has Gravity Forms active with gq-content 0.4.0 or
//                   later: WPGraphQL has gq-content's getquickForms field,
//                   which exists only then (validated, not resolved).
//   form-fields     every form published content references is one the
//                   handler supports (@getquick/content/forms'
//                   formsReadiness): no CAPTCHA, upload, payment, page break,
//                   conditional logic or other unsupported field.
//   spam-controls   a Site that chose Turnstile has both of its keys.
//   cms-access      the optional Access service token for the submissions
//                   path is a whole pair.
//
// `gq site check` runs them against the production CMS through its public
// GraphQL (what the Frontend reads; one language's view on a bilingual
// Site), and `gq doctor` runs `wp gq-forms status` on the local CMS, which
// lists every referenced form in every language. Results never carry a
// secret's value.

import { formsReadiness, parseFormDescriptors } from "@getquick/content/forms";

import { cmsFetch } from "../cms/access.mjs";
import { formSpamControls, wordpressGraphqlUrl } from "../manifest/schema.mjs";

/** The managed route adapter gq sync writes while gq.ops.json declares `forms`. */
export const FORMS_ROUTE = "apps/frontend/src/pages/gq/forms/[...rest].ts";

/** Turnstile's keys, from Sigillo: the secret verifies server-side, the site key renders the widget. */
export const TURNSTILE_SECRET_KEY = "TURNSTILE_SECRET_KEY";
export const TURNSTILE_SITE_KEY = "TURNSTILE_SITE_KEY";
export const TURNSTILE_KEYS = [TURNSTILE_SECRET_KEY, TURNSTILE_SITE_KEY];

/** The optional Access service token for the CMS's submissions path, both or neither. */
export const FORMS_ACCESS_KEYS = ["GQ_FORMS_ACCESS_CLIENT_ID", "GQ_FORMS_ACCESS_CLIENT_SECRET"];
const GRAPHQL_ACCESS_KEYS = ["GQ_AUTH_GRAPHQL_CLIENT_ID", "GQ_AUTH_GRAPHQL_CLIENT_SECRET"];

const TIMEOUT = 30_000;
// At most this many content nodes are read for their forms (100 a page).
const MAX_PAGES = 50;
const RELEASE_CMS = "then release the CMS (pnpm push fix)";

/** Validates gq-content's getquickForms field without resolving anything. */
export const FORMS_SCHEMA_QUERY = /* GraphQL */ `
  query GqFormsSchema {
    nodeByUri(uri: "/") @skip(if: true) {
      ... on ContentNode {
        getquickForms
      }
    }
  }
`;

/** One page of published entries with their forms' public descriptors. */
export const FORMS_QUERY = /* GraphQL */ `
  query GqForms($after: String) {
    contentNodes(first: 100, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        uri
        getquickForms
      }
    }
  }
`;

/**
 * The production readiness of the Site's forms: [] for a Site without
 * `forms`. `env` is Sigillo staging's (gq sigillo run staging), where the
 * Frontend's deploy reads Turnstile's keys.
 */
export async function siteFormsReadiness({ ops, env, fetch }) {
  if (!ops.forms) return [];
  const add = (check) => ({ area: "forms", ...check });
  const graphqlUrl = wordpressGraphqlUrl(ops);
  const cms = cmsFetch({ env, origin: new URL(graphqlUrl).origin, fetch });
  const checks = [];
  const active = await pluginCheck(cms, graphqlUrl);
  checks.push(add(active));
  checks.push(
    add(
      active.status === "ok"
        ? await fieldsCheck(cms, graphqlUrl, ops)
        : skipped("form-fields", "Gravity Forms isn't active on the CMS"),
    ),
  );
  checks.push(add(spamCheck(ops, env)));
  const access = accessCheck(env);
  if (access) checks.push(add(access));
  return checks;
}

async function pluginCheck(fetch, graphqlUrl) {
  const name = "gravity-forms";
  let answer;
  try {
    answer = await postGraphql(fetch, graphqlUrl, FORMS_SCHEMA_QUERY);
  } catch (error) {
    return notReady(name, `the CMS's GraphQL couldn't be read: ${messageOf(error)}`, "retry");
  }
  const errors = answer.errors ?? [];
  if (errors.length === 0) {
    return ok(name, "Gravity Forms is active on the CMS, with gq-content's form descriptors");
  }
  const message = String(errors[0]?.message ?? errors[0]);
  if (!/getquickForms/u.test(message)) {
    return notReady(name, `the CMS's GraphQL refused the check: ${message}`, "retry");
  }
  return notReady(
    name,
    "gq.ops.json declares forms (gravityforms), but the CMS's WPGraphQL has no getquickForms: " +
      "Gravity Forms isn't active there, or its getquick/gq-content is older than 0.4.0",
    `install Gravity Forms in apps/cms and keep gravityforms in gq.ops.json wordpress.plugins (the CMS deploy activates it), ${RELEASE_CMS}; wp gq-forms status on the CMS says whether it is active`,
  );
}

async function fieldsCheck(fetch, graphqlUrl, ops) {
  const name = "form-fields";
  const descriptors = [];
  const referencedBy = new Map();
  let after = null;
  let complete = false;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const answer = await postGraphql(fetch, graphqlUrl, FORMS_QUERY, { after });
      if (answer.errors?.length) {
        throw new Error(String(answer.errors[0]?.message ?? answer.errors[0]));
      }
      const connection = answer.data?.contentNodes;
      for (const node of connection?.nodes ?? []) {
        for (const descriptor of parseFormDescriptors(node?.getquickForms) ?? []) {
          descriptors.push(descriptor);
          const uris = referencedBy.get(descriptor.id) ?? new Set();
          uris.add(node.uri);
          referencedBy.set(descriptor.id, uris);
        }
      }
      if (!connection?.pageInfo?.hasNextPage) {
        complete = true;
        break;
      }
      after = connection.pageInfo.endCursor;
    }
  } catch (error) {
    return notReady(
      name,
      `the forms published content references couldn't be read: ${messageOf(error)}`,
      "retry",
    );
  }
  const statusCommand = "wp gq-forms status on the CMS lists them";
  const readiness = formsReadiness(descriptors, { spam: formSpamControls(ops) });
  const on = (id) => [...(referencedBy.get(id) ?? [])].join(", ");
  const failing = readiness.forms.filter((form) => !form.ok);
  if (failing.length > 0) {
    const problems = failing.map(
      (form) =>
        `form ${form.id} (${form.title}) on ${on(form.id)}: ${[...new Set(form.diagnostics.map(({ code }) => code))].join(", ")}`,
    );
    return notReady(
      name,
      `published content references forms the Frontend can't send: ${problems.join("; ")}`,
      `remove or replace those fields and settings in Gravity Forms (${statusCommand}), or take the form off the page`,
    );
  }
  const partial = complete ? "" : ` (the first ${MAX_PAGES * 100} entries; ${statusCommand} all)`;
  if (readiness.forms.length === 0) {
    return ok(name, `no published content references a form yet${partial}`);
  }
  const listed = readiness.forms.map((form) => `form ${form.id} (${form.title})`).join(", ");
  if (readiness.warnings.length > 0) {
    return warn(
      name,
      `${listed} can be sent${partial}, but ${readiness.warnings.join(" ")}`,
      "enable the anti-spam honeypot in each form's settings, or drop honeypot from gq.ops.json forms.spam",
    );
  }
  return ok(name, `${listed} can be sent${partial}`);
}

/** Whether the Site's spam controls have what they need, by Sigillo's names. */
export function spamCheck(ops, env) {
  const name = "spam-controls";
  const controls = formSpamControls(ops);
  if (!controls.includes("turnstile")) {
    return ok(
      name,
      controls.length > 0
        ? `${controls.join(", ")}: nothing to provision`
        : "none declared: each form's own Gravity Forms settings apply",
    );
  }
  const missing = TURNSTILE_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    return notReady(
      name,
      `gq.ops.json forms.spam chooses Turnstile, but Sigillo staging lacks ${missing.join(" and ")}: the Frontend would refuse every post`,
      "create a Turnstile widget for the Frontend's hostname in Cloudflare, add its keys to Sigillo staging (docs/guides/forms.md), then deploy the Frontend",
    );
  }
  return ok(name, `${controls.join(", ")}: Sigillo has ${TURNSTILE_KEYS.join(" and ")}`);
}

/**
 * The submissions path's Access service token: a partial pair is refused;
 * none, on a CMS whose GraphQL is behind Access, is worth a look. Undefined
 * when neither is set.
 */
export function accessCheck(env) {
  const name = "cms-access";
  const present = FORMS_ACCESS_KEYS.filter((key) => env[key]?.trim());
  if (present.length === FORMS_ACCESS_KEYS.length) {
    return ok(name, `the Frontend sends form posts to the CMS with ${FORMS_ACCESS_KEYS[0]}`);
  }
  if (present.length > 0) {
    return notReady(
      name,
      `${present[0]} is set without ${FORMS_ACCESS_KEYS.find((key) => !present.includes(key))}`,
      "set both or neither (docs/guides/cms-access.md)",
    );
  }
  if (GRAPHQL_ACCESS_KEYS.every((key) => env[key]?.trim())) {
    return warn(
      name,
      `the CMS's GraphQL is behind Cloudflare Access, and Sigillo has no ${FORMS_ACCESS_KEYS.join(" or ")}`,
      "if Access also covers /wp-json/gf/v2/forms/*/submissions, add a service token for that path alone (docs/guides/cms-access.md)",
    );
  }
  return undefined;
}

/**
 * The local CMS's `wp gq-forms status --format=json` as checks, for gq
 * doctor: `{ status, detail, action? }` each. `result` is the command's
 * `{ code, stdout }`.
 */
export function localFormsStatus(result) {
  const json = (result.stdout ?? "")
    .trim()
    .split("\n")
    .findLast((line) => line.trim().startsWith("{"));
  let report;
  try {
    report = JSON.parse(json ?? "");
  } catch {
    return [
      notReady(
        "gq-forms",
        "the local CMS has no wp gq-forms command: its getquick/gq-content is older than 0.4.0",
        "run gq sync, then pnpm cms:composer install",
      ),
    ];
  }
  if (!report.gravityForms?.active) {
    return [
      notReady(
        "gravity-forms",
        "gq.ops.json declares forms (gravityforms), but Gravity Forms isn't active on the local CMS",
        "install it in apps/cms (Composer) and activate it: ddev wp plugin activate gravityforms",
      ),
    ];
  }
  const version = report.gravityForms.version ? ` ${report.gravityForms.version}` : "";
  const checks = [ok("gravity-forms", `Gravity Forms${version} is active`)];
  const forms = Array.isArray(report.forms) ? report.forms : [];
  if (forms.length === 0) checks.push(ok("form-fields", "no published content references a form"));
  for (const form of forms) {
    const codes = [...new Set((form.diagnostics ?? []).map(({ code }) => code))];
    const where = (form.referencedBy ?? []).join(", ");
    checks.push(
      codes.length === 0
        ? ok("form-fields", `form ${form.id} (${form.title}) on ${where} can be sent`)
        : notReady(
            "form-fields",
            `form ${form.id} (${form.title}) on ${where} has ${codes.join(", ")}`,
            "remove or replace those fields and settings in Gravity Forms",
          ),
    );
  }
  return checks;
}

async function postGraphql(fetch, url, query, variables) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(variables ? { query, variables } : { query }),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const answer = await response.json().catch(() => null);
  if (!answer) throw new Error(`HTTP ${response.status} without a GraphQL answer`);
  return answer;
}

// An error's message, without anything a provider echoed past its first line.
function messageOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

function ok(name, detail) {
  return { name, status: "ok", detail };
}

function notReady(name, detail, action) {
  return { name, status: "not-ready", detail, action };
}

function warn(name, detail, action) {
  return { name, status: "warn", detail, action };
}

function skipped(name, detail) {
  return { name, status: "skipped", detail };
}
