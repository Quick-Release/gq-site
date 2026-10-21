import { publicRouteError } from "../lib/public-route-error";
import { createFileRoute } from "@tanstack/react-router";
import { documentMetadata } from "../lib/document-head";
import { htmlDirection, site } from "../site";
import { Home } from "../components/Home";

export const Route = createFileRoute("/")({
  loader: () => ({
    documentMetadata: documentMetadata({
      title: site.name,
      route: "/",
      status: 200,
      state: "public",
      language: { lang: site.language, locale: site.locale, dir: htmlDirection(site.language) },
    }),
  }),
  onError: publicRouteError,
  head: ({ loaderData }) => (loaderData?.documentMetadata ? {} : { meta: [{ title: site.name }] }),
  component: Home,
});
