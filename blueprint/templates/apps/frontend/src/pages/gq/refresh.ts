// Managed by gq sync: the trusted refresh `gq frontend refresh` calls, with
// the Frontend's FRONTEND_REFRESH_TOKEN as a bearer token, handled by the
// Site's content runtime (@getquick/content's handleRefresh). POST only;
// other methods are a 405.
import type { APIRoute } from "astro";
import { content } from "../../lib/content";

export const prerender = false;

export const ALL: APIRoute = ({ request, site }) =>
  content().handleRefresh(request, { siteOrigin: site?.origin });
