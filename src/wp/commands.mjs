// `gq wp`: break-glass WP-CLI on the Site's production CMS, for when the REST
// route (gq content) is unavailable (gq-platform ADR 0011). Never over a
// hand-written SSH alias: the host is the Site's own, from gq.ops.json
// (`ploi.serverId`, `ploi.systemUser`, `domains.admin`, `ploi.projectRoot`)
// or, without a system user there, from the Ploi site serving
// `domains.admin`, and the command runs as a Ploi one-off script as that
// system user, like gq db backup's export. Only the commands policy.mjs
// allows run; a write is confirmed, preceded by a gq db backup, and acts as
// a named WordPress user (`--user`, else GQ_CMS_AGENT_USERNAME) so WordPress
// authorizes and attributes it. `post update <id> <file>` sends the local
// file through a short-lived presigned R2 URL (a script holds at most 7,500
// characters) and then confirms WordPress stored those bytes and recorded a
// new revision.
//
//   gq wp [--yes] -- <wp-cli command and arguments>

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CMS_PATH } from "../cms/local.mjs";
import { createReporter } from "../cli/reporter.mjs";
import { redactText } from "../cli/redact.mjs";
import { AGENT_USERNAME } from "../content/transport.mjs";
import { sha256 } from "../content/receipts.mjs";
import {
  backupKey,
  exportLiveDatabase,
  runServerScript,
  shellQuote,
  sitePath,
  timestamp,
} from "../db/sync.mjs";
import { loadProjectContext } from "../ops/project-context.mjs";
import { createPloiServerClient } from "../ploi/server-client.mjs";
import { createR2Client } from "../r2.mjs";
import { classifyWpCommand } from "./policy.mjs";

export const WP_USAGE = [
  "gq wp [--yes] -- <wp-cli command> (break-glass; see docs/guides/cms-content.md)",
];

// Ploi's limit on a one-off script.
const SCRIPT_LIMIT = 7500;

export function isWpCommand(argv) {
  return argv[0] === "wp";
}

export function parseWpArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1) throw new Error(`Put the WP-CLI command after --.\nUsage: ${WP_USAGE[0]}`);
  const own = argv.slice(0, separator);
  const yes = own.includes("--yes");
  const unknown = own.filter((argument) => argument !== "--yes");
  if (unknown.length > 0)
    throw new Error(`${unknown[0]} is not a gq wp option.\nUsage: ${WP_USAGE[0]}`);
  return { yes, args: argv.slice(separator + 1) };
}

export function wpMarker(project) {
  return `${String(project)
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "_")}_WP_CLI`;
}

/**
 * The server script: `wp` with `args` in the CMS directory. For a post
 * update, `upload` ({ url, sha256, index }) is the content file (`args[index]`), fetched and checked
 * first, and the script reports the newest revision before and after and the
 * stored content's hash.
 */
export function remoteWpScript({ path, args, marker, upload, postId }) {
  // The content file's argument is the downloaded copy on the server.
  const word = (arg, index) => (upload && index === upload.index ? '"$content"' : shellQuote(arg));
  const wp = (words) => `wp ${words.map(word).join(" ")}`;
  const plain = (words) => `wp ${words.map(shellQuote).join(" ")}`;
  const lines = ["set -euo pipefail", "umask 077", `cd ${shellQuote(`${path}/${CMS_PATH}`)}`];
  if (upload) {
    const latest = `${plain(["post", "list", "--post_type=revision", `--post_parent=${postId}`, "--post_status=inherit", "--orderby=ID", "--order=DESC", "--posts_per_page=1", "--field=ID"])}`;
    lines.push(
      'content="$(mktemp)"',
      `trap 'rm -f "$content"' EXIT`,
      `curl -fsS --retry 3 -o "$content" ${shellQuote(upload.url)}`,
      `[ "$(sha256sum "$content" | cut -d ' ' -f 1)" = ${shellQuote(upload.sha256)} ] || { echo "${marker}=mismatch"; exit 1; }`,
      `before="$(${latest})"`,
      wp(args),
      `after="$(${latest})"`,
      // `wp post get --field` ends the value with one newline of its own.
      `stored="$(${plain(["post", "get", String(postId), "--field=post_content"])} | head -c -1 | sha256sum | cut -d ' ' -f 1)"`,
      `echo "${marker}=done BEFORE=\${before:-none} AFTER=\${after:-none} STORED=$stored"`,
    );
  } else {
    lines.push(
      "set +e",
      wp(args),
      "status=$?",
      "set -e",
      `echo "${marker}=done EXIT=$status"`,
      'exit "$status"',
    );
  }
  return `${lines.join("\n")}\n`;
}

export function parseWpMarker(output, marker) {
  const done = new RegExp(`${marker}=done (.*)$`, "mu").exec(output ?? "");
  if (!done) return null;
  return Object.fromEntries(done[1].split(" ").map((pair) => pair.split("=")));
}

// The server, system user and site path: gq.ops.json first, the Ploi site
// for domains.admin when the system user isn't recorded there.
async function resolveHost(client, ops) {
  const domain = ops.domains?.admin;
  if (!domain) throw new Error("gq.ops.json domains.admin is required.");
  if (ops.ploi?.systemUser) {
    return {
      user: ops.ploi.systemUser,
      path: sitePath({
        systemUser: ops.ploi.systemUser,
        domain,
        projectRoot: ops.ploi.projectRoot,
      }),
    };
  }
  const site = (await client.list("/sites")).find((entry) => entry.domain === domain);
  if (!site?.system_user)
    throw new Error(`No Ploi site on server ${ops.ploi.serverId} serves ${domain}.`);
  return {
    user: site.system_user,
    path: sitePath({ systemUser: site.system_user, domain, projectRoot: site.project_root ?? "/" }),
  };
}

// `argv` is everything after `gq`. Resolves to the exit code.
export async function runWpCommand(argv, { cwd, env, fetch, io, interactive }) {
  const { yes, args } = parseWpArguments(argv.slice(1));
  const classified = classifyWpCommand(args);
  const context = await loadProjectContext({ cwd, env });
  const ops = context.config;
  const ui = createReporter(io, interactive);

  let wpArgs = args;
  if (classified.write && !classified.flags.has("user")) {
    const user = context.env[AGENT_USERNAME];
    if (!user) {
      throw new Error(
        `A write needs --user=<login> (or ${AGENT_USERNAME}) so WordPress authorizes and attributes it.`,
      );
    }
    wpArgs = [...args, `--user=${user}`];
  }
  const update = classified.command === "post update" && classified.positionals[1];
  const content = update
    ? await readFile(resolve(context.invocationDirectory, classified.positionals[1]), "utf8")
    : null;

  const client = createPloiServerClient({
    token: context.env.PLOI_API_TOKEN,
    serverId: ops.ploi?.serverId,
    fetch,
  });
  const host = await resolveHost(client, ops);
  io.out(
    `wp ${classified.command} on ${ops.domains.admin} (Ploi server ${ops.ploi.serverId}, as ${host.user})`,
  );

  let r2;
  if (classified.write) {
    if (!yes) {
      if (!interactive)
        throw new Error("Pass --yes to run a write on the production CMS non-interactively.");
      if (
        !(await ui.confirm(
          `Back up the live database, then run wp ${classified.command} on ${ops.domains.admin}?`,
        ))
      ) {
        io.out("Nothing ran.");
        return 0;
      }
    }
    if (!ops.backups?.bucket || !ops.cloudflare?.accountId || !ops.ploi?.database) {
      throw new Error(
        "A write backs up first: gq.ops.json backups.bucket, cloudflare.accountId and ploi.database are required.",
      );
    }
    r2 = createR2Client({
      accountId: ops.cloudflare.accountId,
      bucket: ops.backups.bucket,
      accessKeyId: context.env.R2_ACCESS_KEY_ID,
      secretAccessKey: context.env.R2_SECRET_ACCESS_KEY,
      fetch,
    });
    const key = backupKey(ops.backups.prefix ?? "db/", ops.ploi.database);
    io.out("Backing up the live database to R2 (gq db backup)");
    const backup = await exportLiveDatabase(
      client,
      { ...ops, ploi: { ...ops.ploi, systemUser: host.user } },
      await r2.presignPut(key),
    );
    io.out(
      `Backed up (${(backup.bytes / 1024 / 1024).toFixed(1)} MB) to r2://${ops.backups.bucket}/${key}`,
    );
  }

  const marker = wpMarker(ops.project);
  let upload;
  let uploadKey;
  if (content !== null) {
    uploadKey = `content/${ops.project}/${timestamp()}-${classified.positionals[0]}.html`;
    await r2.put(uploadKey, content, "text/html; charset=utf-8");
    upload = {
      url: await r2.presignGet(uploadKey, 900),
      sha256: sha256(content),
      // The file is the second positional after `post update`.
      index: wpArgs.indexOf(
        classified.positionals[1],
        wpArgs.indexOf(classified.positionals[0]) + 1,
      ),
    };
  }
  try {
    const script = remoteWpScript({
      path: host.path,
      args: wpArgs,
      marker,
      upload,
      postId: classified.positionals[0],
    });
    if (script.length > SCRIPT_LIMIT)
      throw new Error(`The server script is longer than Ploi's ${SCRIPT_LIMIT} characters.`);
    const execution = await runServerScript(client, script, {
      user: host.user,
      what: "the WP-CLI script",
    });
    const output = (execution.output ?? "")
      .split("\n")
      .filter((line) => !line.startsWith(`${marker}=`))
      .join("\n")
      .trim();
    if (output) io.out(redactText(output));
    const result = parseWpMarker(execution.output, marker);
    if (!upload) return result ? Number(result.EXIT) : execution.exit_code || 1;
    if (execution.exit_code !== 0 || !result) {
      io.err(`✗ wp post update failed (exit ${execution.exit_code}).`);
      return 1;
    }
    if (result.STORED !== upload.sha256) {
      io.err(
        "✗ WordPress stored other markup than the file (KSES or a content filter changed it).",
      );
      return 1;
    }
    if (result.AFTER === "none" || result.AFTER === result.BEFORE) {
      io.err(
        "✗ The post was updated, but WordPress recorded no new revision; the backup is the rollback.",
      );
      return 1;
    }
    io.out(
      `✓ Stored exactly; revision ${result.AFTER} holds it${result.BEFORE === "none" ? "" : ` (the one before is ${result.BEFORE})`}.`,
    );
    io.out("Publish to the Frontend with gq frontend refresh, then check the live page.");
    return 0;
  } finally {
    if (uploadKey) await r2.delete(uploadKey).catch(() => {});
  }
}
