import { createFileRoute } from "@tanstack/react-router";
import { content } from "../site.server";

const handle = ({ request }: { request: Request }) =>
  content.handleRefresh(request, { siteOrigin: new URL(request.url).origin });
export const Route = createFileRoute("/gq/refresh")({
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
