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
  // A commerce Site's read:packages token: the install step writes it to
  // user-level npm config, so pnpm installs the @quick-release packages from
  // GitHub Packages. Set once the Frontend depends on one.
  GITHUB_PACKAGES_TOKEN?: string;
  // The storefront Runtime's secrets (pnpm frontend:secrets; Turnstile's from
  // Cloudflare): the release step passes them to the Frontend's deploy.
  GETQUICK_STOREFRONT_PROXY_SECRET?: string;
  GETQUICK_AUTH_COOKIE_SECRET?: string;
  GETQUICK_CART_SESSION_SECRET?: string;
  TURNSTILE_SECRET?: string;
  MIRROR_WORKFLOW: Workflow<MirrorParams>;
};
