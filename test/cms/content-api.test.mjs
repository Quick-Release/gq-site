// The CMS's content-api.php (created once with the CMS) closes the REST API
// to anonymous callers, apart from Gravity Forms submissions while
// gq-content's forms module has Gravity Forms active (gq-platform ADR 0009):
// the managed /gq/forms/ route posts them to the CMS without a credential.
// This runs the generated mu-plugin itself under PHP, with WordPress's few
// functions it calls stubbed, and asks its rest_authentication_errors filter
// about each request. A real WordPress's routing is proved by
// scripts/smoke/cms-rest-gate.sh.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { temporaryDirectory } from "../support/fixture-site.mjs";
import { newSite } from "../support/generated-site.mjs";

const MU_PLUGIN = "apps/cms/web/app/mu-plugins/content-api.php";

// WordPress as the filter sees it, then each request's answer: "open" for no
// auth error, or the WP_Error's code and status.
const HARNESS = String.raw`<?php
namespace {
    $filters = [];
    function add_action(...$args): void {}
    function add_filter(string $hook, mixed $callback): void { $GLOBALS['filters'][$hook] = $callback; }
    function is_user_logged_in(): bool { return $GLOBALS['loggedIn']; }
    function __(string $text, string $domain): string { return $text; }
    function untrailingslashit(string $value): string { return rtrim($value, '/\\'); }
    class WP_Error {
        public function __construct(public string $code, public string $message, public array $data) {}
    }
    $cases = json_decode(file_get_contents($argv[2]), true);
    if (getenv('FORMS_MODULE') !== false) {
        eval('namespace GetQuick\Content\Forms; function active(): bool { return getenv("FORMS_MODULE") === "active"; }');
    }
    require $argv[1];
    $answers = [];
    foreach ($cases as $case) {
        $_SERVER = ['REQUEST_METHOD' => $case['method']] + ($case['headers'] ?? []);
        $_GET = $case['query'] ?? [];
        $GLOBALS['wp'] = (object) ['query_vars' => ['rest_route' => $case['route']]];
        $GLOBALS['loggedIn'] = $case['loggedIn'] ?? false;
        $result = $GLOBALS['filters']['rest_authentication_errors']($case['previous'] ?? null);
        $answers[] = $result instanceof WP_Error ? [$result->code, $result->data['status']] : ($result ?? 'open');
    }
    echo json_encode($answers);
}
`;

const SUBMISSION = { method: "POST", route: "/gf/v2/forms/1/submissions" };

// Every case's answer from the generated content-api.php, with gq-content's
// forms module absent ("absent"), present with Gravity Forms inactive
// ("inactive") or active ("active").
async function answers(cases, forms) {
  const { root } = await newSite();
  const dir = await temporaryDirectory();
  await writeFile(join(dir, "harness.php"), HARNESS);
  await writeFile(join(dir, "cases.json"), JSON.stringify(cases));
  const env = { ...process.env };
  delete env.FORMS_MODULE;
  if (forms !== "absent") env.FORMS_MODULE = forms;
  const result = spawnSync(
    "php",
    [join(dir, "harness.php"), join(root, MU_PLUGIN), join(dir, "cases.json")],
    { encoding: "utf8", env },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

const CLOSED = ["rest_auth_required", 401];

test("anonymous Gravity Forms submissions pass the REST gate while the forms module is active", async () => {
  const cases = [
    SUBMISSION,
    { ...SUBMISSION, route: "/gf/v2/forms/12/submissions/" },
    // Gravity Forms' own reading and admin routes stay closed.
    { method: "GET", route: "/" },
    { method: "GET", route: "/gf/v2/forms/1" },
    { method: "GET", route: "/gf/v2/forms/1/entries" },
    { method: "POST", route: "/gf/v2/forms/1/entries" },
    { method: "GET", route: "/gf/v2/forms/1/submissions" },
    { method: "PUT", route: "/gf/v2/forms/1/submissions" },
    { method: "POST", route: "/gf/v2/forms/1/submissions/validation" },
    { method: "POST", route: "/gf/v2/forms/0/submissions" },
    { method: "POST", route: "/gf/v2/forms/1x/submissions" },
    { method: "POST", route: "/gf/v2/forms/1/submissions\n" },
    { method: "POST", route: "/wp/v2/users" },
    { method: "POST", route: "/batch/v1" },
    // A method override would make WordPress dispatch something else.
    { ...SUBMISSION, query: { _method: "GET" } },
    { ...SUBMISSION, headers: { HTTP_X_HTTP_METHOD_OVERRIDE: "GET" } },
    // Signed-in users and an earlier auth error are left as they are.
    { method: "GET", route: "/gf/v2/forms/1/entries", loggedIn: true },
    { ...SUBMISSION, previous: "earlier" },
  ];
  assert.deepEqual(await answers(cases, "active"), [
    "open",
    "open",
    ...Array.from({ length: 14 }, () => CLOSED),
    "open",
    "earlier",
  ]);
});

test("without gq-content's forms module, or with Gravity Forms inactive, submissions stay closed", async () => {
  const cases = [SUBMISSION, { method: "GET", route: "/" }];
  assert.deepEqual(await answers(cases, "absent"), [CLOSED, CLOSED]);
  assert.deepEqual(await answers(cases, "inactive"), [CLOSED, CLOSED]);
});
