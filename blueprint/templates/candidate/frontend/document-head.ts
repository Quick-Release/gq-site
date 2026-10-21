import { resolveMetadata, renderMetadataHead } from "@getquick/content/metadata";
import type { DocumentFacts } from "./document-facts";
import { metadataSite } from "../site-metadata";

/** Declarative package wiring only; validation, fallbacks and escaping belong to the provider. */
export function documentMetadata(facts: DocumentFacts) {
  const metadata = resolveMetadata({
    site: metadataSite,
    state: facts.state,
    kind: facts.kind,
    status: facts.status,
    statusTitle: facts.state === "public" ? undefined : facts.title,
    canonical: `${metadataSite.origin.replace(/\/$/u, "")}${facts.route}`,
    language: facts.language,
    page: {
      title: facts.title,
      ...(facts.description === undefined ? {} : { description: facts.description }),
    },
    translations: facts.translations
      ?.filter((item) => item.translation)
      .map((item) => ({
        ...item.language,
        canonical: `${metadataSite.origin.replace(/\/$/u, "")}${item.route}`,
        published: true,
      })),
  });
  return {
    html: renderMetadataHead(metadata),
    attributes: metadata.htmlAttributes,
    nodes: metadata.head,
    ready: metadata.ready,
    diagnostics: metadata.diagnostics,
  };
}
