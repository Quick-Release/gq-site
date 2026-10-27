import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const fromAlchemy = createRequire(import.meta.resolve("alchemy"));
const runtimeRoot = pathToFileURL(
  fromAlchemy.resolve("@alchemy.run/cloudflare-runtime/package.json"),
);
const { default: cloudflare } = await import(
  new URL("dist/vite/node/plugin.mjs", runtimeRoot).href
);
const { createBuilder } =
  await import("../apps/frontend/node_modules/vite/dist/vite/node/index.js");
process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED = "1";
const builder = await createBuilder(
  {
    root: new URL("../apps/frontend", import.meta.url).pathname,
    plugins: [
      cloudflare({
        compatibilityDate: "2026-10-26",
        compatibilityFlags: ["nodejs_compat"],
      }),
    ],
  },
  null,
);
await builder.buildApp();
