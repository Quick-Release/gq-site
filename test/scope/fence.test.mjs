import assert from "node:assert/strict";
import test from "node:test";

import { fenceToolCall, segments } from "../../src/scope/fence.mjs";

const PLACE = {
  root: "/data/agents/workspaces/claude/gq-site/scope",
  repository: "gq-site",
  allowed: ["/data/agents/scratch", "/tmp"],
  codeRoot: "/data/code/getquick",
  workspacesRoot: "/data/agents/workspaces",
};

const bash = (command) => fenceToolCall({ toolName: "Bash", toolInput: { command } }, PLACE);
const write = (toolName, file_path) => fenceToolCall({ toolName, toolInput: { file_path } }, PLACE);

test("edits and writes inside the repository, or in an allowed directory, pass", () => {
  assert.equal(write("Edit", `${PLACE.root}/src/run.mjs`), null);
  assert.equal(write("Write", "docs/adr/0016-x.md"), null);
  assert.equal(write("Write", "/data/agents/scratch/notes.md"), null);
  assert.equal(
    fenceToolCall(
      { toolName: "NotebookEdit", toolInput: { notebook_path: "/tmp/a.ipynb" } },
      PLACE,
    ),
    null,
  );
});

test("an edit in another repository's clone is denied, naming its owner", () => {
  const reason = write("Edit", "/data/code/getquick/wp-plugins/gq-ecommerce/README.md");
  assert.match(reason, /outside this repository/u);
  assert.match(
    reason,
    /Quick-Release\/gq-ecommerce \(\/data\/code\/getquick\/wp-plugins\/gq-ecommerce\)/u,
  );
  assert.match(reason, /start a new session/u);
  assert.match(reason, /GQ_SCOPE=off/u);
});

test("a write in another repository's worktree is denied, naming its owner", () => {
  const reason = write("MultiEdit", "/data/agents/workspaces/claude/ekis/scope-section/AGENTS.md");
  assert.match(reason, /Quick-Release\/ekis/u);
  assert.match(reason, /\.\.\/|outside/u);
});

test("other checkouts of the same repository pass: its main clone and sibling worktrees", () => {
  assert.equal(write("Edit", "/data/code/getquick/gq-site/AGENTS.md"), null);
  assert.equal(write("Write", "/data/agents/workspaces/claude/gq-site/other-task/README.md"), null);
  assert.equal(
    bash(
      "git -C /data/code/getquick/gq-site worktree add -b claude/x /data/agents/workspaces/claude/gq-site/x origin/main",
    ),
    null,
  );
});

test("reading other repositories with git or the shell passes", () => {
  for (const command of [
    "git -C /data/code/getquick/clients/ekis log --oneline -5",
    "git -C /data/code/getquick/wp-plugins/gq-ecommerce grep -n CartBearerIsolation",
    "cd /data/code/getquick/clients/ekis && git status && cat AGENTS.md",
    "gh issue list -R Quick-Release/ekis",
    "gh api repos/Quick-Release/ekis/issues/53 --jq .id",
    "cp /data/code/getquick/clients/ekis/README.md /data/agents/scratch/ekis.md",
    "grep -rn foo /data/code/getquick 2>&1 | head > /dev/null",
  ]) {
    assert.equal(bash(command), null, command);
  }
});

test("git writes in another repository are denied, by -C or by cd", () => {
  for (const command of [
    "git -C /data/code/getquick/clients/ekis commit -am x",
    "git -C /data/code/getquick/clients/ekis worktree add -b claude/x /data/agents/workspaces/claude/ekis/x",
    "cd /data/agents/workspaces/claude/gq-ecommerce/task && git add -A && git commit -m x",
    "cd /data/code/getquick/gq-platform; git push",
    "git -C /data/code/getquick/clients/ekis branch -D old",
  ]) {
    assert.match(bash(command), /Change nothing there/u, command);
  }
});

test("git writes in this repository pass, including after cd within it", () => {
  for (const command of [
    "git add -A && git commit -m 'feat: x'",
    `cd ${PLACE.root}/src && git add . && git push -u origin claude/scope`,
    "git -C . tag v1",
    "git branch --show-current",
  ]) {
    assert.equal(bash(command), null, command);
  }
});

test("gh writes aimed at another repository are denied", () => {
  for (const command of [
    "gh issue create -R Quick-Release/gq-platform --title x --body y",
    "gh pr create --repo Quick-Release/ekis --title x",
    "gh label create needs-triage --force -R Quick-Release/gq-content",
    "gh issue transfer 49 Quick-Release/gq-platform",
    "gh repo create Quick-Release/gq-new --private",
    "gh api -X PATCH repos/Quick-Release/gq-storefront/issues/8 -F body=@x.md",
    "gh api repos/Quick-Release/ekis/issues/1/sub_issues -F sub_issue_id=1",
    "cd /data/code/getquick/clients/ekis && gh pr create --title x",
  ]) {
    assert.match(bash(command), /Change nothing there|Quick-Release/u, command);
    assert.notEqual(bash(command), null, command);
  }
});

test("gh writes to this repository pass", () => {
  for (const command of [
    "gh pr create --title x --body y",
    "gh issue comment 27 -R Quick-Release/gq-site --body x",
    "gh api -X PATCH repos/Quick-Release/gq-site/pulls/76 --input -",
  ]) {
    assert.equal(bash(command), null, command);
  }
});

test("file commands and redirections that write outside are denied", () => {
  for (const command of [
    "echo x > /data/code/getquick/clients/ekis/notes.md",
    "printf x >> /data/code/getquick/gq-platform/x",
    "rm -rf /data/code/getquick/gq-platform/docs",
    "cp README.md /data/code/getquick/clients/ekis/README.md",
    "mkdir -p /data/agents/workspaces/claude/ekis/new",
    "sed -i 's/a/b/' /data/code/getquick/wp-plugins/gq-theme/README.md",
    "cat x | tee /data/code/getquick/gq-content/README.md",
  ]) {
    assert.notEqual(bash(command), null, command);
  }
});

test("redirections to null, the terminal's streams, or allowed directories pass", () => {
  for (const command of [
    "node x.mjs > /dev/null 2>&1",
    "node x.mjs &> /tmp/out.log",
    "jq . > /data/agents/scratch/x.json",
    "sed -n 1,5p /data/code/getquick/clients/ekis/AGENTS.md",
  ]) {
    assert.equal(bash(command), null, command);
  }
});

test("other tools are never fenced", () => {
  assert.equal(
    fenceToolCall({ toolName: "Read", toolInput: { file_path: "/etc/hosts" } }, PLACE),
    null,
  );
});

test("segments splits simple commands and keeps quoted words whole", () => {
  assert.deepEqual(segments(`cd "/a b" && git commit -m 'x; y' || echo no | tee c 2>&1`), [
    ["cd", "/a b"],
    ["git", "commit", "-m", "x; y"],
    ["echo", "no"],
    ["tee", "c", "2>", "&1"],
  ]);
});

test("a heredoc's body is input, not commands", () => {
  const body =
    "into releases/<version>-<sha>/, link shared/\nrm -rf /data/code/getquick/clients/ekis";
  assert.equal(bash(`gh pr create --body-file - <<'EOF'\n${body}\nEOF`), null);
  assert.equal(bash(`cat <<-EOF > notes.md\n\t${body}\n\tEOF\ngit status`), null);
  assert.deepEqual(segments(`cat <<"A" <<B\n> x\nA\n> y\nB\necho done`), [
    ["cat", "<<A", "<<B"],
    ["echo", "done"],
  ]);
  assert.match(bash(`cat <<EOF\nx\nEOF\ntouch /etc/x`), /outside this repository/u);
});
