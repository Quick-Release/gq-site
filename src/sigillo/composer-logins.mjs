// A Site's own Composer logins (gq.ops.json `composer.logins`): http-basic
// logins for registries only that Site installs from, such as Gravity Forms'
// composer.gravity.io, whose secret parts live in the Site's own Sigillo
// environments. Wherever gq provides COMPOSER_AUTH (`gq sigillo run`, and so
// `gq cms composer`, `gq ploi release` and `gq ci deploy` into the CI
// Worker), it is the fleet's login (registry-credentials.mjs) with the Site's
// logins added beside it, never replacing it: the schema refuses the fleet's
// host. Values are never printed, put in argv or written to disk here.

import { FLEET_COMPOSER_HOST } from "../manifest/schema.mjs";

export { FLEET_COMPOSER_HOST };

// The declared logins, by host: [{ host, username, password }], each part
// { secret } (a Sigillo name) or { value } (a literal from gq.ops.json).
export function composerLogins(config) {
  return Object.entries(config?.composer?.logins ?? {}).map(([host, login]) => ({
    host,
    username: part(login.username, login.usernameSecret),
    password: part(login.password, login.passwordSecret),
  }));
}

function part(value, secret) {
  return secret === undefined ? { value } : { secret };
}

// The command's environment with the Site's logins merged into COMPOSER_AUTH,
// and the Sigillo names it lacked (their hosts are left out). Pure. Without a
// COMPOSER_AUTH (the fleet's login is missing) nothing is added, so the
// command still reports the fleet's login missing; nor when COMPOSER_AUTH
// isn't an object of JSON, which Composer itself then rejects.
export function withComposerLogins(env, config) {
  const logins = composerLogins(config);
  if (logins.length === 0 || !env.COMPOSER_AUTH?.trim()) return { env, missing: [] };
  let auth;
  try {
    auth = JSON.parse(env.COMPOSER_AUTH);
  } catch {
    return { env, missing: [] };
  }
  if (!isObject(auth)) return { env, missing: [] };

  const httpBasic = isObject(auth["http-basic"]) ? { ...auth["http-basic"] } : {};
  const missing = new Set();
  for (const { host, username, password } of logins) {
    const resolved = [username, password].map((side) => {
      if (side.secret === undefined) return side.value;
      const value = env[side.secret]?.trim();
      if (!value) missing.add(side.secret);
      return value;
    });
    if (resolved.every(Boolean)) {
      httpBasic[host] = { username: resolved[0], password: resolved[1] };
    }
  }
  return {
    env: { ...env, COMPOSER_AUTH: JSON.stringify({ ...auth, "http-basic": httpBasic }) },
    missing: [...missing],
  };
}

// The declared hosts COMPOSER_AUTH has no http-basic login for (empty when
// it has all of them, or isn't there at all: the fleet's missing login has
// its own message).
export function missingComposerLogins(config, composerAuth) {
  const hosts = composerLogins(config).map(({ host }) => host);
  if (hosts.length === 0 || !composerAuth?.trim()) return [];
  let httpBasic = {};
  try {
    const auth = JSON.parse(composerAuth);
    if (isObject(auth) && isObject(auth["http-basic"])) httpBasic = auth["http-basic"];
  } catch {
    // Not JSON: every declared login is missing.
  }
  return hosts.filter((host) => !isObject(httpBasic[host]));
}

// The error of a command that needs every declared login, or null.
export function composerLoginsProblem(config, composerAuth, where) {
  const hosts = missingComposerLogins(config, composerAuth);
  if (hosts.length === 0) return null;
  const names = composerLogins(config)
    .filter(({ host }) => hosts.includes(host))
    .flatMap(({ username, password }) => [username.secret, password.secret])
    .filter(Boolean);
  return (
    `COMPOSER_AUTH has no login for ${hosts.join(", ")}, which gq.ops.json composer.logins ` +
    `declares: ${where} needs ${[...new Set(names)].join(" and ")} in the Site's Sigillo ` +
    "environment it runs under (gq doctor checks each)."
  );
}

// A warning (names only) for `gq sigillo run` when a declared login's secret
// isn't in the environment.
export function composerLoginsWarning(missing, config) {
  if (missing.length === 0) return null;
  const hosts = composerLogins(config)
    .filter(({ username, password }) =>
      [username.secret, password.secret].some((name) => name && missing.includes(name)),
    )
    .map(({ host }) => host);
  return (
    `gq: this Sigillo environment has no ${missing.join(" or ")}, which gq.ops.json ` +
    `composer.logins needs for ${hosts.join(", ")}: COMPOSER_AUTH has no login for it, so ` +
    "Composer can't install from it."
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
