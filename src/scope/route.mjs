import { join } from "node:path";

import { ORGANIZATION, REPOSITORIES } from "./repositories.mjs";

// The other repositories a request names, by any of their terms, in the
// order of the ownership map. The current repository never counts.
export function mentionedRepositories(text, { current, repositories = REPOSITORIES }) {
  return repositories.filter(
    (repository) =>
      repository.name !== current &&
      repository.terms.some((term) => mentionsTerm(String(text), term)),
  );
}

// What an agent in `current` is told when a request names other
// repositories: who owns them, and that their work starts a new session
// there instead of happening here.
export function routingNote(mentioned, { current, codeRoot }) {
  const owners = mentioned
    .map(
      (repository) =>
        `- ${repository.name} (${ORGANIZATION}/${repository.name}, ${join(codeRoot, repository.path)}): ${repository.owns}`,
    )
    .join("\n");
  return `Scope check: this session works in ${current}, and the request names repositories that own other work:
${owners}
Read them for evidence if needed. If the request asks to change one of them, change nothing anywhere: name the owning repository and tell the user to start a new session there, in a worktree of it.`;
}

function mentionsTerm(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "iu").test(text);
}
