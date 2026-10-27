import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { startConsent } from "@getquick/content/consent/client";

const readPage = createServerFn({ method: "GET" })
  .validator((path: unknown) => {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
      throw new Error("Expected a Site path");
    return path;
  })
  .handler(async ({ data }) => {
    const { page } = await import("../site.server");
    return page(data);
  });
export const Route = createFileRoute("/$")({
  loader: ({ location }) => readPage({ data: location.pathname }),
  component: Page,
});
function Page() {
  const page = Route.useLoaderData();
  useEffect(() => {
    startConsent();
  }, [page]);
  return (
    <>
      <title>{page.title}</title>
      <style dangerouslySetInnerHTML={{ __html: page.styles }} />
      <div dangerouslySetInnerHTML={{ __html: page.consent.head + page.consent.body }} />
      <header dangerouslySetInnerHTML={{ __html: page.header }} />
      <main>
        <h1>{page.title}</h1>
        <div dangerouslySetInnerHTML={{ __html: page.body }} />
      </main>
      <footer dangerouslySetInnerHTML={{ __html: page.footer + page.consent.footer }} />
    </>
  );
}
