import { getSandbox } from "@cloudflare/sandbox";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { Bindings } from "./env";
import { githubAuth, mirrorScript } from "./github.ts";
import type { MirrorParams } from "./github.ts";

// GitHub → Artifacts, one ref per GitHub push webhook (src/index.ts). The push
// to Artifacts is what starts the CI Workflow, exactly as a developer's push
// used to. git runs in a sandbox container from the CI image; the repository
// is small, so each run fetches the ref afresh into a throwaway bare repo.
export class Mirror extends WorkflowEntrypoint<Bindings, MirrorParams> {
  async run(event: WorkflowEvent<MirrorParams>, step: WorkflowStep): Promise<void> {
    const { ref } = event.payload;
    // Idempotent (it converges on GitHub's current state), so retries are safe.
    await step.do(
      `mirror ${ref}`,
      { retries: { limit: 3, delay: 10_000, backoff: "exponential" }, timeout: 5 * 60 * 1000 },
      async () => {
        const repo = await this.env.ARTIFACTS.get(this.env.ARTIFACTS_REPO);
        const { plaintext: artifactsToken } = await repo.createToken("write", 600);
        // A container per run, destroyed right after: containers bill while
        // they are up, and a shared one would idle until it sleeps.
        const sandbox = getSandbox(this.env.SANDBOX, `mirror-${crypto.randomUUID()}`, {
          // As @cloudflare/ci's runners: the CI image can take a while to boot.
          transport: "rpc",
          containerTimeouts: { portReadyTimeoutMS: 60_000 },
        });
        try {
          const result = await sandbox.exec(mirrorScript, {
            timeout: 4 * 60 * 1000,
            env: {
              REF: ref,
              GITHUB_REMOTE: `https://github.com/${this.env.GITHUB_REPOSITORY}.git`,
              GITHUB_AUTH: githubAuth(this.env.GITHUB_CI_TOKEN ?? ""),
              // Built like @cloudflare/ci does: repo.remote is an RPC property
              // on the binding, which can't be passed on as a string.
              ARTIFACTS_REMOTE: `https://${this.env.CLOUDFLARE_ACCOUNT_ID}.artifacts.cloudflare.net/git/${this.env.ARTIFACTS_NAMESPACE}/${this.env.ARTIFACTS_REPO}.git`,
              ARTIFACTS_TOKEN: artifactsToken,
            },
          });
          if (result.exitCode !== 0) {
            throw new Error(
              `mirror ${ref} failed (${result.exitCode}): ${result.stderr.slice(-2000)}`,
            );
          }
          return { ref, output: result.stderr.slice(-2000) };
        } finally {
          await repo.revokeToken(artifactsToken).catch(() => false);
          await sandbox.destroy().catch(() => undefined);
        }
      },
    );
  }
}
