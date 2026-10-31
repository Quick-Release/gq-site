// The fleet's rate-limit namespace register
// (blueprint/rate-limit-namespaces.json) and what gq doctor finds wrong with
// a Site's IDs against it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  rateLimitNamespaceProblems,
  rateLimitRegister,
} from "../../src/cloudflare/rate-limit-register.mjs";

const ACCOUNT = "8f38791a8c37b182239af2a385ab3c31";

const isReserved = (id) =>
  rateLimitRegister.reserved.some(({ from, to }) => id >= from && id <= to);

test("the register holds Ekis's and Bruaa's IDs, each once in its account, none reserved", () => {
  const holders = Object.fromEntries(
    rateLimitRegister.accounts[ACCOUNT].map(({ project, namespaces }) => [project, namespaces]),
  );
  assert.deepEqual(holders.ekis, {
    AUTH_IDENTIFIER_RATE_LIMITER: 1001,
    AUTH_IP_RATE_LIMITER: 1002,
    AUTH_PENALTY_RATE_LIMITER: 1003,
  });
  assert.deepEqual(holders.bruaa, {
    AUTH_IDENTIFIER_RATE_LIMITER: 1007,
    AUTH_IP_RATE_LIMITER: 1008,
    AUTH_PENALTY_RATE_LIMITER: 1009,
  });
  for (const allocations of Object.values(rateLimitRegister.accounts)) {
    const ids = allocations.flatMap(({ namespaces }) => Object.values(namespaces));
    assert.equal(new Set(ids).size, ids.length, "an ID is held twice in one account");
    assert.deepEqual(ids.filter(isReserved), []);
    const projects = allocations.map(({ project }) => project);
    assert.equal(new Set(projects).size, projects.length);
  }
});

test("the docs' example IDs are reserved, so copying one collides with no Site", async () => {
  for (const path of ["guides/commerce-sites.md", "reference/rate-limit-namespaces.md"]) {
    const text = await readFile(new URL(`../../docs/${path}`, import.meta.url), "utf8");
    const examples = [...text.matchAll(/"[A-Z_]+_RATE_LIMITER": (\d+)/gu)].map(([, id]) =>
      Number(id),
    );
    assert.ok(examples.length > 0, path);
    assert.deepEqual(
      examples.filter((id) => !isReserved(id)),
      [],
      path,
    );
  }
});

test("the reference's table is the register", async () => {
  const text = await readFile(
    new URL("../../docs/reference/rate-limit-namespaces.md", import.meta.url),
    "utf8",
  );
  const rows = text
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    )
    .slice(2);
  const expected = [
    ...rateLimitRegister.reserved.map(({ from, to }) => ["any", "reserved", `${from}–${to}`]),
    ...Object.entries(rateLimitRegister.accounts).flatMap(([account, allocations]) =>
      allocations.map(({ project, namespaces }) => {
        const ids = Object.values(namespaces);
        return [`\`${account}\``, project, `${Math.min(...ids)}–${Math.max(...ids)}`];
      }),
    ),
  ];
  assert.deepEqual(rows, expected);
});

const site = (project, namespaces, accountId = ACCOUNT) => ({
  project,
  cloudflare: { accountId, rateLimitNamespaces: namespaces },
});

test("a Site's own registered IDs, or none, are no problem", () => {
  assert.deepEqual(
    rateLimitNamespaceProblems(
      site("bruaa", {
        AUTH_IDENTIFIER_RATE_LIMITER: 1007,
        AUTH_IP_RATE_LIMITER: 1008,
        AUTH_PENALTY_RATE_LIMITER: 1009,
      }),
    ),
    [],
  );
  assert.deepEqual(rateLimitNamespaceProblems({ project: "acme" }), []);
});

test("an ID another Site holds, a reserved one, one bound twice and unregistered ones are named", () => {
  assert.deepEqual(
    rateLimitNamespaceProblems(
      site("fpa-shop", {
        AUTH_IDENTIFIER_RATE_LIMITER: 1001,
        AUTH_IP_RATE_LIMITER: 1004,
        AUTH_PENALTY_RATE_LIMITER: 1010,
        OTHER_RATE_LIMITER: 1010,
      }),
    ),
    [
      `cloudflare.rateLimitNamespaces.AUTH_IDENTIFIER_RATE_LIMITER (1001) is ekis's in Cloudflare account ${ACCOUNT}: the Sites would share its counters`,
      "cloudflare.rateLimitNamespaces.AUTH_IP_RATE_LIMITER (1004) is reserved for documentation and tests (the commerce sites guide's example and the package suite): take unused IDs from the register",
      "cloudflare.rateLimitNamespaces.OTHER_RATE_LIMITER (1010) is also AUTH_PENALTY_RATE_LIMITER's: the two limiters would share counters",
      `rate-limit namespace 1010 isn't in the fleet's register for Cloudflare account ${ACCOUNT}: add fpa-shop's to @getquick/site blueprint/rate-limit-namespaces.json`,
    ],
  );
});

test("another account's IDs don't collide with this one's", () => {
  const problems = rateLimitNamespaceProblems(
    site("other", { AUTH_IP_RATE_LIMITER: 1001 }, "0123456789abcdef0123456789abcdef"),
  );
  assert.deepEqual(problems, [
    "rate-limit namespace 1001 isn't in the fleet's register for Cloudflare account 0123456789abcdef0123456789abcdef: add other's to @getquick/site blueprint/rate-limit-namespaces.json",
  ]);
});
