/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_WORDPRESS_GRAPHQL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// workerd's module for the Worker's bindings; src/lib/content.ts types them.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
