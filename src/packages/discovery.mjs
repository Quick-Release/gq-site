// Discovery of a catalogued package's versions, read-only and bounded: what
// its upstream GitHub repository has released (tags, or release assets), and
// what its canonical registry can install (Composer v2 metadata, p2/<name>.json).
// The two are kept apart: an upstream release is not installable until the
// registry serves it, and the registry is never bypassed through GitHub.
//
// Credentials come from the environment gq already uses: GITHUB_TOKEN or
// GH_TOKEN for GitHub, and COMPOSER_AUTH (from `gq sigillo run`) for the
// registry. They go only into request headers, never into results or errors.
// A failure resolves to { status: "error", error: { code, message } } with
// one of DISCOVERY_ERRORS.
import { compareVersions, isStable, newest, parseVersion } from "./versions.mjs";

export const DISCOVERY_ERRORS = [
  "missing-credentials",
  "permission-denied",
  "not-found",
  "malformed",
  "unavailable",
];

const REQUEST_TIMEOUT_MS = 15_000;
const PER_PAGE = 100;
// At most this many pages of tags or releases per package.
const MAX_PAGES = 3;
const GITHUB_API = "https://api.github.com";

class DiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Fetches discovery for one catalogue entry: { upstream, registry }.
export async function discoverPackage(pkg, { composer, env, fetch }) {
  const [upstream, registry] = await Promise.all([
    settle(() => discoverUpstream(pkg, { env, fetch })),
    settle(() => discoverRegistry(pkg, { composer, env, fetch })),
  ]);
  return { upstream, registry };
}

async function settle(work) {
  try {
    return { status: "ok", ...(await work()) };
  } catch (error) {
    if (!(error instanceof DiscoveryError)) throw error;
    return { status: "error", error: { code: error.code, message: error.message } };
  }
}

// Upstream ---------------------------------------------------------------

async function discoverUpstream(pkg, { env, fetch }) {
  const { repository, discovery } = pkg.upstream;
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  const github = (path) => githubJson(path, { fetch, token, repository });
  const releases = [];
  const ignored = [];

  if (discovery === "tags") {
    for (const tag of await paged(github, `/repos/${repository}/tags`)) {
      if (typeof tag?.name !== "string" || typeof tag?.commit?.sha !== "string") {
        throw new DiscoveryError("malformed", `GitHub returned a malformed tag for ${repository}.`);
      }
      const version = parseVersion(tag.name);
      if (!version) ignored.push(tag.name);
      else releases.push({ version, tag: tag.name, provenance: { commit: tag.commit.sha } });
    }
  } else {
    for (const release of await paged(github, `/repos/${repository}/releases`)) {
      if (typeof release?.tag_name !== "string" || !Array.isArray(release.assets)) {
        throw new DiscoveryError(
          "malformed",
          `GitHub returned a malformed release for ${repository}.`,
        );
      }
      const version = parseVersion(release.tag_name);
      if (!version) ignored.push(release.tag_name);
      // Drafts and releases GitHub marks as prereleases never count.
      else if (release.draft || release.prerelease) ignored.push(release.tag_name);
      else {
        const assetName = pkg.upstream.asset.replace("{version}", version.text);
        const asset = release.assets.find((candidate) => candidate?.name === assetName);
        // A release without the asset the registry mirrors isn't installable.
        if (!asset) ignored.push(release.tag_name);
        else {
          releases.push({
            version,
            tag: release.tag_name,
            provenance: {
              asset: asset.name,
              ...(typeof asset.digest === "string" ? { digest: asset.digest } : {}),
            },
          });
        }
      }
    }
  }

  const stable = releases.filter((release) => isStable(release.version));
  const latest = newestRelease(stable);
  let declaredName = null;
  if (latest) {
    // The Composer name the latest release declares, to catch a rename.
    declaredName = await composerNameAt(github, repository, latest.tag);
  }
  return {
    source: `github:${repository}`,
    discovery,
    latest: latest ? describe(latest) : null,
    versions: stable.map((release) => release.version.text).sort(byVersionText),
    prereleases: releases
      .filter((release) => !isStable(release.version))
      .map((release) => release.version.text)
      .sort(byVersionText),
    ignored: ignored.sort(),
    declaredName,
  };
}

async function composerNameAt(github, repository, ref) {
  const path = `/repos/${repository}/contents/composer.json?ref=${encodeURIComponent(ref)}`;
  let file;
  try {
    file = await github(path);
  } catch (error) {
    // A release without a root composer.json declares no name to compare.
    if (error instanceof DiscoveryError && error.code === "not-found") return null;
    throw error;
  }
  if (typeof file?.content !== "string" || file.encoding !== "base64") {
    throw new DiscoveryError(
      "malformed",
      `GitHub returned a malformed composer.json for ${repository}@${ref}.`,
    );
  }
  try {
    const name = JSON.parse(Buffer.from(file.content, "base64").toString("utf8")).name;
    return typeof name === "string" ? name : null;
  } catch {
    throw new DiscoveryError(
      "malformed",
      `${repository}@${ref} has a composer.json that isn't valid JSON.`,
    );
  }
}

async function paged(github, path) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await github(`${path}?per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(batch)) {
      throw new DiscoveryError("malformed", `GitHub returned a malformed list for ${path}.`);
    }
    items.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return items;
}

async function githubJson(path, { fetch, token, repository }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const response = await bounded(fetch, `${GITHUB_API}${path}`, headers, `GitHub (${repository})`);
  if (response.status === 401) {
    throw new DiscoveryError(
      token ? "permission-denied" : "missing-credentials",
      token
        ? `GitHub rejected the token for ${repository}.`
        : `GitHub needs a token for ${repository}: set GITHUB_TOKEN or GH_TOKEN.`,
    );
  }
  if (response.status === 403 || response.status === 429) {
    if (response.headers.get("x-ratelimit-remaining") === "0" || response.status === 429) {
      throw new DiscoveryError("unavailable", `GitHub's rate limit is exhausted (${repository}).`);
    }
    throw new DiscoveryError("permission-denied", `The GitHub token can't read ${repository}.`);
  }
  if (response.status === 404) {
    // GitHub answers 404 for a private repository it won't show.
    throw new DiscoveryError(
      token ? "not-found" : "missing-credentials",
      token
        ? `GitHub has no ${path.split("?")[0]} for ${repository}, or the token can't read it.`
        : `${repository} isn't visible without a token: set GITHUB_TOKEN or GH_TOKEN.`,
    );
  }
  return parseBody(response, `GitHub (${repository})`);
}

// Registry ---------------------------------------------------------------

async function discoverRegistry(pkg, { composer, env, fetch }) {
  const repository = (composer.repositories ?? []).find(
    (candidate) => candidate.name === pkg.install.registry,
  );
  const base = String(repository.url).replace(/\/+$/u, "");
  const host = new URL(base).host;
  const headers = { Accept: "application/json", ...registryAuthorization(env, host) };
  const url = `${base}/p2/${pkg.name}.json`;
  const response = await bounded(fetch, url, headers, `the ${pkg.install.registry} registry`);
  if (response.status === 401) {
    throw new DiscoveryError(
      "permission-denied",
      `The ${pkg.install.registry} registry rejected the COMPOSER_AUTH login for ${host}.`,
    );
  }
  if (response.status === 403) {
    throw new DiscoveryError(
      "permission-denied",
      `The ${pkg.install.registry} registry refused ${pkg.name} to this login.`,
    );
  }
  if (response.status === 404) {
    throw new DiscoveryError(
      "not-found",
      `The ${pkg.install.registry} registry doesn't serve ${pkg.name}.`,
    );
  }
  const metadata = await parseBody(response, `the ${pkg.install.registry} registry`);
  const entries = metadata?.packages?.[pkg.name];
  if (!Array.isArray(entries)) {
    throw new DiscoveryError(
      "malformed",
      `The ${pkg.install.registry} registry's metadata for ${pkg.name} has no version list.`,
    );
  }
  const expanded = metadata.minified === "composer/2.0" ? expandMinified(entries) : entries;
  const releases = [];
  const ignored = [];
  const names = new Set();
  for (const item of expanded) {
    if (typeof item?.version !== "string") {
      throw new DiscoveryError(
        "malformed",
        `The ${pkg.install.registry} registry listed a ${pkg.name} version without a version string.`,
      );
    }
    if (typeof item.name === "string") names.add(item.name);
    const version = parseVersion(item.version);
    if (!version) {
      ignored.push(item.version);
      continue;
    }
    releases.push({
      version,
      tag: item.version,
      provenance: {
        reference: item.dist?.reference ?? item.source?.reference ?? null,
        ...(item.dist?.shasum ? { shasum: item.dist.shasum } : {}),
      },
      php: typeof item.require?.php === "string" ? item.require.php : null,
    });
  }
  const stable = releases.filter((release) => isStable(release.version));
  const latest = newestRelease(stable);
  return {
    source: `composer:${pkg.install.registry}`,
    url: base,
    latest: latest ? { ...describe(latest), php: latest.php } : null,
    versions: stable.map((release) => release.version.text).sort(byVersionText),
    prereleases: releases
      .filter((release) => !isStable(release.version))
      .map((release) => release.version.text)
      .sort(byVersionText),
    ignored: ignored.sort(),
    // Every stable version, newest last, with its provenance and PHP floor.
    releases: stable
      .sort((left, right) => compareVersions(left.version, right.version))
      .map((release) => ({ ...describe(release), php: release.php })),
    declaredNames: [...names].sort(),
  };
}

// Basic auth for `host` from COMPOSER_AUTH's http-basic, as Composer reads it.
function registryAuthorization(env, host) {
  if (!env.COMPOSER_AUTH) {
    throw new DiscoveryError(
      "missing-credentials",
      `COMPOSER_AUTH is missing: run this through gq sigillo run, which holds the registry login for ${host}.`,
    );
  }
  let auth;
  try {
    auth = JSON.parse(env.COMPOSER_AUTH);
  } catch {
    throw new DiscoveryError("missing-credentials", "COMPOSER_AUTH isn't valid JSON.");
  }
  const login = auth?.["http-basic"]?.[host];
  if (typeof login?.username !== "string" || typeof login?.password !== "string") {
    throw new DiscoveryError(
      "missing-credentials",
      `COMPOSER_AUTH has no http-basic login for ${host}.`,
    );
  }
  const encoded = Buffer.from(`${login.username}:${login.password}`).toString("base64");
  return { Authorization: `Basic ${encoded}` };
}

// Composer 2 "minified" metadata repeats only the keys that change between
// consecutive versions; "__unset" removes one.
export function expandMinified(entries) {
  let previous = {};
  return entries.map((entry) => {
    const next = { ...previous };
    for (const [key, value] of Object.entries(entry ?? {})) {
      if (value === "__unset") delete next[key];
      else next[key] = value;
    }
    previous = next;
    return next;
  });
}

// Shared -----------------------------------------------------------------

async function bounded(fetch, url, headers, label) {
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? "timed out" : "couldn't be reached";
    throw new DiscoveryError("unavailable", `${label} ${reason}.`);
  }
  if (response.status >= 500) {
    throw new DiscoveryError("unavailable", `${label} answered HTTP ${response.status}.`);
  }
  if (!response.ok && ![401, 403, 404, 429].includes(response.status)) {
    throw new DiscoveryError("unavailable", `${label} answered HTTP ${response.status}.`);
  }
  return response;
}

async function parseBody(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new DiscoveryError("malformed", `${label} returned a response that isn't valid JSON.`);
  }
}

function newestRelease(releases) {
  const best = newest(releases.map((release) => release.version));
  return best ? releases.find((release) => release.version === best) : null;
}

function describe(release) {
  return { version: release.version.text, tag: release.tag, ...release.provenance };
}

function byVersionText(left, right) {
  return compareVersions(parseVersion(left), parseVersion(right));
}
