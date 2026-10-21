import { contentMetadataText } from "@getquick/content/metadata/content";
import type { DocumentFacts } from "./document-facts";
import { documentMetadata as projectMetadata } from "./document-projection";

/** Source-specific entity decoding stays in the content provider. */
export function documentMetadata(facts: DocumentFacts) {
  return projectMetadata({ ...facts, title: contentMetadataText(facts.title),
    description: facts.description === undefined ? undefined : contentMetadataText(facts.description) });
}
