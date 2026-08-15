# dsh-worktree 技术设计

> [!NOTE]
> 维护者技术记录，保留设计演进和目标架构，其中部分接口或生命周期尚未实现。用户安装与操作请以 [README](./README.md) 为准。

日期：2026-08-14  
目标宿主：DeepSeek Harness `0.1.0-rc.6` / 源码基线 `47f943859bef60e4160492346772ded9b24f765a`

## 1. 设计结论

`dsh-worktree` 是拥有完整生命周期的深模块。外部调用者只表达“从什么状态创建、让哪个 agent 工作、怎样交付结果”；Git identity、路径安全、脏状态快照、锁、并发、journal、恢复、清理、分支和归档均由模块内部拥有。

产品仍是 DSH 插件，不重写 Session、lane、LLM provider 或整个 Harness。其他 Agent 引擎的计划只提供生产耐久性原则，见 [PRODUCTION_LESSONS.md](./PRODUCTION_LESSONS.md)。完整产品行为见 [PRODUCT_SPEC.md](./PRODUCT_SPEC.md)。

## 2. 模块边界

```text
@dsh-worktree/core
  WorktreeManager
    ├─ GitCliAdapter / FakeGitAdapter
    ├─ SourceSnapshotter
    ├─ DurableOperationStore
    ├─ ManagedPathGuard
    ├─ IntegrationEngine
    └─ Reconciler

@dsh-worktree/subagent
  one-shot provider
  continuable child environment provider

@dsh-worktree/tools
  create/run/list/status/diff/continue/validate/integrate/recover/doctor

@dsh-worktree/client
  dashboard、diff/review、validation、integration、recovery

@dsh-worktree/bundle
  全局 DSH Bundle、配置迁移、安装诊断
```

Git CLI 和测试 fake 是可替换 adapter。storage、path guard、snapshot、recovery 和 integration policy 是 core 内部知识，不泄漏为一组浅接口。

## 3. 核心接口

```ts
type WorktreeId = Branded<string, 'WorktreeId'>

interface WorktreeManager {
  create(request: CreateWorktreeRequest): Promise<WorktreeView>
  inspect(id: WorktreeId): Promise<WorktreeView>
  diff(request: DiffRequest): Promise<ChangeSet>
  continue(request: ContinueRequest): Promise<RunView>
  validate(request: ValidateRequest): Promise<ValidationView>
  integrate(request: IntegrationRequest): Promise<IntegrationResult>
  archive(request: ArchiveRequest): Promise<ArchiveView>
  restore(request: RestoreRequest): Promise<WorktreeView>
  discard(request: DiscardRequest): Promise<void>
  list(filter?: WorktreeFilter): Promise<readonly WorktreeView[]>
  reconcile(): Promise<ReconciliationReport>
}
```

`CreateWorktreeRequest` 使用封闭的 source/lifetime policy，不接受任意 Git flags 或任意管理路径：

```ts
type SourcePolicy =
  | { kind: 'fresh'; remote?: string; ref?: string; fallback: 'fail' | 'head' }
  | { kind: 'head'; ref?: string }
  | { kind: 'working-state'; includeIgnored: 'allowlist' }

type LifetimePolicy = 'ephemeral' | 'managed' | 'permanent'
```

`IntegrationRequest` 是 `create-branch | handoff | merge | pull-request | archive` 的 tagged union；不同动作必须提供各自的预检 token。discard 单独暴露，以保持 destructive 语义醒目。

## 4. DSH 现有 seam 与主动上游策略

DSH 已提供：

- `ctx.subagents.registerProvider()` 注册 one-shot provider；
- in-process driver 的 child/session/cancel/result/dispose 语义；
- tool-subagent 把固定 provider 暴露为模型工具；
- durable session header `cwd`，文件、shell、LSP 和 sandbox 都可围绕 child cwd 工作；
- Cordis effect 负责 provider、工具和后台注册的卸载。

当前源码确认的缺口：

1. `startInProcessRun()` 只接受 `seed`，`childSessionMeta()` 固定继承 parent cwd；one-shot 需要受校验的 `InProcessRunOptions.cwd` 或通用 prepared environment。
2. `ContinuableCreateSpec` 只有 `seed`；continuation manager 需要在首次创建 session header 前等待异步环境准备，并在冷恢复时采用已持久化环境，而不是新建第二个 worktree。
3. retained worktree 与 durable child 的 ownership/finish 通知需要稳定的扩展点；插件卸载不等于资源 finish。
4. 若现有 sandbox 只能依赖 child cwd 而不能阻止绝对路径、`git -C` 或 Git 环境变量绕回 parent，需要通用的 protected-checkout policy seam。

处理规则：

- 一旦缺口阻塞完整功能，立即在 DSH 仓库提交最小、通用 seam，附单元测试、REAL-composition 测试、文档和 Agent Note；
- 上游接口使用 environment/cwd/ownership/protected-root 的通用语义，不嵌入 `dsh-worktree` 产品策略；
- 插件仓库同时兼容已发布 rc 与 DSH main；上游尚未发布时允许 CI 使用 commit pin，但不复制 continuation manager 或 driver；
- 上游 PR 与插件实现并行推进；若 PR 未合入，产品明确标注所需 DSH commit，不用降级的半产品冒充完整支持。

建议上游接口：

```ts
interface PreparedChildEnvironment {
  readonly cwd: string
  readonly kind: string
  readonly durableId: string
  readonly protectedRoots?: readonly string[]
}

interface ChildEnvironmentProvider {
  prepare(input: PrepareChildInput): Promise<PreparedChildEnvironment>
  reopen(input: ReopenChildInput): Promise<PreparedChildEnvironment>
  finish(input: FinishChildInput): Promise<void>
}
```

DSH 只负责在 commit child meta 前调用、持久化引用并在恢复时回调；worktree 的 Git 语义仍在插件内。

## 5. 创建事务与 working-state snapshot

创建不是单个命令，而是幂等事务：

1. 解析 source top-level、common dir、HEAD、remote/ref 和 repo capabilities。
2. 生成 opaque `operationId`、`worktreeId` 和托管路径；写 `create_planned`。
3. 若为 `working-state`，在明确的 snapshot boundary 采集 index patch、worktree patch、untracked manifest、允许的 ignored 文件和内容摘要。
4. 执行 `git worktree add --detach --lock --reason dsh:<id>`；生产解析使用 `git worktree list --porcelain -z`。
5. 重新验证 top-level、common dir、HEAD、managed root、symlink/junction 和 main checkout 隔离。
6. 重放 snapshot，逐类验证 staged、unstaged、untracked、file mode、binary、LFS 和 submodule 状态。
7. 写 `worktree_ready`，之后才允许 child 发布和写入。

任何步骤失败都执行有记录的补偿。补偿失败时保留 recovery record 和真实外部状态，不谎报“从未创建”。

## 6. Durable journal 与状态机

关键记录：

```text
create_planned → worktree_ready → run_active
run_active → run_stopped → changed | clean
changed → integration_planned → retained | handed_off | merged | published | archived
clean → removed | retained
archive_planned → archived → restore_planned → worktree_ready
任何状态 → reconciliation_required
```

每个外部副作用先写 intent，再执行，再写观察结果。journal 与 DSH conversation log 分离，只在 session 中保存 owner id、child id、worktree id 和用户可见 artifact。

`abort` 仅停止 child 并等待 quiescence，不等于 discard。模型停止、DSH 退出、插件卸载、机器崩溃都不能导致 dirty worktree 静默消失。

启动 reconciliation：

- durable records 与 `git worktree list --porcelain -z` 双向核对；
- 只有 record、lock reason、canonical path 和 Git identity 一致才认领资源；
- planned 且外部事实已完成时补写完成记录；外部事实未发生时安全重试；
- dirty stale worktree 转 retained/recovery-needed；未知目录和 identity mismatch 只报告、不删除；
- archive/restore、handoff、merge、push 同样具有幂等恢复规则。

## 7. 生命周期与结果整合

managed detached worktree 是默认，但支持 branch-backed permanent worktree。clean ephemeral 可自动删除；其他资源根据保留策略归档而不是直接丢弃。

integration engine 负责：

- branch：校验 ref 名、已有 branch、worktree checkout ownership；
- handoff：检查目标 checkout identity、dirty state、base relationship 和冲突，迁移后重验文件与 index；
- merge/rebase/squash：预检 target、upstream、测试状态和冲突，执行前持久化操作计划；
- PR：生成用户 commit、push 到显式 remote、通过 host provider 建 PR；失败可从已持久化 remote ref 继续；
- archive：保存 preservation ref/snapshot、元数据和 validation results，删除 worktree folder，恢复时重建；
- discard：要求没有 live owner、最新 `changeToken`、明确 confirmation，并在删除前再次复核 identity。

不允许模型通过字符串拼接任意 Git 命令。merge、push、删除和修改用户 checkout 都必须在 UI/工具结果中显示具体影响。

## 8. ignored 文件、依赖和 setup

完整支持兼容 `.worktreeinclude` 的 allowlist：

- 只复制同时被 Git ignore 且命中规则的普通文件；
- 跳过 symlink/junction，不覆盖目标已有文件；
- 单文件、总字节数、文件数量和敏感路径设限；
- `.env`、证书、token 等在预览中标风险，内容不进入 session/journal；
- 默认不复制整个 `node_modules` 或构建缓存，允许组织明确配置受控缓存策略。

项目 setup 是独立生命周期：检测 package manager、执行用户/组织配置的 bootstrap、具有审批、超时、日志脱敏、取消和缓存。`create()` 不偷偷执行仓库脚本。

## 9. 路径与安全不变量

worktree 是写冲突隔离，不是 OS 安全沙箱；child 仍受 DSH sandbox/approval policy 约束。

- managed root 位于 DSH home 下，不位于被分析仓库；路径只使用随机 opaque id；
- 所有 destructive 动作使用已验证绝对路径，执行前重验 real path、Git identity 和 ownership；
- 拒绝 `.git` 名、空/相对/根路径、main checkout、managed root 外目标和 symlink/junction escape；
- 清理 link 只 unlink，不对未复核 target 递归删除；
- Git 子进程清除 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、object directory 等重定向变量；
- 防止 `git -C`、环境变量、绝对路径和工具 API 绕回 parent checkout；Windows 额外验证 junction、盘符、大小写和长路径；
- lock 只帮助并发协调，不单独作为 ownership 证据。

这些要求直接覆盖 Claude Code 公开过的 worktree path-confusion 类攻击面。

## 10. 并发与 ownership

- 每个 repo 的 topology mutation 串行化，不同 repo 可并行；diff/validation 等只读操作可并发；
- worktree 可以有多个明确 owner（例如同一 session 的 peer chats），使用引用计数与 durable owner records；
- active run 持 execution lease，archive/discard/merge 必须等待所有 writer quiescent；
- continuation 跨 DSH activation 存在，不能把 Cordis activation dispose 当成资源 finish；
- branch checkout exclusivity、submodule worktree 限制和 Git 锁冲突转成结构化错误。

## 11. UI 与可观测性

core 产出稳定 projection，模型工具、Web UI 和 TUI 共用，不各自解析 porcelain。

展示：owner/session/run、source/base/snapshot、HEAD/branch、tracked/untracked、新 commit、validation、磁盘占用、locks、archive 和 recovery 状态。所有操作具有 operation id、时间线、可重试状态和脱敏诊断包。

diff 支持 base branch、全部变更、未提交、最近 run；二进制和超大文件只显示元数据。验证命令输出限流、可取消并持久化摘要。

## 12. 完整测试门槛

### Core/FakeGit 边界测试

- 每个 journal write、Git side effect、identity check、snapshot replay、integration 和 cleanup 边界注入崩溃；
- create/continue/abort/archive/restore/handoff/merge/PR/discard 的幂等重放；
- concurrent create、同 repo mutation、multi-owner、stale locks；
- staged/unstaged/untracked/ignored/binary/rename/file-mode/LFS/submodule/sparse checkout；
- path canonicalization、`.git`、Git env 清洗、Windows junction/drive/case/long path、Unix symlink；
- clean/dirty/new commit/detached/branch-backed/prunable/identity mismatch。

### DSH REAL-composition

- Loader 启动隔离的全局 profile，Bundle/provider/tools/client 全部出现；
- one-shot、background、continuable 首次创建和冷恢复都保持 durable cwd；
- child 不能修改 parent checkout，sandbox root 与 child cwd 一致；
- abort 后 worktree 可继续，dirty 不删除，clean ephemeral 可删除；
- 卸载 Bundle 不删除 retained/archived 成果；
- session 恢复、并发子代理、UI 操作和 tool 操作看到同一 projection；
- 无 API key 的 replay/snapshot 为必测，有 key 的端到端为补充。

### 跨平台与真实仓库

Windows、Linux、macOS CI；含 monorepo、多 worktree、submodule、LFS、Git hooks、不同默认分支和 GitHub/GitLab remote fixture。安装测试必须从全局 Bundle 运行，不依赖项目局部安装。

## 13. 发布完成标准

产品完成意味着：上述三种 source、三种 lifetime、完整交付动作、continuable 恢复、UI、global install、crash recovery、安全门槛和跨平台测试一起达到可发布质量。可以用内部里程碑安排工程顺序，但不得把范围缩成对外的半产品，也不得因为缺 DSH seam 而删除需求。

## 14. 资料

- [Git worktree 官方文档](https://git-scm.com/docs/git-worktree.html)
- [Claude Code worktree 文档](https://code.claude.com/docs/en/worktrees)
- [Claude Code worktree 安全公告](https://github.com/anthropics/claude-code/security/advisories/GHSA-7835-87q9-rgvv)
- [OpenAI Codex worktree 文档](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [VS Code agent harness worktree 文档](https://code.visualstudio.com/docs/agents/run/agent-harnesses)
- [DSH architecture](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/architecture.md)
- [DSH subagent types](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/types.ts)
- [DSH in-process driver](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent-in-process-driver/src/index.ts)
