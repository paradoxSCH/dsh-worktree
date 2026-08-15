# dsh-worktree 完整产品规格

> [!NOTE]
> 维护者设计记录，包含历史决策、候选交互和未完成的规划项，不代表当前发布版本的用户能力。实际安装与使用行为以 [README](./README.md) 和当前代码为准。

日期：2026-08-14

## 1. 产品定位

`dsh-worktree` 是 DeepSeek Harness 的 worktree 隔离与交付产品，不是实验性工具，也不按 MVP 删减关键能力。它让 DSH 的主代理和子代理可以在独立 checkout 中并发工作，并让用户从“创建工作区”一直走到“审阅、验证、合并或归档”。

它始终作为外部 Bundle 全局安装和独立发布。若实现完整能力时发现 DSH 缺少通用 extension seam，项目应立即准备并提交上游改动；插件本身不 fork DSH，也不长期复制 DSH 的 session、continuation 或 driver 生命周期。

## 2. 其他 Agent 通常怎样处理基线

主流实现并不是同一种策略：

| 产品 | 默认起点 | parent 有未提交改动时 | ignored 文件 |
|---|---|---|---|
| Claude Code | `fresh` 默认从远端默认分支；也可用当前 committed `HEAD` | 不继承 tracked/untracked 未提交改动 | `.worktreeinclude` 只复制同时被 ignore 且命中 allowlist 的文件 |
| OpenAI Codex | 用户选择起始分支，managed worktree 默认 detached HEAD | 可以把当前分支的未提交改动应用到新 worktree | `.worktreeinclude`，跳过 symlink 且不覆盖目标 |
| VS Code/Copilot | 从选定分支的 committed state 建新分支和 worktree | 明确不继承；建议先 commit，或改用 folder isolation | `git.worktreeIncludeFiles` 复制指定 ignored 文件 |
| GitHub/Cursor 云端 Agent | 从远端 base branch 工作 | 本地 dirty 状态不在其执行环境中 | 依产品环境准备策略 |
| 原生 Git | 从 commit/ref 建 worktree | Git 本身不负责迁移另一个 checkout 的脏状态 | 由调用方实现 |

因此，“多数产品”的保守默认是 committed state；Codex 是把脏工作状态迁移到隔离工作区的成熟先例。DSH 的典型用途是让子代理继续父代理正在进行的工作，所以本产品必须完整支持两类工作流，而不是只押一个默认。

## 3. 三种 source mode

### `fresh`

从远端默认分支的最新 commit 创建。适合独立任务、批量探索和避免继承本地上下文。fetch 失败时必须明确报告，不得悄悄改用不等价的旧基线，除非用户配置了 fallback。

### `head`

从当前 checkout 的 committed HEAD 或用户选择的 ref 创建。适合复现当前 feature branch 的已提交状态。

### `working-state`

从当前 HEAD 创建后，重建 parent 的 staged、unstaged 和非 ignored untracked 状态。它不是简单复制整个目录：

- 记录源 commit、index patch、working-tree patch 和 untracked manifest；
- 保留 staged/unstaged 区别；
- 检测二进制、大文件、rename、文件模式、submodule 和 LFS；
- ignored 文件只通过 `.worktreeinclude`/配置 allowlist 复制；
- symlink/junction、敏感文件和超限内容需要策略判断并在预览中显示；
- snapshot 具有内容摘要，能够审计、重放和崩溃恢复；
- 创建期间 parent 继续变化时，报告 snapshot boundary，而不是声称复制了“现在”的状态。

推荐默认：parent 干净时使用 `head`；parent 脏且调用来自当前对话的子代理时使用 `working-state`，同时显示将继承的 staged/unstaged/untracked 数量。独立后台任务可显式使用 `fresh`。

## 4. 生命周期模式

| 模式 | 用途 | 完成后的默认行为 |
|---|---|---|
| `ephemeral` | 探索、只读分析、预期不产生结果 | clean 自动移除；dirty 转为 managed，绝不静默删除 |
| `managed` | 默认子代理任务 | 由 DSH 管理、可继续、可审阅、可归档；达到保留策略时先做可恢复快照 |
| `permanent` | 长期功能分支、多个对话共享 | 不自动回收，用户显式完成或删除 |

managed worktree 默认使用 detached HEAD，避免为每次探索污染分支命名空间；需要保留或发布时再创建可读分支。产品同时允许组织策略选择“创建时即分支”，以兼容 Claude Code/VS Code 风格和持续推送工作流。

## 5. 其他 Agent 通常怎样交付结果

- Claude Code 创建分支承载 worktree；clean 任务可自动清理，dirty/untracked/new commits 会提示保留或删除，改变过的子代理 worktree 会留在磁盘。
- Codex managed worktree 默认 detached HEAD；用户可“Create branch here”，或 handoff 到本地 checkout；自动清理前保存 snapshot，重新打开可恢复。
- VS Code 提供 Changes/Files 审阅与 Commit；归档时会提交未提交改动、移除 worktree，但保留 branch/commits，恢复时重建 worktree。
- 远程 coding agent 通常以远端分支和 Pull Request 作为交付边界。

完整产品应吸收这些已验证的交互，而不是强制所有任务自动 commit 或自动 merge。

## 6. 完整交付动作

任务停止只代表 agent 不再执行，不代表变更应被删除。每个 changed worktree 都提供：

- `continue`：在同一 durable child/session 和 worktree 继续；
- `review`：按所有变更、当前分支差异、未提交变更、最近一次 run 查看文件与 diff，并运行验证；
- `create-branch`：从 detached HEAD 创建经校验的分支；
- `handoff`：把任务和变更安全移到指定本地 checkout；目标脏或存在冲突时先预检并停止；
- `merge`：显式批准后合入目标分支，支持 merge、squash、rebase policy，并完整处理冲突；
- `pull-request`：commit、push 并创建 PR；凭据、remote 和 host provider 都要显式可见；
- `archive`：创建内部 preservation ref/snapshot，移除磁盘 worktree，之后可恢复；
- `discard`：仅在没有 live owner、identity 复核通过、携带最新 `changeToken` 且用户明确确认时删除。

内部 crash checkpoint 可以使用隐藏 ref 或对象快照，但不能伪装成用户 commit，也不能自动推送。所有会改写目标 branch、remote 或用户 checkout 的动作必须先给出预检结果和影响范围。

## 7. 用户体验

### Agent 工具

- `subagent_worktree`：创建并运行隔离子代理；支持 foreground/background/continuable。
- `worktree_list`、`worktree_status`、`worktree_diff`：发现和检查任务。
- `worktree_continue`、`worktree_validate`：继续任务和运行项目验证。
- `worktree_integrate`：branch/handoff/merge/PR/archive/discard 的统一受控入口。
- `worktree_recover`、`worktree_doctor`：恢复异常记录和诊断 Git/DSH 环境。

模型不能直接提供任意目标路径、Git flags 或 destructive shell。工具接受语义化意图，core 生成并校验命令。

### Web UI/TUI

- worktree/session/owner 列表和状态筛选；
- source mode、base commit、snapshot 内容和风险预览；
- Files/Changes、diff 范围切换、验证结果和 agent 摘要；
- continue、branch、handoff、merge、PR、archive、restore、discard；
- 冲突解决入口、recovery-needed 诊断和磁盘保留策略；
- Windows 路径、junction、长路径与锁状态可视化。

## 8. 全局安装与运维

- 通过 DSH 全局 Bundle/profile 安装，不写入被处理项目的依赖或配置；
- 配置和 durable data 位于 DSH home，managed worktree 位于受管根目录；
- 支持安装、升级、回滚、诊断、卸载；卸载 Bundle 不删除 retained/archived 用户成果；
- CI 同时验证最新 DSH release candidate 与 DSH main，尽早发现 seam 变化；
- GitHub、GitLab 等 PR provider 为可选集成，但 branch/handoff/archive 不依赖云服务。

## 9. 需要用户拍板的只剩默认偏好

完整能力本身不再需要取舍。建议直接采用以下默认值：

1. 当前对话的 parent 脏时默认 `working-state`，干净时默认 `head`；独立任务显式用 `fresh`。
2. 默认 managed + detached HEAD；产生成果后让用户选择 branch/handoff/merge/PR/archive。
3. clean ephemeral 自动移除；任何 dirty 状态都不静默删除。
4. ignored 内容仅 allowlist；不自动复制 `.env`、凭据或整个依赖目录。
5. 插件缺 DSH seam 时主动向上游提交，而不是降低产品功能或 fork 生命周期。

除非用户想改变这些默认值，工程实现可以直接按此推进。

## 10. 资料

- [Git worktree 官方文档](https://git-scm.com/docs/git-worktree.html)
- [Claude Code worktree 文档](https://code.claude.com/docs/en/worktrees)
- [Claude Code worktree path confusion 安全公告](https://github.com/anthropics/claude-code/security/advisories/GHSA-7835-87q9-rgvv)
- [OpenAI Codex worktree 文档](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [VS Code agent harness worktree 文档](https://code.visualstudio.com/docs/agents/run/agent-harnesses)
- [VS Code agent sessions 管理](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions)
- [VS Code Agents window](https://code.visualstudio.com/docs/agents/run/agents-window)
