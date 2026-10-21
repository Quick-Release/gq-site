import type { DocumentFacts } from "./document-facts";

interface DocumentMetadata {
  html: string;
  attributes: { lang: string; dir: "ltr" | "rtl"; prefix?: string };
  nodes: ({ tag: "title"; text: string } | { tag: "meta" | "link"; attrs: Record<string, string> })[];
  ready: boolean;
  diagnostics: { field: string; message: string }[];
}
/** Metadata Runtime activation waits for a paired release. No unavailable registry import. */
export function documentMetadata(_facts: DocumentFacts): DocumentMetadata | null {
  return null;
}
