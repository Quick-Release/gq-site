// Local, non-deploying framework build. Production still uses infra/frontend.run.ts.
import { build } from "astro";
import { distilledNode } from "@alchemy.run/frontend-frameworks/astro/node";

await build({
  integrations: [distilledNode()],
  vite: { build: { rolldownOptions: { external: ["cloudflare:workers"] } }, ssr: { external: ["cloudflare:workers"] } },
});
