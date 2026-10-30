import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// The storefront: TanStack Start, built by Vite+ (vp build) and deployed by
// infra/frontend.run.ts. The CMS's .env points WordPress permalinks at
// http://localhost:3000, where vp dev serves it.
export default defineConfig({
  server: { port: 3000, strictPort: true },
  // cloudflare:workers exists only in workerd, where the storefront Runtime
  // reads its bindings (src/storefront.server.ts).
  build: { sourcemap: true, rolldownOptions: { external: ["cloudflare:workers"] } },
  plugins: [tanstackStart({ router: { quoteStyle: "double", semicolons: true } }), react()],
  fmt: {
    ignorePatterns: ["dist/**", ".tanstack/**", ".output/**", "node_modules/**", "src/routeTree.gen.ts"],
    singleQuote: false,
    semi: true,
  },
  lint: {
    ignorePatterns: ["dist/**", ".tanstack/**", ".output/**", "node_modules/**", "src/routeTree.gen.ts"],
  },
});
