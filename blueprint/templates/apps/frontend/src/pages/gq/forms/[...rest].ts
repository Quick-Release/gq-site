// Managed by gq sync while gq.ops.json declares `forms` (gq-platform ADR
// 0009): the Site's form endpoint, handled by @getquick/content's
// createFormsServer. POST /gq/forms/<id> validates a visitor's submission
// against the form's descriptor as published with the page it was posted
// from (the content runtime's publishedForm; src/lib/content.ts must pass
// `forms: true`), applies the Site's spam controls (gq.ops.json forms.spam),
// and sends it to Gravity Forms' REST submissions endpoint on the CMS, with no
// credential. Anything else under /gq/forms/ is a 404. The Worker's bindings
// (infra/frontend.run.ts declares them) give TURNSTILE_SECRET_KEY when the
// Site chooses Turnstile, the optional GQ_FORMS_ACCESS_CLIENT_ID and
// GQ_FORMS_ACCESS_CLIENT_SECRET for a CMS behind Cloudflare Access, and
// FORMS_RATE_LIMITER. Rendering the form is the Site's: see
// docs/guides/forms.md in @getquick/site.
import type { APIRoute } from "astro";
import {
  createFormsServer,
  type FormsBindings,
  type FormsServer,
} from "@getquick/content/forms/server";
import ops from "../../../../../../gq.ops.json";
import { content } from "../../../lib/content";

export const prerender = false;

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

export const ALL: APIRoute = async ({ request, site }) => {
  if (!manifest.forms) return new Response(null, { status: 404 });
  forms ??= createFormsServer({
    cmsOrigin,
    descriptor: ({ formId, source }) => content().publishedForm(source, formId, site?.origin),
    spam: { turnstile: manifest.forms.spam?.includes("turnstile") ?? false },
    bindings,
    // The handler's own messages, in the Site's main language (pt_PT → pt-PT).
    language: manifest.wordpress?.locale?.split("_").slice(0, 2).join("-"),
  });
  return (await forms.handle(request)) ?? new Response(null, { status: 404 });
};
