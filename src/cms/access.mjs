// Optional edge authentication, not WordPress authentication. Keep the two
// service identities separate, scoped to this CMS's exact origin and paths.
export function cmsAccessHeaders({ env, origin, url }) {
  const location = new URL(url);
  if (location.origin !== new URL(origin).origin) return {};
  const path = location.pathname;
  const service = ["/graphql", "/wp/graphql"].includes(path)
    ? "GRAPHQL"
    : ["/", "/wp-login.php", "/wp/wp-login.php"].includes(path) ||
        /^\/wp-json\/wp\/v2\/media(?:\/\d+)?$/u.test(path)
      ? "AUTOMATION"
      : null;
  if (!service) return {};
  const idName = `GQ_AUTH_${service}_CLIENT_ID`;
  const secretName = `GQ_AUTH_${service}_CLIENT_SECRET`;
  const id = env[idName]?.trim();
  const secret = env[secretName]?.trim();
  if (!id && !secret) return {};
  if (!id || !secret) throw new Error(`${idName} and ${secretName} must be set together.`);
  if (location.protocol !== "https:" || location.username || location.password) {
    throw new Error("Cloudflare Access credentials require a CMS HTTPS URL without userinfo.");
  }
  // Validate before fetch: a Headers/fetch error can echo an invalid value.
  try {
    new Headers({ "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret });
  } catch {
    throw new Error(`Invalid ${idName} / ${secretName} HTTP headers (values not shown).`);
  }
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

// Only wrap CMS calls, never provider APIs, media assets or the Frontend.
// Manual redirects preserve readiness's installer diagnosis without forwarding
// credentials. Suppress raw transport errors, including existing Basic auth.
export function cmsFetch({ env, origin, fetch }) {
  return async (url, init = {}) => {
    const access = cmsAccessHeaders({ env, origin, url });
    try {
      return await fetch(url, {
        ...init,
        headers: { ...init.headers, ...access },
        redirect: "manual",
      });
    } catch {
      throw new Error(
        "The CMS request failed (network, timeout or redirect; credentials not shown).",
      );
    }
  };
}
