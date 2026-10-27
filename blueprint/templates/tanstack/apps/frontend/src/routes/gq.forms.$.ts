import { createFileRoute } from "@tanstack/react-router";
import {
  createFormsServer,
  type FormsBindings,
  type FormsServer,
} from "@getquick/content/forms/server";
import ops from "../../../../gq.ops.json";
import { content } from "../lib/content";
const manifest = ops as {
  forms?: { spam?: string[] };
  wordpress?: { locale?: string };
};

// The CMS whose GraphQL the Frontend reads: the deploy sets it; local
// development posts to DDEV's, never to production's.
const ddevProject = "{{project}}-admin";
const cmsOrigin = new URL(
  import.meta.env.PUBLIC_WORDPRESS_GRAPHQL_URL?.trim() ||
    `https://${ddevProject}.ddev.site/wp/graphql`,
).origin;

// Outside workerd there are none: Turnstile can't verify, and a Site that
// chose it refuses posts.
const bindings = async () =>
  ((await import("cloudflare:workers").catch(() => null))?.env ?? {}) as FormsBindings;

let forms: FormsServer | undefined;

const handle = async ({ request }: { request: Request }) => {
  const site = new URL(request.url);
  if (!manifest.forms) return new Response(null, { status: 404 });
  forms ??= createFormsServer({
    cmsOrigin,
    descriptor: ({ formId, source }) => content().publishedForm(source, formId, site.origin),
    spam: { turnstile: manifest.forms.spam?.includes("turnstile") ?? false },
    bindings,
    // The handler's own messages, in the Site's main language (pt_PT → pt-PT).
    language: manifest.wordpress?.locale?.split("_").slice(0, 2).join("-"),
  });
  return (await forms.handle(request)) ?? new Response(null, { status: 404 });
};

export const Route = createFileRoute("/gq/forms/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
      OPTIONS: handle,
      HEAD: handle,
    },
  },
});
