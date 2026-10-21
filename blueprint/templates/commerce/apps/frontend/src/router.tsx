import { createRouter } from "@tanstack/react-router";

import { ErrorPage } from "./components/ErrorPage";
import { routeTree } from "./routeTree.gen";

// One router per request on the server, so no request's state reaches another.
export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, defaultErrorComponent: ErrorPage });
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    documentLanguage?: { lang: string; dir: "ltr" | "rtl"; locale?: string };
  }
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
