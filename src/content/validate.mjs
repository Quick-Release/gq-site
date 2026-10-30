// `gq content validate`: the Site's own block editor judges the markup before
// production sees it (gq-platform ADR 0011). The markup is written to the same
// post in the Site's local CMS (its DDEV copy, fed by gq db sync, on the same
// composer.lock) as a local Editor would save it, then the post is opened in
// the block editor in a headless Chrome. Validation fails when WordPress
// stored other bytes than given (KSES or a content filter changed them), or
// when the editor marks any block invalid (its markup isn't what the block's
// save() produces) or doesn't know a block type.

// The local user validation writes and edits as: an Editor, the role the
// production agent user has, so KSES treats the markup the same way.
export const CHECK_USER = "gq-content-check";
const MARKER = "GQ_CONTENT_APPLY=";

function phpString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/**
 * The PHP `wp eval-file -` runs locally: it writes `content` to post `id` as
 * the check user (created as an Editor when missing) and prints, after
 * MARKER, whether the stored bytes are the given ones and the session cookies
 * the editor is opened with (never printed by gq).
 */
export function localApplyScript({ id, type, content }) {
  return `<?php
$id = ${Number(id)};
$type = ${phpString(type)};
$login = ${phpString(CHECK_USER)};
$content = base64_decode(${phpString(Buffer.from(content, "utf8").toString("base64"))}, true);
$report = static function (array $value): void { echo "\\n${MARKER}" . wp_json_encode($value) . "\\n"; };
$post = get_post($id);
if (!$post || $post->post_type !== $type) {
    $report(['error' => "There is no {$type} {$id} in the local CMS; run gq db sync first."]);
    return;
}
$user = get_user_by('login', $login);
if (!$user) {
    $created = wp_insert_user(['user_login' => $login, 'user_pass' => wp_generate_password(32), 'user_email' => $login . '@example.invalid', 'display_name' => 'gq content check', 'role' => 'editor']);
    if (is_wp_error($created)) { $report(['error' => $created->get_error_message()]); return; }
    $user = get_user_by('id', $created);
} elseif ($user->roles !== ['editor']) {
    $user->set_role('editor');
}
wp_set_current_user($user->ID);
$updated = wp_update_post(['ID' => $id, 'post_content' => wp_slash($content)], true);
if (is_wp_error($updated)) { $report(['error' => $updated->get_error_message()]); return; }
clean_post_cache($id);
$stored = get_post_field('post_content', $id, 'raw');
$expiration = time() + HOUR_IN_SECONDS;
$token = WP_Session_Tokens::get_instance($user->ID)->create($expiration);
$secure = wp_parse_url(admin_url(), PHP_URL_SCHEME) === 'https';
$auth = wp_generate_auth_cookie($user->ID, $expiration, $secure ? 'secure_auth' : 'auth', $token);
$loggedIn = wp_generate_auth_cookie($user->ID, $expiration, 'logged_in', $token);
$name = $secure ? SECURE_AUTH_COOKIE : AUTH_COOKIE;
$report([
    'stored' => $stored === $content,
    'storedContent' => $stored === $content ? null : base64_encode($stored),
    'editUrl' => admin_url('post.php?post=' . $id . '&action=edit'),
    'cookies' => array_values(array_unique([
        ['name' => $name, 'value' => $auth, 'path' => ADMIN_COOKIE_PATH],
        ['name' => $name, 'value' => $auth, 'path' => PLUGINS_COOKIE_PATH],
        ['name' => LOGGED_IN_COOKIE, 'value' => $loggedIn, 'path' => COOKIEPATH],
        ['name' => LOGGED_IN_COOKIE, 'value' => $loggedIn, 'path' => SITECOOKIEPATH],
    ], SORT_REGULAR)),
]);
`;
}

export function parseApplyReport(output) {
  const line = String(output ?? "")
    .split("\n")
    .findLast((entry) => entry.startsWith(MARKER));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(MARKER.length));
  } catch {
    return null;
  }
}

// Evaluated in the editor until it says it is ready: every block the editor
// parsed from the post (core/editor's, whatever the rendering mode), with
// those it marked invalid and those whose type isn't registered. A block the
// editor accepts only through one of its deprecations (an older save()) is
// valid but \`migrated\`: the editor rewrites its markup on the next save.
export const EDITOR_CHECK = `(() => {
  if (location.pathname.endsWith("/wp-login.php")) return { state: "login" };
  const data = window.wp && window.wp.data;
  const editor = data && data.select("core/editor");
  if (!editor || !data.select("core/block-editor")) return { state: "loading" };
  if (typeof editor.__unstableIsEditorReady === "function" && !editor.__unstableIsEditorReady()) return { state: "loading" };
  if (editor.getCurrentPostId() == null) return { state: "loading" };
  const blocks = typeof editor.getEditorBlocks === "function" ? editor.getEditorBlocks() : data.select("core/block-editor").getBlocks();
  // A validation issue is a console format string and its values.
  const shown = (value) => typeof value === "string" ? value : (value && value.name) || JSON.stringify(value);
  const text = (issue) => {
    const [format, ...values] = issue && Array.isArray(issue.args) ? issue.args : [String(issue)];
    return String(format).replace(/%[sod]/g, () => shown(values.shift())).slice(0, 600);
  };
  const api = window.wp.blocks;
  const current = (block) => {
    try {
      return api.validateBlock(block, api.getBlockType(block.name))[0];
    } catch {
      return true;
    }
  };
  const problems = [];
  const migrated = [];
  let count = 0;
  let freeform = 0;
  const walk = (list, prefix) => list.forEach((block, index) => {
    count += 1;
    const path = prefix + index;
    if (block.name === "core/missing") problems.push({ path, name: (block.attributes && block.attributes.originalName) || block.name, reason: "its block type isn't registered" });
    else if (block.isValid === false) problems.push({ path, name: block.name, reason: "invalid", issues: (block.validationIssues || []).map(text) });
    else if (block.name !== "core/freeform" && typeof block.originalContent === "string" && api && typeof api.validateBlock === "function" && !current(block)) migrated.push({ path, name: block.name });
    if (block.name === "core/freeform") freeform += 1;
    walk(block.innerBlocks || [], path + ".");
  });
  walk(blocks, "");
  return { state: "ready", postId: editor.getCurrentPostId(), count, freeform, problems, migrated };
})()`;

/**
 * Validates `content` for post `id` of `type` in the local CMS. `wp(args,
 * { input })` runs WP-CLI there; `openEditor({ url, cookies, expression })`
 * evaluates the check in a browser; `origin` is the local CMS's. Resolves to
 * { ok, reason?, count, freeform, problems, migrated, storedContent? }.
 */
export async function validateLocally({ wp, openEditor, origin, id, type, content }) {
  const result = await wp(["eval-file", "-"], { input: localApplyScript({ id, type, content }) });
  const report = parseApplyReport(result.stdout);
  if (!report) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .trim()
      .split("\n")
      .slice(-10)
      .join("\n");
    throw new Error(`Couldn't write the markup to the local CMS (exit ${result.code}):\n${detail}`);
  }
  if (report.error) throw new Error(report.error);
  if (!report.stored) {
    return {
      ok: false,
      reason: "WordPress stored other markup than given (KSES or a content filter changed it)",
      storedContent: Buffer.from(report.storedContent ?? "", "base64").toString("utf8"),
      count: 0,
      freeform: 0,
      problems: [],
      migrated: [],
    };
  }
  const local = new URL(origin);
  const editUrl = new URL(report.editUrl);
  if (editUrl.origin !== local.origin) {
    throw new Error(`The local CMS's admin is at ${editUrl.origin}, not ${local.origin}.`);
  }
  const cookies = report.cookies.map(({ name, value, path }) => ({
    name,
    value,
    domain: local.hostname,
    path,
    secure: local.protocol === "https:",
    httpOnly: true,
  }));
  const checked = await openEditor({ url: editUrl.href, cookies, expression: EDITOR_CHECK });
  if (checked.state === "login")
    throw new Error("The local editor asked to log in; the check user's session wasn't accepted.");
  if (checked.state !== "ready")
    throw new Error("The local editor didn't finish loading the post in time.");
  if (checked.postId !== Number(id))
    throw new Error(`The editor opened post ${checked.postId}, not ${id}.`);
  return {
    ok: checked.problems.length === 0,
    reason: checked.problems.length === 0 ? undefined : "the block editor reports invalid blocks",
    count: checked.count,
    freeform: checked.freeform,
    problems: checked.problems,
    migrated: checked.migrated ?? [],
  };
}
