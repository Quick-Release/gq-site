// The GQ Platform Sigillo project's `ops` environment: the fleet's shared
// secrets, on the same Sigillo server as every Site's own project. It holds
// the GETQUICK CI App (gq-platform ADR 0012) and the fleet's two registry
// credentials, COMPOSER_AUTH and GITHUB_PACKAGES_TOKEN (gq-platform
// ADR 0013). gq reads them per command, into memory, through the Site's
// Sigillo CLI and the operator's own login; they never reach a Site's Sigillo
// project, argv or output.

import { sigilloProjectSecrets } from "./client.mjs";

export const PLATFORM_SIGILLO = Object.freeze({
  // GQ Platform.
  projectId: "01M5Z0QYDH1PPN7N3C4A7KZAXJ",
  environment: "ops",
});

// For messages: where the shared secrets live.
export const PLATFORM_NAME = `GQ Platform ${PLATFORM_SIGILLO.environment}`;
export const PLATFORM_LOCATION = `${PLATFORM_NAME} (Sigillo project ${PLATFORM_SIGILLO.projectId})`;

export async function platformSecrets(dependencies) {
  const secrets = await sigilloProjectSecrets(dependencies, PLATFORM_SIGILLO);
  let names;
  return {
    ...secrets,
    name: PLATFORM_NAME,
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
