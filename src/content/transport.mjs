// The agent's REST route to a Site's production CMS behind Cloudflare Access
// (gq-platform ADR 0011): WordPress identity is the Site's dedicated agent
// user, by its application password in `Authorization: Basic`; the edge
// identity is either a person's `cloudflared access` session (sent as
// `cf-access-token`) or the agent's own Access service token (the
// `CF-Access-Client-Id` / `CF-Access-Client-Secret` pair). Like cms/access.mjs,
// credentials go only to the configured CMS's exact HTTPS origin and to an
// exact path allowlist, never follow a redirect, and no error shows a value.

export const AGENT_USERNAME = "GQ_CMS_AGENT_USERNAME";
export const AGENT_APPLICATION_PASSWORD = "GQ_CMS_AGENT_APPLICATION_PASSWORD";
export const AGENT_ACCESS_CLIENT_ID = "GQ_CMS_AGENT_ACCESS_CLIENT_ID";
export const AGENT_ACCESS_CLIENT_SECRET = "GQ_CMS_AGENT_ACCESS_CLIENT_SECRET";

// The post types gq content works on, by WordPress name → REST base.
export const CONTENT_TYPES = new Map([
  ["page", "pages"],
  ["post", "posts"],
]);

// A page or post, its revisions, and one revision: nothing else.
const AGENT_PATH =
  /^\/wp-json\/wp\/v2\/(?:pages|posts)\/[1-9][0-9]*(?:\/revisions(?:\/[1-9][0-9]*)?)?$/u;

export function isAgentPath(path) {
  return AGENT_PATH.test(path);
}

/** The CMS origin gq content talks to: gq.ops.json `domains.admin`, over HTTPS. */
export function cmsOrigin(ops) {
  const admin = ops.domains?.admin;
  if (!admin) throw new Error("gq.ops.json domains.admin is required.");
  return `https://${admin}`;
}

/** The agent's Basic authorization from Sigillo, checked without showing a value. */
export function agentAuthorization(env) {
  const username = env[AGENT_USERNAME];
  const password = env[AGENT_APPLICATION_PASSWORD];
  if (!username || !password) {
    throw new Error(
      `${AGENT_USERNAME} and ${AGENT_APPLICATION_PASSWORD} are required: run this through gq sigillo run production -- …`,
    );
  }
  // Never trimmed: an application password's inner spaces are its own.
  if (
    username.includes(":") ||
    /[\r\n]|^\s|\s$/u.test(username) ||
    /[\r\n]|^\s|\s$/u.test(password)
  ) {
    throw new Error(
      `${AGENT_USERNAME} / ${AGENT_APPLICATION_PASSWORD} are malformed (a ':' in the username, a line break or surrounding spaces; values not shown).`,
    );
  }
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

/**
 * The edge credential, by ADR 0011's order: the agent's service-token pair
 * when Sigillo injects it (unattended work), else the token of a person's
 * `cloudflared access login` session for this CMS, else none (a Site without
 * Access). Resolves to { kind, headers }.
 */
export async function edgeCredential({ env, exec, origin }) {
  const id = env[AGENT_ACCESS_CLIENT_ID]?.trim();
  const secret = env[AGENT_ACCESS_CLIENT_SECRET]?.trim();
  if (id || secret) {
    if (!id || !secret) {
      throw new Error(
        `${AGENT_ACCESS_CLIENT_ID} and ${AGENT_ACCESS_CLIENT_SECRET} must be set together.`,
      );
    }
    const headers = { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
    validHeaders(headers, `${AGENT_ACCESS_CLIENT_ID} / ${AGENT_ACCESS_CLIENT_SECRET}`);
    return { kind: "service token", headers };
  }
  // The token is the command's output, never an argument, and isn't shown.
  const result = await exec("cloudflared", ["access", "token", `-app=${origin}`], { env }).catch(
    () => null,
  );
  const token = result?.code === 0 ? result.stdout.trim() : "";
  if (/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(token)) {
    const headers = { "cf-access-token": token };
    validHeaders(headers, "the cloudflared token");
    return { kind: "cloudflared session", headers };
  }
  return { kind: "none", headers: {} };
}

// Validate before fetch: a Headers/fetch error can echo an invalid value.
function validHeaders(headers, label) {
  try {
    new Headers(headers);
  } catch {
    throw new Error(`Invalid ${label} HTTP headers (values not shown).`);
  }
}

/**
 * A fetch for the agent route: `request(method, path, { query, body })`
 * resolves to the parsed JSON body of a 2xx answer and throws, naming only
 * the status and WordPress's error code, on anything else.
 */
export function agentClient({ origin, authorization, edge, fetch, login }) {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/") {
    throw new Error("The agent's CMS credentials require an HTTPS CMS origin without userinfo.");
  }
  return async function request(method, path, { query = {}, body } = {}) {
    if (!isAgentPath(path)) throw new Error(`Refusing to send the agent's credentials to ${path}.`);
    const url = new URL(path, base);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    let response;
    try {
      response = await fetch(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...edge.headers,
          Authorization: authorization,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("The CMS request failed (network or timeout; credentials not shown).");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location") ?? "";
      const host = URL.canParse(location, base) ? new URL(location, base).host : "elsewhere";
      throw new Error(
        `${method} ${path} was redirected to ${host}, not followed with credentials. ` +
          (edge.kind === "none"
            ? `If that is Cloudflare Access, run cloudflared access login ${login ?? origin} or inject ${AGENT_ACCESS_CLIENT_ID} / ${AGENT_ACCESS_CLIENT_SECRET}.`
            : `The ${edge.kind} wasn't admitted; check that the Access policy covers ${path}.`),
      );
    }
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const code = typeof data?.code === "string" ? `: ${data.code}` : "";
      const message = typeof data?.message === "string" ? ` (${data.message})` : "";
      throw Object.assign(
        new Error(`${method} ${path} answered ${response.status}${code}${message}`),
        {
          status: response.status,
        },
      );
    }
    if (data === null)
      throw new Error(`${method} ${path} didn't answer JSON; is ${origin} the CMS?`);
    return data;
  };
}
