import { CIWorkflow } from "@cloudflare/ci";
import type { CiContext, CiParams, CloudflareArtifacts } from "@cloudflare/ci";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { Bindings } from "./env";
import { postCommitStatus } from "./github.ts";
import type { CommitState } from "./github.ts";
import { isRelease } from "./release.ts";

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

// Bound to the Frontend by its deploy (infra/frontend.run.ts) when present.
const frontendSecrets = ["FRONTEND_REFRESH_TOKEN", "PUBLICATION_EVENT_SECRET"] as const;

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
    const { GITHUB_CI_TOKEN: token, GITHUB_REPOSITORY: repository } = this.env;
    const report = async (state: CommitState, description: string) => {
      if (params.trigger !== "push" || !token || !repository) return;
      try {
        await step.do(
          `github status ${state}`,
          { retries: { limit: 3, delay: 5_000, backoff: "exponential" }, timeout: 60_000 },
          () =>
            postCommitStatus(
              { token, repository },
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
    const workspace = await ci.runner({
      name: "install",
      command:
        "pnpm install --frozen-lockfile && " +
        "composer install --no-interaction --no-progress --prefer-dist --working-dir=apps/cms",
      // The GETQUICK plugins come from the private Composer registry.
      secrets: ["COMPOSER_AUTH"],
      cache: {
        inputs: [
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "apps/cms/composer.json",
          "apps/cms/composer.lock",
        ],
      },
    });

    // The same check list as the pre-push hook and `pnpm push`.
    await workspace.runner({
      name: "verify",
      env: pnpmEnv,
      command: "pnpm verify --ci",
    });

    if (!isRelease(params)) return;

    // Admin first (the frontend reads WordPress over GraphQL): archive to R2,
    // Ploi deploy verified against the tagged commit; then the frontend.
    await workspace.runner({
      name: "release",
      env: pnpmEnv,
      command: `node scripts/ci-release.mjs --ref ${params.sha}`,
      // COMPOSER_AUTH is handed to the Ploi deploy for its composer install;
      // the Frontend's own secrets to its deploy, when this Worker has them
      // (a step naming a secret the Worker lacks fails).
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
    });
  }
}
