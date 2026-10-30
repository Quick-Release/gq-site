import { createStorefrontQueryClient } from "@quick-release/storefront/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

// One router and one Query client per request on the server, so no request's
// state (a customer's cart or session) reaches another. The Query client is
// the storefront Runtime's: its cart and auth queries stay private to the
// browser that asked for them.
export function getRouter() {
  const queryClient = createStorefrontQueryClient();
  return createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
