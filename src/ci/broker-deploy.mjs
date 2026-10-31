// Deploys the GETQUICK CI token broker (gq-platform ADR 0012), the Worker
// `gq-ci-broker` whose source ships in this package (broker/).
// It refuses until the GETQUICK CI App exists (gq github app create): it
// reads the App from GQ Platform Sigillo `ops`, proves it against GitHub,
// deploys the Worker from a throwaway directory with the Site's CI Wrangler
// and CI deploy token (the broker runs in the Sites' Cloudflare account), and
// sends its three secrets to `wrangler secret bulk` over stdin. Finally it
// asks the broker's /health whether it is configured.
//
// Run from a Site on GitHub, under its staging environment:
//
//   gq sigillo run staging -- gq ci broker deploy [--dry-run]

import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCloudflareAccountClient } from "../cloudflare/account-client.mjs";
import { createReporter } from "../cli/reporter.mjs";
import { BROKER_WORKER } from "./broker/broker.mjs";
import { ciTarget } from "./deploy.mjs";
import {
  APP_NAME,
  APP_OWNER,
  APP_SECRETS,
  brokerUrl,
  platformSecrets,
  verifyApp,
} from "./github-app.mjs";

// The Worker's entry and the module it imports; Wrangler bundles them.
const WORKER_SOURCES = ["worker.mjs", "broker.mjs"].map((name) => [
  name,
  fileURLToPath(new URL(`./broker/${name}`, import.meta.url)),
]);
export const BROKER_COMPATIBILITY_DATE = "2026-06-16";

export function brokerWranglerConfig() {
  return {
    name: BROKER_WORKER,
    main: "worker.mjs",
    compatibility_date: BROKER_COMPATIBILITY_DATE,
    workers_dev: true,
    vars: { ALLOWED_OWNER: APP_OWNER },
    observability: { enabled: true, logs: { enabled: true } },
  };
}

// `gq ci broker deploy [--dry-run]`. Resolves to an exit code.
export async function runBrokerDeploy({ context, parsed, env, fetch, exec, io, interactive }) {
  const target = ciTarget(context, env);
  const ui = createReporter(io, interactive);
  ui.intro(`${APP_NAME} token broker · ${BROKER_WORKER}`);

  const secrets = await platformSecrets({ context, env, exec });
  const names = await secrets.names();
  const required = [APP_SECRETS.appId, APP_SECRETS.privateKey, APP_SECRETS.brokerKey];
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `The ${APP_NAME} App isn't ready: Sigillo ${secrets.name} lacks ${missing.join(", ")}. ` +
        "An organization owner creates it first: gq github app create.",
    );
  }
  const appId = await secrets.get(APP_SECRETS.appId);
  const privateKey = await secrets.get(APP_SECRETS.privateKey);
  const installationId = names.has(APP_SECRETS.installationId)
    ? await secrets.get(APP_SECRETS.installationId)
    : null;
  const slug = await verifyApp({ fetch, appId, privateKey, installationId });

  const request = createCloudflareAccountClient({
    token: target.env.CLOUDFLARE_API_TOKEN,
    accountId: target.env.CLOUDFLARE_ACCOUNT_ID,
    fetch,
  });
  const { subdomain } = await request("GET", "/workers/subdomain");
  const url = brokerUrl(subdomain);
  ui.note(
    [
      `✓ App ${slug} (${appId}) on ${APP_OWNER}${installationId ? `, installation ${installationId}` : ""}`,
      `+ deploy ${BROKER_WORKER} to ${url}`,
      "+ send GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and BROKER_KEY as Worker secrets",
    ].join("\n"),
    "Plan",
  );
  if (parsed.dryRun) {
    ui.outro("Dry run: nothing changed.");
    return 0;
  }

  // Its own directory, so Wrangler never reads the Site's CI configuration.
  const directory = await mkdtemp(join(tmpdir(), "gq-ci-broker-"));
  try {
    for (const [name, source] of WORKER_SOURCES) await copyFile(source, join(directory, name));
    const config = join(directory, "wrangler.json");
    await writeFile(config, `${JSON.stringify(brokerWranglerConfig(), null, 2)}\n`);
    const wrangler = async (args, options) => {
      const result = await exec(target.wrangler, [...args, "--config", config], {
        cwd: directory,
        env: target.env,
        ...options,
      });
      if (result.code !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(" ")} failed`);
    };
    await wrangler(["deploy"], { stdio: "inherit" });
    await wrangler(["secret", "bulk"], {
      input: JSON.stringify({
        GITHUB_APP_ID: appId,
        GITHUB_APP_PRIVATE_KEY: privateKey,
        BROKER_KEY: await secrets.get(APP_SECRETS.brokerKey),
      }),
      stdout: io.stdout,
      stderr: io.stderr,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const health = await fetch(`${url}/health`).then(
    (response) => (response.ok ? response.json() : null),
    () => null,
  );
  if (health?.configured) ui.success(`${url}/health: configured`);
  else ui.warn(`${url}/health didn't answer configured yet; check it again in a minute.`);
  ui.outro(
    `Deployed ${BROKER_WORKER}. Next, in each Site: gq sigillo run staging -- gq github setup --app`,
  );
  return 0;
}
