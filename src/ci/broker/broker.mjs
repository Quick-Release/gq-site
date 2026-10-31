// The GETQUICK CI token broker (gq-platform ADR 0012): the only runtime that
// holds the GETQUICK CI GitHub App's private key. A Site's CI Worker sends
// its broker credential and its repository; the broker mints an installation
// token narrowed to that one repository with exactly the permissions CI uses
// (Contents read for the mirror, Commit statuses write for cloudflare-ci).
//
//   GET  /health  { ok, configured }
//   POST /token   Authorization: Bearer <credential>
//                 { "repository": "Quick-Release/<repo>" }
//               → { token, expires_at }
//
// A credential is HMAC-SHA256(BROKER_KEY, "gq-ci-broker/v1\n" + repository),
// so the broker keeps no table: it recomputes and compares. Deployed by
// `gq ci broker deploy`, with GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (PKCS#8,
// base64 DER) and BROKER_KEY as secrets and ALLOWED_OWNER as a variable.
// Plain Web APIs only, so Node imports it for gq and its tests; worker.mjs is
// the Worker's entry (a Worker module may export only handlers).

export const BROKER_WORKER = "gq-ci-broker";
export const CREDENTIAL_VERSION = "v1";
const CREDENTIAL_PREFIX = `gqci${CREDENTIAL_VERSION.slice(1)}_`;

// Requested for every token; GitHub adds Metadata read to any grant.
export const TOKEN_PERMISSIONS = Object.freeze({ contents: "read", statuses: "write" });
const GRANTED_PERMISSIONS = Object.freeze({ ...TOKEN_PERMISSIONS, metadata: "read" });

const API = "https://api.github.com";
const encoder = new TextEncoder();
const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u;

export function isRepository(value) {
  return typeof value === "string" && REPOSITORY.test(value);
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

// The Site's broker credential for `repository` (owner/name). `gq github
// setup --app` derives it with the same key the broker holds.
export async function brokerCredential(key, repository) {
  if (!key) throw new Error("The broker key is empty.");
  if (!isRepository(repository)) throw new Error(`Not a repository: ${repository}`);
  const hmac = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = `gq-ci-broker/${CREDENTIAL_VERSION}\n${repository.toLowerCase()}`;
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode(message)));
  return `${CREDENTIAL_PREFIX}${base64url(digest)}`;
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function base64Bytes(value) {
  const binary = atob(value.replace(/\s+/gu, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

// An RS256 App JWT. GitHub caps the lifetime at ten minutes; iat is back-dated
// a minute for clock drift.
export async function appJwt(appId, privateKey, now = Date.now()) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    base64Bytes(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const seconds = Math.floor(now / 1000);
  const segment = (value) => base64url(encoder.encode(JSON.stringify(value)));
  const unsigned = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({
    iat: seconds - 60,
    exp: seconds + 540,
    iss: String(appId),
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

// Exactly these permissions: none missing, none added.
export function samePermissions(actual, expected = GRANTED_PERMISSIONS) {
  const entries = Object.entries(actual ?? {});
  return (
    entries.length === Object.keys(expected).length &&
    entries.every(([name, level]) => expected[name] === level)
  );
}

class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function github(fetchImplementation, method, route, jwt, body) {
  const response = await fetchImplementation(`${API}${route}`, {
    method,
    // Workers refuse "error"; a redirect is not ok, so it is refused below.
    redirect: "manual",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": BROKER_WORKER,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 404 && route.endsWith("/installation")) {
    throw new Refusal(403, "The GETQUICK CI App isn't installed on this repository.");
  }
  if (!response.ok) {
    // The route's last segment names the call (installation, access_tokens).
    throw new Refusal(
      502,
      `GitHub ${method} …/${route.split("/").at(-1)} answered ${response.status}`,
    );
  }
  return response.json();
}

// Mints the one-repository token for `repository`, refusing a grant GitHub
// widened or narrowed.
export async function mintRepositoryToken(env, repository, fetchImplementation = fetch) {
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const installation = await github(
    fetchImplementation,
    "GET",
    `/repos/${repository}/installation`,
    jwt,
  );
  const [, name] = repository.split("/");
  const granted = await github(
    fetchImplementation,
    "POST",
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    { repositories: [name], permissions: TOKEN_PERMISSIONS },
  );
  const repositories = (granted.repositories ?? []).map((entry) => entry.full_name?.toLowerCase());
  if (
    typeof granted.token !== "string" ||
    !samePermissions(granted.permissions) ||
    repositories.length !== 1 ||
    repositories[0] !== repository.toLowerCase()
  ) {
    throw new Refusal(502, "GitHub granted a different scope than requested.");
  }
  return { token: granted.token, expires_at: granted.expires_at };
}

function reply(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleToken(request, env, fetchImplementation = fetch) {
  const header = request.headers.get("Authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  let repository;
  try {
    ({ repository } = await request.json());
  } catch {
    return reply({ error: "Expected a JSON body with repository." }, 400);
  }
  if (!isRepository(repository)) return reply({ error: "Expected repository: owner/name." }, 400);
  const owner = repository.split("/")[0].toLowerCase();
  if (owner !== String(env.ALLOWED_OWNER ?? "").toLowerCase()) {
    return reply({ error: "Not a repository this broker serves." }, 403);
  }
  // Compared before anything reaches GitHub; the reason is never told apart.
  if (!constantTimeEqual(presented, await brokerCredential(env.BROKER_KEY, repository))) {
    return reply({ error: "Unauthorized." }, 401);
  }
  try {
    return reply(await mintRepositoryToken(env, repository, fetchImplementation));
  } catch (error) {
    const status = error instanceof Refusal ? error.status : 502;
    // Fixed text, routes and statuses only: never a token or a key.
    console.error("token refused", { repository, status, error: String(error.message) });
    return reply({ error: error instanceof Refusal ? error.message : "Minting failed." }, status);
  }
}

export function configured(env) {
  return Boolean(
    env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.BROKER_KEY && env.ALLOWED_OWNER,
  );
}

// The Worker's fetch handler (worker.mjs exports it as the default handler).
export async function handleRequest(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname === "/health" && request.method === "GET") {
    return reply({ ok: true, configured: configured(env) });
  }
  if (pathname === "/token" && request.method === "POST") {
    if (!configured(env)) return reply({ error: "The broker isn't configured." }, 503);
    return handleToken(request, env);
  }
  return reply({ error: "Not found." }, 404);
}
