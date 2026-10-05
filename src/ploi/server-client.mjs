import { ploiErrorDetail } from "./errors.mjs";

const apiOrigin = "https://ploi.io";

// Minimal Ploi API client scoped to one server, for provisioning and
// releases. Request bodies may carry secrets
// (database passwords, .env contents), so they never go through argv and
// errors never echo them back.
export function createPloiServerClient({ token, serverId, fetch }) {
  if (!token) throw new Error("PLOI_API_TOKEN is missing; run this through gq sigillo run.");
  if (!serverId) throw new Error("gq.ops.json ploi.serverId is required.");

  async function request(method, path, body, { allowNotFound = false } = {}) {
    const response = await fetch(`${apiOrigin}/api/servers/${serverId}${path}`, {
      method,
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (allowNotFound && response.status === 404) return null;
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      const detail = ploiErrorDetail(data);
      throw Object.assign(
        new Error(
          `Ploi ${method} ${path} failed with ${response.status}${detail && `: ${detail}`}`,
        ),
        { status: response.status },
      );
    }
    return data;
  }

  async function list(path) {
    const items = [];
    let next = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    for (let page = 0; next && page < 50; page += 1) {
      const response = await request("GET", next);
      items.push(...(response.data ?? []));
      const url = response.links?.next ?? response.meta?.next_page_url;
      next = url
        ? new URL(url).pathname.replace(`/api/servers/${serverId}`, "") + new URL(url).search
        : null;
    }
    // A listing cut short would look complete.
    if (next) throw new Error(`Ploi GET ${path} has more than 50 pages.`);
    return items;
  }

  return { request, list };
}
