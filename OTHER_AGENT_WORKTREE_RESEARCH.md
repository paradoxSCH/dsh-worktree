# 现代 Coding Agent 的 Worktree 产品行为

> 核验日期：2026-08-14。只采用厂商官方文档、官方源码仓库或厂商安全公告。各产品仍在快速迭代，尤其 VS Code Agents Window、GitHub Copilot App 和 cloud agent 的 preview 功能；本文记录的是核验日可见行为，不把未文档化的内部实现当成承诺。

## 结论先行

成熟产品并不存在一个统一的 dirty-workspace 策略：

- OpenAI Codex Desktop 会以所选分支的 `HEAD` 为起点，并把该分支的未提交修改应用到 detached worktree；普通未跟踪文件并没有被官方承诺完整继承，ignored 文件只经 `.worktreeinclude` 白名单复制。
- Claude Code 默认从远端默认分支的干净状态创建新分支；可改为当前本地 `HEAD`，但仍只携带提交，不复制 tracked dirty 或普通 untracked 文件。
- VS Code 的本地 Copilot/Claude/Codex worktree 明确只从所选分支的 committed state 创建，不自动继承 tracked dirty 或 untracked 文件。
- GitHub Copilot cloud agent、Cursor cloud agent 都从远端仓库/所选 base branch 启动，所以本地 checkout 的 dirty state 天然不在输入范围内。

因此，完整的 `dsh-worktree` 不应把“父仓库 dirty 就拒绝”作为唯一产品策略。更合理的是让调用者明确选择：

1. `committed`：从一个不可变 commit OID 开始，完全可复现。
2. `snapshot`：从 commit OID 开始，再应用一次显式、可审计的 staged/unstaged/untracked snapshot。

ignored 文件应独立采用 allowlist；任何模式都必须在创建结果中列出真正带入和跳过的文件。

## 横向比较

| 产品 | dirty checkout 如何处理 | 初始 HEAD/branch | Agent 完成后的产品动作 | 清理、保留与锁 |
|---|---|---|---|---|
| Claude Code CLI/Desktop | 默认 `fresh` 从远端默认分支；可设 `head` 使用当前本地 `HEAD` 和未推送 commits。只 checkout tracked files；普通 dirty/untracked 不继承，ignored 仅 `.worktreeinclude` | 创建 `worktree-<name>` 新分支 | 有修改时保留目录和分支，可继续、commit、push、PR；退出时询问保留或删除。Desktop 可在 PR merge/close 后自动 archive | clean unnamed session 自动删；dirty/new commits 询问。subagent/background 有 retention sweep；运行中明确执行 `git worktree lock`，死进程的插件锁可回收 |
| OpenAI Codex Desktop | 所选 branch 的 `HEAD` + 未提交修改；ignored 仅 `.worktreeinclude`，普通 untracked 未获完整继承承诺 | 默认 detached HEAD | `Create branch here` 后 commit/push/PR；或 Handoff 将 chat+code 移到 Local；也可留在原 worktree 继续 | managed/permanent 两类；默认保留最近 15 个 managed；pin/running/permanent 防清理；删除前 snapshot，重开 chat 可 restore。官方未声明 Git lock |
| VS Code Agents / Copilot harness | 明确只含所选 base branch 的 committed files；不自动含 tracked dirty/untracked；ignored 用 `git.worktreeIncludeFiles` | 新 branch + worktree | Review 全量/单 turn diff；Apply/Migrate、Commit/Merge、Checkout branch、PR 或 Discard | archive 前将未提交修改 commit 到 session branch，再删 worktree；恢复时由 branch 重建。fork 可共享 worktree，最后一个关联 session 结束后才释放。官方未声明 Git lock |
| GitHub Copilot App | 官方只说明每个本地 session 使用独立 worktree+branch；未说明从已连接 local folder 创建时是否继承 dirty/untracked | 每 session 独立 branch | Changes diff、迭代、Create PR、在 App 内 review/CI/merge | 当前公开文档没有说明 worktree retention、dirty deletion 或 Git lock，不能自行推断 |
| GitHub Copilot cloud agent | 远端 ephemeral environment，从用户选择的 base branch 建任务分支；本地 dirty 不适用 | `copilot/*` 单独分支 | Agent 自动 commit/push；prompt task 默认可先留 branch、看 diff、迭代后建 PR；issue assignment 直接进入 PR 流程 | Stop 保留已经 pushed 的 commits；cloud session 可 archive 但不可 delete；环境是 ephemeral。没有本地 worktree lock 语义 |
| Cursor local/cloud agents | local worktree 是否继承 dirty 未被官方文档明确；cloud clone GitHub repo，local dirty 不适用 | 官方描述为独立 branch/worktree | local 点击 Apply 合入当前 working branch；cloud push branch/开 PR，人工 review/merge | 官方公开材料没有给出可靠的 retention/lock/restore 契约 |

## 1. Claude Code 与 Claude Desktop

### 基线与 dirty 状态

Claude Code 默认在 `.claude/worktrees/<name>` 创建 `worktree-<name>` 分支。`worktree.baseRef` 支持：

- `fresh`（默认）：从远端默认分支创建干净 worktree；远端不可用时才回退本地 `HEAD`。
- `head`：从当前本地 `HEAD` 创建，包含未推送 commits 和当前 feature-branch state。

官方同时明确写明 worktree “checks out only tracked files”，`.worktreeinclude` 只能复制同时满足“被 Git ignore”与“匹配白名单”的文件，tracked 文件不会借此复制。因此 `head` 的“current work”是当前 commit，不是 working-tree dirty snapshot。[Claude worktree：基线与文件复制](https://code.claude.com/docs/en/worktrees#choose-the-base-branch)

### 分支、交付与清理

Claude 一开始就创建分支，而不是 detached HEAD。退出交互式 session 时：

- 没有 changed/untracked/new commits：匿名 session 自动删 worktree 和 branch；命名 session 先询问是否保留。
- 有上述任何工作：询问 keep 或 remove；keep 保留目录和 branch，remove 会丢弃 uncommitted、untracked 与 commits。
- 非交互 `-p` 没有退出确认，所以不自动清理。

Desktop 每个新 session 默认独立 worktree；Archive 是显式清理入口，并可配置 PR merge/close 后自动 archive。[Claude cleanup](https://code.claude.com/docs/en/worktrees#clean-up-worktrees) [Claude Desktop sessions](https://code.claude.com/docs/en/desktop#work-in-parallel-with-sessions)

### 运行锁、周期回收和安全边界

Claude 是所核验产品中唯一在官方产品文档里明确承诺 `git worktree lock` 的：subagent/background session 运行时锁定 worktree；结束后解锁；周期 sweep 会回收由已退出进程遗留的 Claude 自有锁，但不会碰用户手工锁。Sweep 跳过 changed、untracked 或 unpushed commits。[Claude subagent retention](https://code.claude.com/docs/en/worktrees#clean-up-subagent-and-background-session-worktrees)

隔离不是只有一个 cwd：Claude 会阻止文件工具写回 main checkout、阻止 shell cwd 指向 main checkout、阻止 `git -C`/`--git-dir`/`GIT_DIR`/`GIT_WORK_TREE` 重定向，并拒绝无法静态验证的命令形状。[Claude isolation enforcement](https://code.claude.com/docs/en/worktrees#how-claude-code-enforces-isolation)

这不是理论风险。Anthropic 的官方安全公告披露过 worktree 名称 `.git`、路径逃逸、symlink 与 Git fsmonitor 组合造成 sandbox escape；受影响版本 `< 2.1.163`。[GHSA-7835-87q9-rgvv](https://github.com/anthropics/claude-code/security/advisories/GHSA-7835-87q9-rgvv)

## 2. OpenAI Codex Desktop

> 官方页面明确说这里的 managed-worktree 生命周期只适用于 ChatGPT Desktop 中的 Codex；不能把它直接外推为 Codex CLI 的内建 worktree 行为。

### dirty snapshot 与 detached HEAD

用户可选择 main、feature branch，或“带 unstaged local changes 的当前分支”。Codex 以所选 branch 的 `HEAD` 为 starting commit，把该分支的 uncommitted changes 应用到新 worktree，并默认保持 detached HEAD，以避免为多个并行 chat 污染 branch namespace。[OpenAI Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees#how-codex-manages-worktrees-for-you)

边界必须读准确：官方没有把 staged、unstaged、普通 untracked 的完整搬运矩阵逐项写死；文档只明确了“uncommitted changes”，并明确 ignored 文件默认不搬。`.worktreeinclude` 只复制匹配的 Git-ignored 文件，不复制其它 Git 不追踪的文件，同时跳过 source symlink、不会覆盖目标已有文件。[OpenAI `.worktreeinclude`](https://learn.chatgpt.com/docs/environments/git-worktrees#copy-ignored-local-files-into-managed-worktrees)

### 两类交付路径

Codex 把“Agent 完成”与“Git 工作结束”分开：

1. 留在 worktree：点击 `Create branch here`，再 commit、push、开 PR。
2. Handoff 到 Local：产品负责在两个 checkout 之间安全搬动 chat 与 code；以后 hand back 会回到同一个关联 worktree。

这比“任务结束立即自动 commit/merge”更保守，也把本地运行、IDE 检查等前台验证变成一级流程。[OpenAI Handoff](https://learn.chatgpt.com/docs/environments/git-worktrees#working-between-local-and-worktree)

### managed、permanent、snapshot restore

- managed：通常一 chat 一个，轻量、可清理。
- permanent：作为独立 project 长驻，可由多个 chat 使用，不自动删除。
- 默认只保留最近 15 个 managed，可调整或关闭；pinned chat、进行中的 chat、permanent worktree 不被自动删。
- Archive 或超过上限可触发删除，但删除 managed worktree 前保存 snapshot；重开 chat 可恢复。

这意味着 Codex 的安全网不是“dirty 永远保留目录”，而是“删除前持久化可恢复状态”。官方没有声明使用 `git worktree lock`，所以不能把它写进兼容性假设。[OpenAI worktree cleanup](https://learn.chatgpt.com/docs/environments/git-worktrees#worktree-cleanup)

## 3. VS Code Agents 与 Copilot/Claude/Codex harness

### committed-only 是明确产品选择

VS Code 的 `New Worktree` 从所选 base branch 的 committed Git state 创建新 branch+worktree；官方明确说不会自动包含 primary worktree 的 uncommitted tracked changes 或 untracked files。需要 dirty 状态时，应先 commit，或选择直接操作当前目录的 Folder isolation。ignored 文件可用 `git.worktreeIncludeFiles` 白名单复制。[VS Code code isolation](https://code.visualstudio.com/docs/agents/run/agent-harnesses#choose-code-isolation)

### Review 是完整产品面，不只是一个 `git diff`

Agents Window 的 Changes 面板可在 branch changes、uncommitted changes、all changes、last agent turn 之间切换，并支持逐块反馈；可直接在 session worktree 中运行任务、终端、浏览器和测试。之后可以生成 commit message 并 commit，或把 worktree changes migrate/apply 回当前 workspace。[VS Code Agents review](https://code.visualstudio.com/docs/agents/run/agents-window#review-and-finish-an-agent-session) [VS Code worktree migrate](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees#compare-and-migrate-changes-from-a-worktree)

官方 review 指南还提供 Apply/Migrate、commit/merge session branch、checkout branch、discard 等收尾动作；归档/删除前应先确认结果已经集成或持久化。[VS Code integrate worktree changes](https://code.visualstudio.com/docs/agents/run/review-code-edits#integrate-worktree-changes)

### Session 所有权与恢复

VS Code 的生命周期比单个 agent run 更长：fork 出的 Copilot session 可以继续共享原 worktree，只有最后一个 linked session 被 archive/delete 后才释放。Archive/Mark done 会先把未提交修改 commit 到 session branch，再移除 worktree；恢复 session 时从保留的 branch 重建。Delete 是真正破坏性动作，only-in-worktree 的未提交文件可能丢失。[VS Code manage sessions](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions#archive-sessions)

官方文档没有承诺用 `git worktree lock`，所以 DSH 可以借鉴它的 owner/refcount 语义，但不应假定其内部锁方案。

## 4. GitHub Copilot App 与 cloud agent

### GitHub Copilot App

Copilot App 的官方产品模型是“一 session、一 isolated workspace、一 branch”；可选择 new working tree、local repository 或 cloud sandbox。用户在 Changes 里看 diff、继续迭代，满意后 Create PR；App 还承载 review、CI 与 merge。[GitHub Copilot App sessions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions) [Copilot App overview](https://docs.github.com/en/copilot/concepts/agents/github-copilot-app)

但公开文档没有回答几个关键底层问题：从现有 local folder 启动时是否复制 tracked dirty/普通 untracked、使用 detached 还是 branch-first 的具体命令、dirty worktree 的 archive/delete 行为、retention 数量和 Git lock。设计 DSH 时不能把这些空白补成“行业惯例”。

### GitHub Copilot cloud agent

Cloud agent 不消费本地 checkout，而是让用户选 repository/base branch，在 ephemeral GitHub Actions 环境中工作。prompt task 默认先在新 branch 上工作，用户可看完整 diff、继续 steer，再决定 Create PR；从 issue assignment 启动则直接创建 PR。Agent 只能 push 到它被授予的单个 branch，不能自行批准或 merge。[Start Copilot cloud task](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/kick-off-a-task) [Cloud-agent risk mitigations](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agents/cloud-agent/risks-and-mitigations)

Stop 会终止 Actions run，但保留已经 pushed 的 commits；cloud session 可 archive、不可 delete。这里的耐久媒介是远端 branch/commits 和 session log，而不是本地 worktree 目录。[Manage cloud sessions](https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents)

## 5. 额外参照：Cursor

Cursor 官方描述 local parallel agent 自动创建、管理独立 worktree；Agent 完成后用户点击 Apply 把变化合回 working branch。Cloud agent 则 clone GitHub repo、创建独立 branch、完成后开 PR，再由人 review/merge。[Cursor agent best practices](https://cursor.com/blog/agent-best-practices#native-worktree-support)

公开官方材料没有明确 local worktree 的 dirty inheritance、初始 detached/branch 细节、删除保护、retention、restore 或 active lock。它能证明 `Apply` 是常见的交付 UX，但不足以作为安全生命周期的实现依据。

## 对 `dsh-worktree` 的可执行设计结论

### A. 基线不是一个布尔值，而是可审计的 source spec

建议完整支持：

```ts
type WorkspaceSource =
  | { kind: "commit"; oid: GitOid }
  | {
      kind: "snapshot";
      baseOid: GitOid;
      include: {
        staged: boolean;
        unstaged: boolean;
        untracked: "none" | "selected" | "all";
        ignored: string[];
      };
    };
```

- 默认交互入口可推荐 `commit`，因为最可复现。
- 父 checkout dirty 时不应直接拒绝；应显示 diff summary，让用户选择 committed base、创建 snapshot，或取消。
- snapshot 必须生成 immutable manifest：base OID、path、file type、hash、mode、是否 staged；记录 skipped/failed paths。
- ignored 永远白名单，symlink/junction 默认拒绝或显式确认；secrets 文件必须警告。

### B. 起始形态同时支持 detached 与 session branch

- detached：适合大量试验，不污染 branch namespace；参考 Codex。
- session branch：适合长生命周期、archive/rebuild、push/PR；参考 Claude 与 VS Code。
- 无论哪种，内部都保存 immutable `baseOid`。如果 detached worktree 需要交付、归档或跨进程恢复，应能原子地 materialize 为 `dsh/<task-id>` branch。

不建议 Agent 一开始或结束时自动 commit。提交是可选择的 durability/交付动作，不应替用户决定提交边界和身份。

### C. 做完整 disposition 状态机

不能只实现“clean 删除、dirty 保留”。完整产品应有：

```text
Running
  → Reviewable
      → Continue / Open in editor / Test
      → Apply or Handoff to target checkout
      → Preserve branch → Commit → Push → PR
      → Archive → Restore
      → Discard → Confirm → Delete
```

Apply/Handoff 前必须检查目标 checkout 是否在创建后发生变化，预演冲突，并把冲突作为可恢复状态；不能先删 source worktree。Discard 必须展示将丢失的 tracked/untracked/commits/snapshot，并要求破坏性确认。

### D. 产品所有权不能只依赖 Git lock

插件元数据至少记录：

- worktree/branch/base/snapshot identity
- owner session、linked consumers/refcount
- running、pinned、permanent、archived 状态
- last activity、retention policy、cleanup intent/result
- creation/cleanup crash-recovery journal

运行期间可以额外使用 `git worktree lock --reason ...`，但 Git lock 只是并发清理护栏，不是唯一真相。清理器必须同时校验 plugin ownership、Git identity、真实路径、symlink/junction、dirty/untracked/unpushed commits 和引用计数。

### E. DSH 插件与上游责任边界

插件可以直接完成 Git 生命周期、snapshot、review artifact、apply/handoff、branch/PR adapters、retention 和恢复日志。遇到以下能力缺口，应主动向 DSH 上游提交最小、通用 seam，而不是在插件里绕过：

- 子 Agent/后台任务无法被安全指定 cwd 与 filesystem boundary。
- DSH 工具层无法阻止写回主 checkout 或通过 Git env/redirect 逃逸。
- session 生命周期没有可靠的 start/resume/abort/archive hooks。
- UI 无法表达 durable worktree identity、破坏性确认或恢复入口。

上游改动应保持“通用 execution workspace contract”，不要把 Git-specific 逻辑塞进 DSH 核心；Git worktree 的具体策略仍属于插件。

## 尚未由官方资料回答的问题

- Codex 所说 `uncommitted changes` 是否在所有平台/version 中完整包括 staged、unstaged 和普通 untracked；官方文档只给出部分边界。
- GitHub Copilot App 对 local dirty checkout、cleanup、restore 和 locks 的实际行为。
- VS Code/Codex/Copilot App 是否内部使用 `git worktree lock`；公开契约没有承诺。
- Cursor local Apply 的具体冲突算法、snapshot 与回滚策略。

这些问题应通过受控黑盒测试补齐，并将结果绑定具体版本；在测试完成前不应写进产品兼容性承诺。
