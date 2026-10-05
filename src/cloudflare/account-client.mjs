// Account-scoped Cloudflare API client for the provisioning commands: resolves
// to the response's `result`, and fails with Cloudflare's own error messages.
// The read-only inspection-client.mjs stays beside it; their scopes and
// behavior remain distinct.
const API_ORIGIN = "https://api.cloudflare.com/client/v4";

// One authenticated JSON request under the account (or `base`, such as a
// zone); fails with `label` and Cloudflare's own error messages (or the HTTP
// status). `allowNotFound` resolves a 404 to null.
async function accountRequest(
  { token, accountId, base = `/accounts/${accountId}`, fetch, label },
  method,
  path,
  body,
  { allowNotFound = false } = {},
) {
  const response = await fetch(`${API_ORIGIN}${base}${path}`, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (allowNotFound && response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const detail = data.errors?.map((error) => error.message).join("; ") || response.status;
    throw new Error(`${label} ${method} ${path} failed: ${detail}`);
  }
  return data;
}

// Every page of a listing (`result_info`), 50 at a time, as one array. A
// listing without page totals ends at a page shorter than the page size it
// reports, or, reporting none (it may cap pages below 50), at an empty one;
// one that ignores paging hands out the same page again, which ends it too.
async function listAllPages(options, path, requestOptions) {
  const items = [];
  let previous;
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const data = await accountRequest(
      options,
      "GET",
      `${path}${separator}per_page=50&page=${page}`,
      undefined,
      requestOptions,
    );
    const result = data?.result ?? [];
    const signature = JSON.stringify(result);
    if (page > 1 && result.length > 0 && signature === previous) return items;
    previous = signature;
    items.push(...result);
    const info = data?.result_info ?? {};
    const perPage = Number(info.per_page) || 0;
    const pages =
      Number(info.total_pages) ||
      (info.total_count !== undefined && perPage
        ? Math.ceil(Number(info.total_count) / perPage)
        : 0);
    if (pages ? page >= pages : result.length === 0 || result.length < perPage) return items;
  }
  throw new Error(`Cloudflare GET ${path} has more than 100 pages.`);
}

// Resolves to the response's `result`; with `{ allowNotFound: true }`, a 404
// resolves to null; with `{ paginate: true }`, a GET resolves to every page's.
export function createCloudflareAccountClient({ token, accountId, fetch }) {
  const options = { token, accountId, fetch, label: "Cloudflare" };
  return async (method, path, body, { paginate = false, ...requestOptions } = {}) =>
    paginate
      ? listAllPages(options, path, requestOptions)
      : ((await accountRequest(options, method, path, body, requestOptions))?.result ?? null);
}

// The same, for one zone (its DNS records).
export function createCloudflareZoneClient({ token, zoneId, fetch }) {
  const options = { token, base: `/zones/${zoneId}`, fetch, label: "Cloudflare" };
  return async (method, path, body, requestOptions) =>
    (await accountRequest(options, method, path, body, requestOptions))?.result ?? null;
}

// Cloudflare Artifacts (namespaces, repositories and repo-scoped git tokens).
// Git itself only accepts repo-scoped
// tokens, never Cloudflare API tokens.
export function createArtifactsClient({ accountId, token, fetch }) {
  const options = { token, accountId, fetch, label: "Artifacts" };
  async function request(method, path, body, requestOptions) {
    const data = await accountRequest(options, method, `/artifacts${path}`, body, requestOptions);
    return data === null ? null : (data.result ?? data);
  }

  // The namespace's listing entry, its `jurisdiction` read as "unrestricted"
  // when missing; null when there is none.
  async function findNamespace(namespace) {
    const namespaces = await request("GET", "/namespaces");
    const list = Array.isArray(namespaces) ? namespaces : (namespaces.namespaces ?? []);
    const entry = list.find((item) => (item.namespace ?? item.name) === namespace);
    return entry ? { ...entry, jurisdiction: entry.jurisdiction ?? "unrestricted" } : null;
  }

  return {
    findNamespace,
    // Creates a missing namespace in `jurisdiction` ("eu", "us" or
    // "unrestricted"); an existing one is used as it is.
    async ensureRepository(namespace, name, { jurisdiction, defaultBranch = "main" }) {
      if (!(await findNamespace(namespace))) {
        await request("POST", "/namespaces", {
          namespace,
          ...(jurisdiction === "unrestricted" ? {} : { jurisdiction }),
        });
      }
      const repository = await request("GET", `/namespaces/${namespace}/repos/${name}`, undefined, {
        allowNotFound: true,
      });
      if (repository) return repository;
      return request("POST", `/namespaces/${namespace}/repos`, {
        name,
        default_branch: defaultBranch,
        read_only: false,
      });
    },
    // Short-lived token for one git operation (default: write, 1 hour).
    async createGitToken(namespace, repo, { scope = "write", ttl = 3600 } = {}) {
      const result = await request("POST", `/namespaces/${namespace}/tokens`, { repo, scope, ttl });
      return result.plaintext;
    },
  };
}

// The Artifacts git remote of gq.ops.json `artifacts` in `accountId`.
export function artifactsRemoteUrl({ accountId, namespace, repo }) {
  return `https://${accountId}.artifacts.cloudflare.net/git/${namespace}/${repo}.git`;
}
