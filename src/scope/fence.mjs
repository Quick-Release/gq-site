import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { ORGANIZATION, REPOSITORIES } from "./repositories.mjs";

// A fence against an agent writing outside the repository it works in. It
// reads a tool call the way a careful reviewer would, not as a sandbox: edits
// and file writes by path, and shell commands by the git, gh and file
// commands they run and the directories they `cd` into.
//
// Resolves to null when the call stays inside, or to the reason it doesn't.
export function fenceToolCall(
  { toolName, toolInput = {} },
  { root, repository, allowed = [], codeRoot, workspacesRoot, repositories = REPOSITORIES },
) {
  const place = { root, repository, allowed, codeRoot, workspacesRoot, repositories };
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName)) {
    const target = toolInput.file_path ?? toolInput.notebook_path;
    if (typeof target !== "string") return null;
    return outsideReason(resolve(root, target), place);
  }
  if (toolName === "Bash" && typeof toolInput.command === "string") {
    return fenceCommand(toolInput.command, place);
  }
  return null;
}

const GIT_WRITES = new Set([
  "add",
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "init",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
  "worktree",
]);

const GH_WRITES = {
  issue: [
    "create",
    "edit",
    "comment",
    "close",
    "reopen",
    "transfer",
    "delete",
    "lock",
    "pin",
    "develop",
  ],
  pr: ["create", "edit", "comment", "close", "reopen", "merge", "review", "ready"],
  label: ["create", "edit", "delete", "clone"],
  release: ["create", "edit", "delete", "upload"],
  repo: ["create", "edit", "delete", "fork", "rename", "archive"],
  workflow: ["run", "enable", "disable"],
};

// File commands and which of their path arguments they write: all of them, or
// only the last (the destination).
const FILE_WRITES = {
  rm: "all",
  rmdir: "all",
  mkdir: "all",
  touch: "all",
  tee: "all",
  chmod: "all",
  cp: "last",
  mv: "last",
  ln: "last",
  rsync: "last",
  install: "last",
};

function fenceCommand(command, place) {
  let directory = place.root;
  for (const words of segments(command)) {
    const [name, ...args] = words;
    if (name === undefined) continue;
    if (name === "cd") {
      directory = resolve(directory, expandHome(args[0] ?? homedir()));
      continue;
    }
    const reason =
      redirectReason(words, directory, place) ??
      (name === "git" ? gitReason(args, directory, place) : null) ??
      (name === "gh" ? ghReason(args, directory, place) : null) ??
      (name === "sed" ? sedReason(args, directory, place) : null) ??
      fileReason(name, args, directory, place);
    if (reason) return reason;
  }
  return null;
}

function redirectReason(words, directory, place) {
  for (let index = 0; index < words.length - 1; index += 1) {
    if (/^(?:\d|&)?>>?$/u.test(words[index])) {
      const target = words[index + 1];
      if (target === "/dev/null" || target.startsWith("&")) continue;
      const reason = outsideReason(resolve(directory, expandHome(target)), place);
      if (reason) return reason;
    }
  }
  return null;
}

function gitReason(args, directory, place) {
  let gitDirectory = directory;
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    if (args[index] === "-C") {
      gitDirectory = resolve(gitDirectory, expandHome(args[index + 1] ?? "."));
      index += 2;
    } else if (args[index] === "-c") {
      index += 2;
    } else {
      index += 1;
    }
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  const writes =
    GIT_WRITES.has(subcommand) ||
    (subcommand === "branch" &&
      rest.some(
        (arg) => /^-[dDmMcCf]$|^--(?:delete|move|copy|force)$/u.test(arg) || !arg.startsWith("-"),
      ));
  return writes ? outsideReason(gitDirectory, place) : null;
}

function ghReason(args, directory, place) {
  const repositoryFlag = flagValue(args, ["-R", "--repo"]);
  if (args[0] === "api") return ghApiReason(args.slice(1), place);
  const [group, action] = args;
  if (!GH_WRITES[group]?.includes(action)) return null;
  if (group === "issue" && action === "transfer") {
    return `\`gh issue transfer\` moves an issue into another repository. ${handOff(place)}`;
  }
  if (group === "repo" && action === "create") {
    return `\`gh repo create\` starts a new repository. ${handOff(place)}`;
  }
  if (repositoryFlag) return repositoryReason(repositoryFlag, place);
  return outsideReason(directory, place);
}

function ghApiReason(args, place) {
  const method = (flagValue(args, ["-X", "--method"]) ?? "").toUpperCase();
  const hasFields = args.some((arg) => /^(?:-f|-F|--field|--raw-field|--input)$/u.test(arg));
  const writes = ["POST", "PATCH", "PUT", "DELETE"].includes(method) || (!method && hasFields);
  if (!writes) return null;
  const endpoint = args.find((arg) => /^\/?repos\/[^/]+\/[^/]+/u.test(arg));
  if (!endpoint) return null;
  const [, owner, name] = endpoint.replace(/^\//u, "").split("/");
  return repositoryReason(`${owner}/${name}`, place);
}

function sedReason(args, directory, place) {
  if (!args.some((arg) => /^-[a-zA-Z]*i/u.test(arg) || arg.startsWith("--in-place"))) return null;
  return pathsReason(args.filter((arg) => !arg.startsWith("-")).slice(1), directory, place);
}

function fileReason(name, args, directory, place) {
  const which = FILE_WRITES[name];
  if (!which) return null;
  const paths = args.filter((arg) => !arg.startsWith("-"));
  return pathsReason(which === "last" ? paths.slice(-1) : paths, directory, place);
}

function pathsReason(paths, directory, place) {
  for (const path of paths) {
    const reason = outsideReason(resolve(directory, expandHome(path)), place);
    if (reason) return reason;
  }
  return null;
}

function repositoryReason(slug, place) {
  const [owner, name] = slug.split("/");
  if (owner === ORGANIZATION && name === place.repository) return null;
  const owned = place.repositories.find((repository) => repository.name === name);
  return `This command changes ${slug}, and this session works in ${ORGANIZATION}/${place.repository}. ${handOff({ ...place, owner: owned })}`;
}

function outsideReason(path, place) {
  if (within(path, place.root) || place.allowed.some((directory) => within(path, directory))) {
    return null;
  }
  const owner = ownerOf(path, place);
  // Another checkout of the same repository (its main clone, a sibling
  // worktree) is still this repository's work.
  if (owner?.name === place.repository) return null;
  return `${path} is outside this repository (${place.root}). ${handOff({ ...place, owner })}`;
}

function handOff({ owner, codeRoot }) {
  const where = owner
    ? `It belongs to ${ORGANIZATION}/${owner.name} (${join(codeRoot, owner.path)}). `
    : "";
  return `${where}Change nothing there from this session: name the owning repository and tell the user to start a new session in a worktree of it. To orchestrate across repositories on purpose, the user runs the session with GQ_SCOPE=off.`;
}

function ownerOf(path, { codeRoot, workspacesRoot, repositories }) {
  for (const repository of repositories) {
    if (within(path, join(codeRoot, repository.path))) return repository;
  }
  if (within(path, workspacesRoot)) {
    const [, name] = relative(workspacesRoot, path).split(sep);
    return repositories.find((repository) => repository.name === name);
  }
  return undefined;
}

function within(path, directory) {
  const offset = relative(directory, path);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function flagValue(args, names) {
  for (let index = 0; index < args.length; index += 1) {
    for (const name of names) {
      if (args[index] === name) return args[index + 1];
      if (args[index].startsWith(`${name}=`)) return args[index].slice(name.length + 1);
    }
  }
  return undefined;
}

function expandHome(path) {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

// Splits a shell command into simple commands' words: quotes and escapes
// are honoured, `;`, `&&`, `||`, `|`, `&` and newlines separate commands, and
// redirections become their own words. Enough to read what a command
// touches; it doesn't expand variables or substitutions.
export function segments(command) {
  const result = [];
  let words = [];
  let word = "";
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) result.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < command.length)
        word += command[++index];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "&" && !inWord && /^(?:\d|&)?>>?$/u.test(words.at(-1) ?? "")) {
      word += char;
      inWord = true;
    } else if (char === "\\" && index + 1 < command.length) {
      word += command[++index];
      inWord = true;
    } else if (
      char === "\n" ||
      char === ";" ||
      char === "|" ||
      (char === "&" && command[index + 1] !== ">")
    ) {
      if ((char === "|" || char === "&") && command[index + 1] === char) index += 1;
      endSegment();
    } else if (char === ">") {
      const prefix = inWord && /^(?:\d|&)$/u.test(word) ? word : "";
      if (!prefix) endWord();
      word = "";
      inWord = false;
      const operator = command[index + 1] === ">" ? ">>" : ">";
      if (operator === ">>") index += 1;
      words.push(`${prefix}${operator}`);
    } else if (/\s/u.test(char)) {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  endSegment();
  return result;
}
