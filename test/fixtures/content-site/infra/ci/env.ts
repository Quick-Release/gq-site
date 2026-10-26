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
  // The Frontend's refresh token, publication-event secret and consent read
  // token, when the site has them; the release step passes them to its deploy.
  FRONTEND_REFRESH_TOKEN?: string;
  PUBLICATION_EVENT_SECRET?: string;
  CONSENT_READ_TOKEN?: string;
  // Optional read-only CMS edge identity; never the automation service.
  GQ_AUTH_GRAPHQL_CLIENT_ID?: string;
  GQ_AUTH_GRAPHQL_CLIENT_SECRET?: string;
  // Dedicated trusted Site CMS identity and optional preview gateway identity.
  GQ_PREVIEW_CMS_USERNAME?: string;
  GQ_PREVIEW_CMS_APPLICATION_PASSWORD?: string;
  GQ_PREVIEW_ACCESS_CLIENT_ID?: string;
  GQ_PREVIEW_ACCESS_CLIENT_SECRET?: string;
  // Headless forms: Turnstile's keys when the Site chose it, and the optional
  // Access service token for the CMS's submissions path.
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  GQ_FORMS_ACCESS_CLIENT_ID?: string;
  GQ_FORMS_ACCESS_CLIENT_SECRET?: string;
  MIRROR_WORKFLOW: Workflow<MirrorParams>;
};
