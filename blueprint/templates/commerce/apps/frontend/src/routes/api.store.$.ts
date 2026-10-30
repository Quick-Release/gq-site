import { createFileRoute } from "@tanstack/react-router";

import { storefront } from "../storefront.server";

// The catalog, cart and checkout: the storefront Runtime's WooCommerce Store
// API BFF.
const handle = async ({ request }: { request: Request }) =>
  (await storefront()).handleStoreApiRequest(request);

export const Route = createFileRoute("/api/store/$")({
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
