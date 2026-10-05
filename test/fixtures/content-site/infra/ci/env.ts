import type { CiBindings } from "@cloudflare/ci/worker";

import type { MirrorParams } from "./github.ts";

// Secrets set by `pnpm ci:deploy` from Sigillo staging.
export type Bindings = CiBindings & {
  CF_TOKEN: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  PLOI_API_TOKEN: string;
  RELEASES_R2_ACCESS_KEY_ID: string;
  RELEASES_R2_SECRET_ACCESS_KEY: string;
  // GETQUICK Composer registry login: CI's composer install and the Ploi deploy.
  COMPOSER_AUTH: string;
  CLOUDFLARE_DEPLOY_ACCOUNT_ID: string;
  // GitHub (pnpm github:setup): a fine-grained token for GITHUB_REPOSITORY
  // (Contents: read, Commit statuses: read and write) and the webhook secret.
  // An Artifacts-only site has an empty GITHUB_REPOSITORY and neither secret.
  GITHUB_CI_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_REPOSITORY: string;
  ARTIFACTS_NAMESPACE: string;
  ARTIFACTS_REPO: string;
  // The Frontend's refresh token and publication-event secret, when the site
  // has a publication store; the release step passes them to its deploy.
  FRONTEND_REFRESH_TOKEN?: string;
  PUBLICATION_EVENT_SECRET?: string;
  MIRROR_WORKFLOW: Workflow<MirrorParams>;
};
