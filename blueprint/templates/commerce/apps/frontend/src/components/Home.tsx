import { site } from "../site";

// The storefront's homepage, and the Site's own presentation: nothing here
// comes from the blueprint again. The catalog, cart and sign-in come from
// the storefront Runtime, behind /api/store and /api/auth (storefront.server.ts).
export function Home() {
  return (
    <main>
      <h1>{site.name}</h1>
      <p>The shop is being set up.</p>
    </main>
  );
}
