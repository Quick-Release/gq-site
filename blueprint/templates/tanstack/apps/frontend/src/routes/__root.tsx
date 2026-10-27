import { useMatches, HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: Root,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
  }),
});
function Root() {
  const page = useMatches().at(-1)?.loaderData;
  const language = page && "language" in page && typeof page.language === "string"
    ? page.language : "{{wordpress.locale}}".replaceAll("_", "-") || "en";
  return (
    <html lang={language}>
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
