import { createFileRoute } from "@tanstack/react-router";
import { handleConsent } from "../site.server";

const handle = ({ request }: { request: Request }) => handleConsent(request);
export const Route = createFileRoute("/gq/consent/$")({
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
