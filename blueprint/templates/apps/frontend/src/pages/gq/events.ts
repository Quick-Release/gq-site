// Managed by gq sync: the CMS's signed publication, settings, check and
// reconcile events, handled by the Site's content runtime
// (@getquick/content's handleEvent). POST only; other methods are a 405.
import type { APIRoute } from "astro";
import { content } from "../../lib/content";

export const prerender = false;

export const ALL: APIRoute = ({ request, site }) =>
  content().handleEvent(request, { siteOrigin: site?.origin });
