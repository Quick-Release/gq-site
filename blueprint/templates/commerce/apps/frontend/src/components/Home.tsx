import { site } from "../site";

// The storefront's homepage, and the Site's own presentation: nothing here
// comes from the blueprint again. The catalog, cart and sign-in come from
// @quick-release/storefront once it is added (docs/guides in @getquick/site).
export function Home() {
  return (
    <main>
      <h1>{site.name}</h1>
      <p>The shop is being set up.</p>
    </main>
  );
}
