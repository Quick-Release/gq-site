import assert from "node:assert/strict";
import test from "node:test";

import { mentionedRepositories, routingNote } from "../../src/scope/route.mjs";

const names = (text, current = "gq-site") =>
  mentionedRepositories(text, { current }).map((repository) => repository.name);

test("a request naming another repository, by name or a distinctive term, routes to it", () => {
  assert.deepEqual(names("getquick-theme should be renamed to gq-theme"), [
    "gq-theme",
    "getquick-theme",
  ]);
  assert.deepEqual(names("fix CartBearerIsolation's guard"), ["gq-ecommerce"]);
  assert.deepEqual(names("update Quick-Release/gq-platform ADR 0001"), ["gq-platform"]);
  assert.deepEqual(names("the Ekis storefront shows the wrong price"), ["ekis"]);
});

test("the current repository and unrelated words never count", () => {
  assert.deepEqual(names("make gq sync faster in gq-site"), []);
  assert.deepEqual(names("add a test for the manifest migrations"), []);
  assert.deepEqual(names("refactor @getquick/site-config"), []);
  assert.deepEqual(names("update gq-ecommerce-tools", "gq-site"), []);
  assert.deepEqual(names("gq sync breaks in ekis", "ekis"), ["gq-site"]);
});

test("the routing note names each owner, its clone, and the hand-off", () => {
  const note = routingNote(mentionedRepositories("rename getquick-theme", { current: "gq-site" }), {
    current: "gq-site",
    codeRoot: "/data/code/getquick",
  });
  assert.match(note, /this session works in gq-site/u);
  assert.match(
    note,
    /getquick-theme \(Quick-Release\/getquick-theme, \/data\/code\/getquick\/wp-plugins\/getquick-theme\)/u,
  );
  assert.match(note, /change nothing anywhere/u);
  assert.match(note, /start a new session there, in a worktree of it/u);
});
