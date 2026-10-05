// Larkspur CI Worker. CI pipelines start from the `cf.artifacts.repo.pushed`
// trigger in wrangler.jsonc; this Worker exports the Workflows and the sandbox
// Durable Object, and serves:
//
//   GET  /health          health check
//   POST /github/webhook  GitHub push webhook → mirror Workflow (mirror.ts),
//                         for a site on GitHub only
import { CiSandbox } from "@cloudflare/ci/worker";

import type { Bindings } from "../env";
import { parsePushEvent, verifySignature } from "../github.ts";

export { CiSandbox };
export { CI } from "../cloudflare.ci";
export { Mirror } from "../mirror";

async function githubWebhook(request: Request, env: Bindings): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET ?? "", body, signature))) {
    return new Response("Invalid signature", { status: 401 });
  }
  const event = request.headers.get("X-GitHub-Event");
  if (event === "ping") return Response.json({ ok: true });
  const params = event === "push" ? parsePushEvent(body, env.GITHUB_REPOSITORY) : null;
  if (!params) return Response.json({ ignored: true });

  // The delivery ID makes a redelivery of the same push start no second run.
  const delivery = request.headers.get("X-GitHub-Delivery") ?? crypto.randomUUID();
  try {
    // The instance ID is the delivery ID (the returned instance's fields are
    // RPC properties, not plain values).
    await env.MIRROR_WORKFLOW.create({ id: delivery, params });
    return Response.json({ mirror: delivery }, { status: 202 });
  } catch (error) {
    if (String(error).includes("already exists")) return Response.json({ duplicate: delivery });
    // Logged, and shown in GitHub's delivery view (no secrets in these errors).
    console.error("Mirror dispatch failed", { delivery, error: String(error) });
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ ok: true });
    // An Artifacts-only site has no GitHub repository to mirror.
    if (pathname === "/github/webhook" && request.method === "POST" && env.GITHUB_REPOSITORY) {
      return githubWebhook(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Bindings>;
