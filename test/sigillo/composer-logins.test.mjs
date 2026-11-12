// A Site's own Composer logins (gq.ops.json composer.logins): merged into the
// fleet's COMPOSER_AUTH from the environment's secrets, never replacing it.
import assert from "node:assert/strict";
import test from "node:test";

import {
  composerLoginsProblem,
  missingComposerLogins,
  withComposerLogins,
} from "../../src/sigillo/composer-logins.mjs";

const FLEET = {
  "http-basic": {
    "proxy.composer.getquick.io": { username: "fleet", password: "fleet-secret" },
  },
};
const GRAVITY = {
  composer: {
    logins: {
      "composer.gravity.io": {
        usernameSecret: "GRAVITY_FORMS_LICENSE_KEY",
        password: "https://cms.example.test",
      },
    },
  },
};

test("adds a declared login beside the fleet's, from the environment's secret", () => {
  const env = {
    COMPOSER_AUTH: JSON.stringify(FLEET),
    GRAVITY_FORMS_LICENSE_KEY: "license-secret",
    PATH: "/bin",
  };
  const { env: next, missing } = withComposerLogins(env, GRAVITY);
  assert.deepEqual(missing, []);
  assert.deepEqual(JSON.parse(next.COMPOSER_AUTH), {
    "http-basic": {
      "proxy.composer.getquick.io": { username: "fleet", password: "fleet-secret" },
      "composer.gravity.io": { username: "license-secret", password: "https://cms.example.test" },
    },
  });
  assert.equal(next.PATH, "/bin");
  assert.equal(env.COMPOSER_AUTH, JSON.stringify(FLEET), "the input is left as it was");
  assert.deepEqual(missingComposerLogins(GRAVITY, next.COMPOSER_AUTH), []);
  assert.equal(composerLoginsProblem(GRAVITY, next.COMPOSER_AUTH, "x"), null);
});

test("keeps the fleet's other auth types and takes secrets for either part", () => {
  const config = {
    composer: {
      logins: {
        "repo.example.test": { username: "token", passwordSecret: "EXAMPLE_REPO_TOKEN" },
      },
    },
  };
  const auth = { ...FLEET, "github-oauth": { "github.com": "gh-secret" } };
  const { env } = withComposerLogins(
    { COMPOSER_AUTH: JSON.stringify(auth), EXAMPLE_REPO_TOKEN: "repo-secret" },
    config,
  );
  const merged = JSON.parse(env.COMPOSER_AUTH);
  assert.deepEqual(merged["github-oauth"], auth["github-oauth"]);
  assert.deepEqual(merged["http-basic"]["repo.example.test"], {
    username: "token",
    password: "repo-secret",
  });
});

test("a missing secret leaves its host out and is named", () => {
  const env = { COMPOSER_AUTH: JSON.stringify(FLEET), GRAVITY_FORMS_LICENSE_KEY: " " };
  const { env: next, missing } = withComposerLogins(env, GRAVITY);
  assert.deepEqual(missing, ["GRAVITY_FORMS_LICENSE_KEY"]);
  assert.deepEqual(JSON.parse(next.COMPOSER_AUTH), FLEET);
  assert.deepEqual(missingComposerLogins(GRAVITY, next.COMPOSER_AUTH), ["composer.gravity.io"]);
  assert.equal(
    composerLoginsProblem(GRAVITY, next.COMPOSER_AUTH, "the Ploi release"),
    "COMPOSER_AUTH has no login for composer.gravity.io, which gq.ops.json composer.logins " +
      "declares: the Ploi release needs GRAVITY_FORMS_LICENSE_KEY in the Site's Sigillo " +
      "environment it runs under (gq doctor checks each).",
  );
});

test("without the fleet's COMPOSER_AUTH nothing is added, so its own message stands", () => {
  const env = { GRAVITY_FORMS_LICENSE_KEY: "license-secret" };
  assert.deepEqual(withComposerLogins(env, GRAVITY), { env, missing: [] });
  assert.deepEqual(missingComposerLogins(GRAVITY, undefined), []);
  const notJson = { COMPOSER_AUTH: "not json", GRAVITY_FORMS_LICENSE_KEY: "x" };
  assert.deepEqual(withComposerLogins(notJson, GRAVITY), { env: notJson, missing: [] });
  assert.deepEqual(missingComposerLogins(GRAVITY, "not json"), ["composer.gravity.io"]);
});

test("a Site without composer.logins changes nothing", () => {
  const env = { COMPOSER_AUTH: JSON.stringify(FLEET) };
  assert.equal(withComposerLogins(env, {}).env, env);
  assert.equal(composerLoginsProblem({}, env.COMPOSER_AUTH, "x"), null);
});
