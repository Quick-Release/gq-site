import { publicRouteError } from "../lib/public-route-error";
import { useEffect, type ReactNode } from "react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useMatches,
  useRouter,
} from "@tanstack/react-router";

import "../styles/site.css";
import { ErrorPage } from "../components/ErrorPage";
import { documentMetadata } from "../lib/document-head";
import { htmlDirection, site } from "../site";

export const Route = createRootRoute({
  onError: publicRouteError,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
    ],
    links: [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
  }),
  component: RootComponent,
  notFoundComponent: () => (
    <main id="main-content" tabIndex={-1}>
      <h1>Page not found</h1>
      <p>This page could not be found.</p>
      <a href="/">Back to the front page</a>
    </main>
  ),
  errorComponent: ErrorPage,
});

function RootComponent() {
  const router = useRouter();
  useEffect(
    () =>
      router.subscribe("onResolved", ({ pathChanged }) => {
        if (pathChanged)
          requestAnimationFrame(() =>
            document.getElementById("main-content")?.focus({ preventScroll: true }),
          );
      }),
    [router],
  );
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  const matches = useMatches();
  const documentLanguage = [...matches].reverse().find((match) => match.staticData.documentLanguage)
    ?.staticData.documentLanguage;
  const language = documentLanguage?.lang ?? site.language;
  const failure = matches.find(
    (match) => match.status === "error" || match.status === "notFound" || match._notFound,
  );
  const statusTitle = failure?.status === "error" ? "Temporarily unavailable" : "Page not found";
  const current = matches.at(-1)?.loaderData as
    | { documentMetadata?: ReturnType<typeof documentMetadata> }
    | undefined;
  const metadata = failure
    ? documentMetadata({
        title: statusTitle,
        route: "/",
        state: "error",
        status: failure.status === "error" ? 500 : 404,
        language: {
          lang: language,
          locale: documentLanguage?.locale ?? site.locale,
          dir: documentLanguage?.dir ?? htmlDirection(language),
        },
      })
    : current?.documentMetadata;

  return (
    <html
      lang={language}
      dir={documentLanguage?.dir ?? htmlDirection(language)}
      prefix={metadata?.attributes.prefix}
    >
      <head>
        <HeadContent />
        {/* The provider's ordered repeated tags bypass native name/property deduplication. */}
        {metadata?.nodes.map((node, index) =>
          node.tag === "title" ? (
            <title key={index}>{node.text}</title>
          ) : node.tag === "meta" ? (
            <meta key={index} {...node.attrs} />
          ) : (
            <link key={index} {...node.attrs} />
          ),
        )}
        {!metadata && failure && (
          <>
            <title>{statusTitle}</title>
            <meta name="robots" content="noindex, nofollow" />
          </>
        )}
      </head>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <header className="site-header">
          <a href="/">{site.name}</a>
        </header>
        {children}
        <footer className="site-footer">
          <a href="/">{site.name}</a>
        </footer>
        <Scripts />
      </body>
    </html>
  );
}
