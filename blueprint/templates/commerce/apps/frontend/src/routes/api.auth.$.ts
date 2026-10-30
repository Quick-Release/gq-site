import { createFileRoute } from "@tanstack/react-router";

import { storefront } from "../storefront.server";

// Customer sign-in, registration, recovery and session: the storefront
// Runtime's auth BFF.
const handle = async ({ request }: { request: Request }) =>
  (await storefront()).handleAuthRequest(request);

export const Route = createFileRoute("/api/auth/$")({
  // Every method reaches the Runtime, which answers one it doesn't serve 405
  // rather than the page.
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
