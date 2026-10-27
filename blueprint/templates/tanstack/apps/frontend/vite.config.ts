import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Alchemy Website.Vite adds its Cloudflare plugin at deploy time.
export default defineConfig({
  envPrefix: ["VITE_", "PUBLIC_"],
  plugins: [tanstackStart(), react()],
  build: { rolldownOptions: { external: ["cloudflare:workers"] } },
});
