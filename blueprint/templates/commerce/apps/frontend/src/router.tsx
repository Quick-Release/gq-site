import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

// One router per request on the server, so no request's state reaches another.
export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
