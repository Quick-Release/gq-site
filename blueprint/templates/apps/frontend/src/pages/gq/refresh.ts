// The trusted refresh: POST with `Authorization: Bearer <FRONTEND_REFRESH_TOKEN>`
// reads published content from the CMS and promotes what it read completely
// into the publication store (src/lib/delivery.ts). `gq frontend refresh`
// calls it. An empty JSON object refreshes the whole Site: each language's
// front page and site chrome, the design presets and every published entry,
// in every language. `{"uris": ["/about/"]}` refreshes only the entries at
// those paths: a new publication, or a changed URI. The answer is a report for
// the operator: 200 when everything was refreshed, 503 when something kept
// its stored version.
import type { APIRoute } from "astro";
import { isAuthorized, refreshAuthority, refreshEntries, refreshSite } from "../../lib/delivery";
import { isLanguageHome, languageSubject, routeLanguage } from "../../lib/site-language";

export const prerender = false;

/** The most entries one targeted refresh reads. */
const MAX_URIS = 100;

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

/** The paths a targeted refresh asks for, none for the whole Site, or why the request is invalid. */
async function requestedPaths(
  request: Request,
): Promise<{ paths?: string[] } | { invalid: string }> {
  const text = await request.text();
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { invalid: "The request body isn't JSON." };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { invalid: "The request body must be a JSON object." };
  }
  const { uris, ...others } = body as Record<string, unknown>;
  if (Object.keys(others).length > 0) {
    return { invalid: `Unknown field: ${Object.keys(others).join(", ")}.` };
  }
  if (uris === undefined) return {};
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_URIS) {
    return { invalid: `uris must list 1 to ${MAX_URIS} paths.` };
  }
  for (const uri of uris) {
    if (typeof uri !== "string" || !/^\/(?!\/)[^?#\s]*$/.test(uri) || uri.length > 2048) {
      return { invalid: `uris must be paths such as /about/, not ${JSON.stringify(uri)}.` };
    }
    if (isLanguageHome(uri)) {
      const subject = languageSubject(routeLanguage(uri), "front page");
      return { invalid: `${uri} is ${subject}: refresh the whole Site for it.` };
    }
  }
  return { paths: uris as string[] };
}

export const POST: APIRoute = async ({ request, site }) => {
  const authority = await refreshAuthority();
  if ("refused" in authority) {
    return answer(403, { error: `Refresh is disabled: ${authority.refused}.` });
  }
  if (!(await isAuthorized(request, authority.token))) {
    return answer(
      401,
      { error: "A refresh needs this Frontend's refresh token as a bearer token." },
      { "WWW-Authenticate": 'Bearer realm="gq-refresh"' },
    );
  }

  const requested = await requestedPaths(request);
  if ("invalid" in requested) return answer(400, { error: requested.invalid });

  const report = requested.paths
    ? await refreshEntries(authority.store, requested.paths)
    : await refreshSite(authority.store, site?.origin);
  return answer(report.refreshed ? 200 : 503, report);
};

export const ALL: APIRoute = () => answer(405, { error: "Refresh with POST." }, { Allow: "POST" });
