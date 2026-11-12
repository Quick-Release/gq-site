// Optional Cloudflare Access service token for readiness reads of a Frontend
// kept behind Access (a people policy) before launch. Only the Frontend's own
// pages receive it: never `/gq/*` (its routes authenticate themselves, and
// Access bypasses the path), the CMS, media hosts, third-party hosts or
// provider APIs.
export const FRONTEND_ACCESS_ID = "GQ_FRONTEND_ACCESS_CLIENT_ID";
export const FRONTEND_ACCESS_SECRET = "GQ_FRONTEND_ACCESS_CLIENT_SECRET";

const ACCESS_LOGIN = /(^|\.)cloudflareaccess\.com$/iu;

function frontendAccessPair(env = {}) {
  const id = env[FRONTEND_ACCESS_ID]?.trim();
  const secret = env[FRONTEND_ACCESS_SECRET]?.trim();
  if (!id && !secret) return null;
  if (!id || !secret) {
    throw new Error(`${FRONTEND_ACCESS_ID} and ${FRONTEND_ACCESS_SECRET} must be set together.`);
  }
  return { id, secret };
}

/** The Access headers for `url`: empty unless it is one of the Frontend's own pages. */
export function frontendAccessHeaders({ env, origin, url }) {
  const location = new URL(url);
  if (location.origin !== new URL(origin).origin) return {};
  if (location.pathname === "/gq" || location.pathname.startsWith("/gq/")) return {};
  const pair = frontendAccessPair(env);
  // Over HTTPS without userinfo only: a local `--url http://localhost:…`
  // Frontend is read as before, without the token.
  if (!pair || location.protocol !== "https:" || location.username || location.password) {
    return {};
  }
  const headers = { "CF-Access-Client-Id": pair.id, "CF-Access-Client-Secret": pair.secret };
  // Validate before fetch: a Headers/fetch error can echo an invalid value.
  try {
    new Headers(headers);
  } catch {
    throw new Error(
      `Invalid ${FRONTEND_ACCESS_ID} / ${FRONTEND_ACCESS_SECRET} HTTP headers (values not shown).`,
    );
  }
  return headers;
}

// Wraps fetch for the Frontend's page reads. A request that gets no
// credentials is passed through untouched. One that does never follows a
// redirect (so the token is never forwarded) and never surfaces a raw
// transport error.
export function frontendFetch({ env, origin, fetch }) {
  return async (url, init = {}) => {
    const access = frontendAccessHeaders({ env, origin, url });
    if (Object.keys(access).length === 0) return fetch(url, init);
    try {
      return await fetch(url, {
        ...init,
        headers: { ...init.headers, ...access },
        redirect: "manual",
      });
    } catch {
      throw new Error(
        "The Frontend request failed (network, timeout or redirect; credentials not shown).",
      );
    }
  };
}

/**
 * When `response` (to `url`) is Cloudflare Access's login redirect, or a
 * followed redirect that ended there: what to tell the operator, with the
 * Access host as `detail` and the remedy as `action`. Null otherwise.
 */
export function frontendAccessHint({ env, url, response }) {
  const host = accessLoginHost(url, response);
  if (!host) return null;
  const configured = Boolean(
    env?.[FRONTEND_ACCESS_ID]?.trim() && env?.[FRONTEND_ACCESS_SECRET]?.trim(),
  );
  return configured
    ? {
        detail: `Cloudflare Access (${host}) refused the service token in ${FRONTEND_ACCESS_ID}`,
        action: `admit that service token with a Service Auth policy on the Frontend's Access application, or correct ${FRONTEND_ACCESS_ID} and ${FRONTEND_ACCESS_SECRET} in Sigillo`,
      }
    : {
        detail: `it redirects to Cloudflare Access (${host}), and ${FRONTEND_ACCESS_ID} and ${FRONTEND_ACCESS_SECRET} aren't set`,
        action: `create a service token admitted by a Service Auth policy on the Frontend's Access application, and store it in Sigillo as ${FRONTEND_ACCESS_ID} and ${FRONTEND_ACCESS_SECRET}`,
      };
}

function accessLoginHost(url, response) {
  const candidates = [];
  if (response.status >= 300 && response.status < 400) {
    candidates.push(response.headers.get("location"));
  }
  if (response.redirected) candidates.push(response.url);
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const { hostname } = new URL(candidate, url);
      if (ACCESS_LOGIN.test(hostname)) return hostname;
    } catch {
      // Not a URL: not Access's login.
    }
  }
  return null;
}
