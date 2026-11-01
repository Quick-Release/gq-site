import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { designHead, type DesignHead } from "../design.server";
import { site } from "../site";

// GQ Design's theme, fonts and text styles, read on the server from the
// CMS's tokens (design.server.ts).
const loadDesignHead = createServerFn({ method: "GET" }).handler(() => designHead());

/** The root route's head: the Site's meta, then GQ Design's font preloads and styles. */
export function rootHead(design: DesignHead | undefined) {
  return {
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: site.name },
    ],
    links: [
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      ...(design?.preloads ?? []),
    ],
    // In order: the theme's Preflight, the fonts, then the text styles that override it.
    styles: design?.styles ?? [],
  };
}

// Every route's loader can reach the storefront's Query client (router.tsx).
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  loader: () => loadDesignHead(),
  // Once per document: a client-side navigation keeps the head it has.
  staleTime: Infinity,
  head: ({ loaderData }) => rootHead(loaderData),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang={site.language}>
      <head>
        <HeadContent />
      </head>
      {/* GQ Design's content root (design.server.ts's DESIGN_ROOT). */}
      <body className="gqd-content">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
