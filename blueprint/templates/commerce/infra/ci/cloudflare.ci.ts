import { CIWorkflow } from "@cloudflare/ci";
import type { CiContext, CiParams, CloudflareArtifacts } from "@cloudflare/ci";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { Bindings } from "./env";
import { githubToken, hasGithubCredentials, postCommitStatus } from "./github.ts";
import type { CommitState } from "./github.ts";
import { ciSteps, runSteps } from "./release.ts";
import type { Runner, Step } from "./release.ts";

// Steps restore the install step's workspace snapshot, but pnpm's store lives
// outside it, so `pnpm run`'s dependency check would reinstall everything in
// every step. The install step already did that.
const pnpmEnv = {
  npm_config_verify_deps_before_run: "false",
  pnpm_config_verify_deps_before_run: "false",
};

// Deploys have external side effects: never retry them automatically, and
// give Ploi's deploy (which gq ploi release waits for) enough time.
const deployConfig = { retries: { limit: 0, delay: 1_000 }, timeout: 15 * 60 * 1000 };

// The storefront Runtime's secrets: the Frontend's deploy binds them
// (infra/frontend.run.ts) and refuses to run without a required one.
const frontendSecrets = [
  "GETQUICK_STOREFRONT_PROXY_SECRET",
  "GETQUICK_AUTH_COOKIE_SECRET",
  "GETQUICK_CART_SESSION_SECRET",
  "TURNSTILE_SECRET",
] as const;

// The @quick-release packages (the storefront Runtime and its auth contract)
// come from GitHub Packages, which needs a read:packages token. The install
// step writes it to the container's user-level npm config (~/.npmrc), where
// pnpm reads it, with the shell's printf, so it is in no process's arguments;
// the repository's .npmrc names the registry, never a token. The token is the
// fleet's, from GQ Platform ops (gq-platform ADR 0013), which pnpm ci:deploy
// reads at use. Without it, the install refuses with the fix rather than
// failing on a 401.
const packagesLogin =
  'if [ -z "${GITHUB_PACKAGES_TOKEN:-}" ]; then ' +
  "echo 'GITHUB_PACKAGES_TOKEN is missing: the Frontend installs @quick-release packages from " +
  "GitHub Packages. Run pnpm ci:deploy, which gives this Worker the fleet token from GQ Platform ops.' >&2; " +
  "exit 1; fi && (umask 077 && " +
  "printf '//npm.pkg.github.com/:_authToken=%s\\n' \"$GITHUB_PACKAGES_TOKEN\" >> ~/.npmrc)";

// Cost: containers bill memory for every second they run, and each step
// starts a container and restores the workspace snapshot. So the pipeline is
// at most three steps — install (skipped on a lockfile cache hit), verify
// (every check, sequentially, in one container: ~20 s of work), and on v*
// tags a single release step — on the smallest container that fits
// (wrangler.jsonc). The checks also run locally before every push (pre-push
// hook), so CI failures should be rare.
export class CI extends CIWorkflow<CloudflareArtifacts, Bindings> {
  protected async pipeline(
    event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const params = event.payload;
    const run = event.instanceId.slice(0, 8);

    // Branch pushes of a site on GitHub report a cloudflare-ci commit status
    // to GitHub (PR checks, branch protection). Tags don't: an annotated tag's
    // sha is the tag object, which GitHub can't attach a status to. An
    // Artifacts-only site has no GitHub to report to. Reporting never fails
    // the pipeline.
    // The token comes from the GETQUICK CI broker (or GITHUB_CI_TOKEN), minted
    // inside each status step and never returned from it.
    const repository = this.env.GITHUB_REPOSITORY;
    const report = async (state: CommitState, description: string) => {
      if (params.trigger !== "push" || !repository || !hasGithubCredentials(this.env)) return;
      try {
        await step.do(
          `github status ${state}`,
          { retries: { limit: 3, delay: 5_000, backoff: "exponential" }, timeout: 60_000 },
          async () =>
            postCommitStatus(
              { token: await githubToken(this.env), repository },
              params.sha,
              state,
              `${description} · run ${run}`,
            ),
        );
      } catch (error) {
        console.error("GitHub status failed", { state, error: String(error) });
      }
    };

    await report("pending", "Cloudflare CI is running");
    try {
      await this.checks(params, ci);
    } catch (error) {
      await report("failure", "Cloudflare CI failed");
      throw error;
    }
    await report("success", "Cloudflare CI passed");
  }

  private async checks(params: CiParams<CloudflareArtifacts>, ci: CiContext): Promise<void> {
    const packagesToken = typeof this.env.GITHUB_PACKAGES_TOKEN === "string";
    const install: Step = {
      name: "install",
      command:
        `${packagesLogin} && ` +
        "pnpm install --frozen-lockfile && " +
        "composer install --no-interaction --no-progress --prefer-dist --working-dir=apps/cms",
      // The GETQUICK plugins come from the private Composer registry, the
      // @quick-release packages from GitHub Packages (a step naming a secret
      // the Worker lacks fails, so the token is named only when it is set).
      secrets: ["COMPOSER_AUTH", ...(packagesToken ? ["GITHUB_PACKAGES_TOKEN"] : [])],
      cache: {
        inputs: [
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "apps/cms/composer.json",
          "apps/cms/composer.lock",
        ],
      },
    };

    // The same check list as the pre-push hook and `pnpm push`.
    const verify: Step = {
      name: "verify",
      env: pnpmEnv,
      command: "pnpm verify --ci",
    };

    // Admin first (the storefront reads WooCommerce from it): archive to R2,
    // Ploi deploy verified against the tagged commit; then the frontend.
    const release: Step = {
      name: "release",
      env: pnpmEnv,
      command: `node scripts/ci-release.mjs --ref ${params.sha}`,
      // COMPOSER_AUTH is handed to the Ploi deploy for its composer install;
      // the storefront Runtime's secrets to the Frontend's deploy, when this
      // Worker has them (a step naming a secret the Worker lacks fails; the
      // deploy then names each required one that is missing).
      secrets: [
        "PLOI_API_TOKEN",
        "RELEASES_R2_ACCESS_KEY_ID",
        "RELEASES_R2_SECRET_ACCESS_KEY",
        "COMPOSER_AUTH",
        ...frontendSecrets.filter((name) => typeof this.env[name] === "string"),
      ],
      cloudflareCredentials: { accountId: this.env.CLOUDFLARE_DEPLOY_ACCOUNT_ID },
      // /workspace has no .git: ci-release fetches the tagged commit with these.
      sourceControlCredentials: true,
      config: deployConfig,
    };

    // In ciSteps' order: a release is admitted first, by this Worker's own
    // code, in its own fresh runner, before anything the tag controls is
    // installed, run or given a secret (release.ts).
    await runSteps(ci as unknown as Runner, ciSteps(params, { install, verify, release }));
  }
}
