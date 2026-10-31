// Creates the GETQUICK CI GitHub App from a manifest (gq-platform ADR 0012).
// GitHub's manifest flow needs an organization owner's browser, so this
// serves a loopback page that posts the manifest to GitHub, waits for
// GitHub's two redirects back (created, then installed), converts the
// one-time code, checks the App, and stores it in GQ Platform Sigillo `ops`:
//
//   GQ_CI_GITHUB_APP_ID, GQ_CI_GITHUB_APP_SLUG,
//   GQ_CI_GITHUB_APP_PRIVATE_KEY (PKCS#8, base64 DER),
//   GQ_CI_GITHUB_APP_INSTALLATION_ID, and GQ_CI_BROKER_KEY (generated once)
//
// The private key stays in this process until it goes to Sigillo over stdin.
// GitHub's client secret and webhook secret are discarded: the App has no
// webhook and no user authorization. Run from any directory with a
// gq.ops.json `sigillo` block (any Site, or gq-site itself).
//
//   gq github app create [--dry-run]

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { createReporter } from "../cli/reporter.mjs";
import {
  APP_NAME,
  APP_OWNER,
  APP_PERMISSIONS,
  APP_SECRETS,
  findInstallation,
  platformSecrets,
  pkcs8Base64,
  verifyApp,
} from "./github-app.mjs";
import { samePermissions } from "./broker/broker.mjs";

const WAIT_MS = 15 * 60 * 1000;

export function appManifest(origin) {
  return {
    name: APP_NAME,
    url: "https://github.com/Quick-Release/gq-site",
    description:
      "GETQUICK Sites' Cloudflare CI: mirrors pushes and posts the cloudflare-ci commit status. " +
      "Tokens are minted by the GETQUICK CI broker, one repository at a time (gq-platform ADR 0012).",
    public: false,
    redirect_url: `${origin}/created`,
    setup_url: `${origin}/installed`,
    setup_on_update: false,
    request_oauth_on_install: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [],
  };
}

export function newAppUrl(state) {
  return `https://github.com/organizations/${APP_OWNER}/settings/apps/new?state=${state}`;
}

const escapeHtml = (value) => value.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

// The loopback receiver: `/` posts the manifest to GitHub; `/created` and
// `/installed` are GitHub's redirects back. Resolves to { origin, wait(step),
// close() }.
export async function manifestReceiver({ state, timeoutMs = WAIT_MS } = {}) {
  const waiting = new Map();
  const arrived = new Map();
  let origin = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") return response.writeHead(405).end();
    if (url.pathname === "/") {
      return response.end(
        `<!doctype html><title>${APP_NAME}</title><p>Opening GitHub…</p>` +
          `<form id="f" method="post" action="${escapeHtml(newAppUrl(state))}">` +
          `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(appManifest(origin)))}">` +
          `<button>Continue to GitHub</button></form>` +
          `<script>document.getElementById("f").submit()</script>`,
      );
    }
    const step = url.pathname.slice(1);
    if (step !== "created" && step !== "installed") return response.writeHead(404).end();
    if (step === "created" && url.searchParams.get("state") !== state) {
      return response.writeHead(400).end("<p>State mismatch: ignored.</p>");
    }
    if (!arrived.has(step)) {
      arrived.set(step, url.searchParams);
      waiting.get(step)?.(url.searchParams);
    }
    response.end(
      `<!doctype html><title>${APP_NAME}</title><p>${
        step === "created" ? "App created." : "App installed."
      } Return to the terminal.</p>`,
    );
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    close: () => server.close(),
    wait: (step) =>
      new Promise((accept, reject) => {
        if (arrived.has(step)) return accept(arrived.get(step));
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for GitHub (${step}).`)),
          timeoutMs,
        );
        timer.unref?.();
        waiting.set(step, (params) => {
          clearTimeout(timer);
          accept(params);
        });
      }),
  };
}

// The App GitHub created from the one-time code, checked against the
// manifest. Never prints or returns the client or webhook secret.
export async function convertManifestCode(fetch, code) {
  if (!code || !/^[A-Za-z0-9_-]{1,128}$/u.test(code)) {
    throw new Error("GitHub returned no App creation code.");
  }
  const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "gq-github-app",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status !== 201) {
    throw new Error(`GitHub's App manifest conversion answered ${response.status}.`);
  }
  const app = await response.json();
  if (
    app.owner?.login !== APP_OWNER ||
    !samePermissions(app.permissions, APP_PERMISSIONS) ||
    (app.events ?? []).length > 0 ||
    typeof app.pem !== "string" ||
    !/^[a-z0-9-]+$/u.test(app.slug ?? "")
  ) {
    throw new Error(
      `The created App's owner, permissions or events differ from the manifest. Delete it at https://github.com/organizations/${APP_OWNER}/settings/apps/${app.slug ?? ""}/advanced and run this again.`,
    );
  }
  return { id: String(app.id), slug: app.slug, privateKey: pkcs8Base64(app.pem) };
}

// The App exists but its installation wasn't recorded (the run stopped, or
// it was installed later): find it through the App and store it.
async function resumeInstallation({ secrets, names, parsed, fetch, ui }) {
  const appId = await secrets.get(APP_SECRETS.appId);
  const slug = await secrets.get(APP_SECRETS.slug);
  const privateKey = await secrets.get(APP_SECRETS.privateKey);
  const installationId = await findInstallation({ fetch, appId, privateKey });
  if (!installationId) {
    ui.info(
      `App ${slug} exists but isn't installed on ${APP_OWNER}: install it at https://github.com/apps/${slug}/installations/new ("Only select repositories"), then run this again.`,
    );
    ui.outro("Nothing changed.");
    return 1;
  }
  ui.note(`+ store installation ${installationId} in Sigillo ${secrets.name}`, "Plan");
  if (parsed.dryRun) {
    ui.outro("Dry run: nothing changed.");
    return 0;
  }
  await verifyApp({ fetch, appId, privateKey, installationId });
  await secrets.set(APP_SECRETS.installationId, installationId);
  if (!names.has(APP_SECRETS.brokerKey)) {
    await secrets.set(APP_SECRETS.brokerKey, randomBytes(32).toString("hex"));
  }
  ui.success(`Installation ${installationId} stored in Sigillo ${secrets.name}`);
  ui.outro("Next: gq sigillo run staging -- gq ci broker deploy (from a Site).");
  return 0;
}

// `gq github app create [--dry-run]`. Resolves to an exit code.
export async function runAppCreate({ context, parsed, env, fetch, exec, io, interactive }) {
  const ui = createReporter(io, interactive);
  ui.intro(`${APP_NAME} GitHub App · ${APP_OWNER}`);
  const secrets = await platformSecrets({ context, env, exec });
  const names = await secrets.names();
  if (names.has(APP_SECRETS.appId) && !names.has(APP_SECRETS.installationId)) {
    return resumeInstallation({ secrets, names, parsed, fetch, ui });
  }
  if (names.has(APP_SECRETS.appId)) {
    ui.info(
      `${secrets.name} already holds ${APP_SECRETS.appId}: the App exists. ` +
        `To recreate it, delete the App on GitHub and the ${Object.values(APP_SECRETS)
          .filter((name) => name !== APP_SECRETS.brokerKey)
          .join(", ")} secrets first.`,
    );
    ui.outro("Nothing changed.");
    return 0;
  }
  ui.note(
    [
      `+ create the private App "${APP_NAME}" on ${APP_OWNER} (your browser; an organization owner)`,
      "  contents: read · statuses: write · metadata: read · no webhook, no events",
      `+ store its ID, slug and private key in Sigillo ${secrets.name}`,
      "+ install it on Only select repositories (your browser) and store the installation",
      names.has(APP_SECRETS.brokerKey)
        ? `✓ broker key in Sigillo ${secrets.name}`
        : `+ generate the broker key, store it in Sigillo ${secrets.name}`,
    ].join("\n"),
    "Plan",
  );
  if (parsed.dryRun) {
    io.out(JSON.stringify(appManifest("http://127.0.0.1:<port>"), null, 2));
    ui.outro("Dry run: nothing changed.");
    return 0;
  }

  const state = randomBytes(16).toString("hex");
  const receiver = await manifestReceiver({ state });
  try {
    const port = new URL(receiver.origin).port;
    ui.info(
      [
        `1. Open ${receiver.origin}/ in a browser signed in as a ${APP_OWNER} owner.`,
        `   GitHub opens with the App filled in: keep the name "${APP_NAME}" and click "Create GitHub App".`,
        `   A browser on another computer: first run there  ssh -N -L ${port}:127.0.0.1:${port} <this host>`,
      ].join("\n"),
    );
    const created = await convertManifestCode(fetch, (await receiver.wait("created")).get("code"));
    await secrets.set(APP_SECRETS.appId, created.id);
    await secrets.set(APP_SECRETS.slug, created.slug);
    await secrets.set(APP_SECRETS.privateKey, created.privateKey);
    ui.success(`App ${created.slug} (${created.id}) stored in Sigillo ${secrets.name}`);
    if (!names.has(APP_SECRETS.brokerKey)) {
      await secrets.set(APP_SECRETS.brokerKey, randomBytes(32).toString("hex"));
      ui.success(`Broker key stored in Sigillo ${secrets.name}`);
    }

    ui.info(
      [
        `2. Install it: https://github.com/apps/${created.slug}/installations/new`,
        `   Choose ${APP_OWNER}, "Only select repositories", pick one Site's repository, and click "Install".`,
        "   gq github setup --app adds every other Site's repository.",
      ].join("\n"),
    );
    const installationId = (await receiver.wait("installed")).get("installation_id");
    if (!installationId || !/^\d{1,12}$/u.test(installationId)) {
      throw new Error("GitHub returned no installation ID.");
    }
    await verifyApp({ fetch, appId: created.id, privateKey: created.privateKey, installationId });
    await secrets.set(APP_SECRETS.installationId, installationId);
    ui.success(`Installation ${installationId} stored in Sigillo ${secrets.name}`);
  } finally {
    receiver.close();
  }
  ui.outro(
    "Next: deploy the broker from a Site, gq sigillo run staging -- gq ci broker deploy; then gq github setup --app in each Site.",
  );
  return 0;
}
