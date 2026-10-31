// The GETQUICK CI GitHub App and its token broker (gq-platform ADR 0012):
// where they live, what the App may do, and how gq reads them.
//
// The App's ID, slug, installation and private key, and the broker key that
// derives every Site's broker credential, live in the GQ Platform Sigillo
// project's `ops` environment. gq reads them per command, into memory, through
// the site's Sigillo CLI; they never reach a Site's environment, argv or
// output.

import { createPrivateKey } from "node:crypto";

import { sigilloProjectSecrets } from "../sigillo/commands.mjs";
import { appJwt, BROKER_WORKER, samePermissions } from "./broker/broker.mjs";

export const APP_NAME = "GETQUICK CI";
export const APP_OWNER = "Quick-Release";
// What the App may do, as GitHub reports an App's or installation's
// permissions (Metadata read is mandatory).
export const APP_PERMISSIONS = Object.freeze({
  contents: "read",
  statuses: "write",
  metadata: "read",
});

export const PLATFORM_SIGILLO = Object.freeze({
  // GQ Platform.
  projectId: "01M5Z0QYDH1PPN7N3C4A7KZAXJ",
  environment: "ops",
});

// GQ Platform `ops` secret names.
export const APP_SECRETS = Object.freeze({
  appId: "GQ_CI_GITHUB_APP_ID",
  slug: "GQ_CI_GITHUB_APP_SLUG",
  installationId: "GQ_CI_GITHUB_APP_INSTALLATION_ID",
  // PKCS#8, base64 DER: one line, and what WebCrypto imports.
  privateKey: "GQ_CI_GITHUB_APP_PRIVATE_KEY",
  brokerKey: "GQ_CI_BROKER_KEY",
});

// A Site's Sigillo `staging` names, forwarded to its CI Worker.
export const SITE_BROKER_SECRETS = Object.freeze({
  url: "GQ_CI_BROKER_URL",
  token: "GQ_CI_BROKER_TOKEN",
});

export function brokerUrl(subdomain) {
  return `https://${BROKER_WORKER}.${subdomain}.workers.dev`;
}

export async function platformSecrets(dependencies) {
  const secrets = await sigilloProjectSecrets(dependencies, PLATFORM_SIGILLO);
  let names;
  return {
    ...secrets,
    name: `GQ Platform ${PLATFORM_SIGILLO.environment}`,
    // The environment's names, read once (names, never values).
    names: async () => {
      names ??= new Set(
        (await secrets.list())
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean),
      );
      return names;
    },
  };
}

// GitHub's PEM (PKCS#1) as base64 PKCS#8 DER.
export function pkcs8Base64(pem) {
  return createPrivateKey(pem).export({ type: "pkcs8", format: "der" }).toString("base64");
}

export class AppCheckError extends Error {}

async function githubJson(fetch, route, bearer, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${route}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${bearer}`,
      "User-Agent": "gq-github-app",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new AppCheckError(`GitHub ${method} ${route.split("?")[0]} answered ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

// Whether `repository` is among the installation's repositories, asked as the
// App: an installation token (Metadata read only), then every page of
// GET /installation/repositories. The token is revoked afterwards. Needs no
// user login, so it answers the same for an org owner and a repo admin.
export async function installationHasRepository({
  fetch,
  appId,
  privateKey,
  installationId,
  repository,
}) {
  const jwt = await appJwt(appId, privateKey);
  const { token } = await githubJson(
    fetch,
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: "POST", body: { permissions: { metadata: "read" } } },
  );
  const wanted = repository.toLowerCase();
  try {
    for (let page = 1, seen = 0; ; page += 1) {
      const { total_count: total, repositories = [] } = await githubJson(
        fetch,
        `/installation/repositories?per_page=100&page=${page}`,
        token,
      );
      if (repositories.some((entry) => entry.full_name?.toLowerCase() === wanted)) return true;
      seen += repositories.length;
      if (repositories.length === 0 || seen >= total) return false;
    }
  } finally {
    await githubJson(fetch, "/installation/token", token, { method: "DELETE" }).catch(() => {});
  }
}

// The App's installation on Quick-Release, or null before it is installed.
export async function findInstallation({ fetch, appId, privateKey }) {
  const jwt = await appJwt(appId, privateKey);
  const installations = await githubJson(fetch, "/app/installations?per_page=100", jwt);
  const found = installations.find((installation) => installation.account?.login === APP_OWNER);
  return found ? String(found.id) : null;
}

// Proves the stored App is the GETQUICK CI App on Quick-Release with exactly
// its permissions and no events, and that its installation is selected
// repositories only and not suspended. Resolves to the App's slug.
export async function verifyApp({ fetch, appId, privateKey, installationId }) {
  const jwt = await appJwt(appId, privateKey);
  const app = await githubJson(fetch, "/app", jwt);
  if (
    String(app.id) !== String(appId) ||
    app.owner?.login !== APP_OWNER ||
    !samePermissions(app.permissions, APP_PERMISSIONS) ||
    (app.events ?? []).length > 0
  ) {
    throw new AppCheckError(
      `App ${appId} isn't ${APP_NAME} as gq-platform ADR 0012 defines it (owner ${APP_OWNER}; contents read, statuses write, metadata read; no events).`,
    );
  }
  if (installationId) {
    const installation = await githubJson(fetch, `/app/installations/${installationId}`, jwt);
    if (
      installation.account?.login !== APP_OWNER ||
      installation.repository_selection !== "selected" ||
      installation.suspended_at
    ) {
      throw new AppCheckError(
        `Installation ${installationId} must be on ${APP_OWNER}, "Only select repositories", and not suspended.`,
      );
    }
  }
  return app.slug;
}
