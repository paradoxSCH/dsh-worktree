# 从其他 Agent Harness 规划中吸收的生产耐久性原则

日期：2026-08-14

## 结论

项目目标始终是 DeepSeek Harness 的 `dsh-worktree` 插件。其他 Agent 的 Harness v2 不是依赖、兼容目标或待复制架构；我们只吸收对长期自主运行有价值的工程原则，并把它们落实到插件自己的资源生命周期。

## 映射

| 外部思想 | 在 dsh-worktree 中的落点 | 不做什么 |
|---|---|---|
| 状态分层 | plugin journal 与 DSH conversation log 分离 | 不重写 DSH Session |
| 多工作线 | 每个并发 subagent 使用独立 durable worktree，允许多个显式 owner | 不引入另一套 lane |
| 崩溃零丢失 | Git 副作用前写 operation intent，启动后用 record + 外部事实幂等恢复 | 不承诺整个 DSH 全局零丢失 |
| 上下文尾部增长 | 内部状态不动态改 system prompt，只给模型稳定摘要 | 不改 DSH compaction/KV cache |
| 工具先规划 | add/remove/archive/merge/push 前写自己的 operation plan | 不替换 DSH tool-call planner |
| Abort 可控 | 停止 child、等待 quiescence、补记 run 状态；变更另行处置 | 不把 abort 当 discard/reset |
| 异步任务 | worktree、owner、child 和恢复记录可跨进程存在 | 不实现 deferred LLM provider |
| 逐边界测试 | FakeGit/journal fault injection 驱动每个持久化和副作用边界 | 不泄漏测试 step 到生产 API |

## Durable operation journal

每个 worktree 使用 opaque `worktreeId`，每次生命周期动作使用 `operationId`。典型记录包括：

```text
create_planned
worktree_ready
run_started
run_stopped
integration_planned
retained | handed_off | merged | published | archived | removed
reconciliation_required
```

journal 位于插件 storage domain，session 只关联 parent/child/worktree/artifact id。路径、Git administrative data、rollback 和 recovery diagnostics 不进入模型上下文。

## 可重放和恢复

创建、snapshot replay、archive、restore、handoff、merge、push 和删除都遵循同一规律：

1. 解析并验证输入与当前外部事实；
2. 持久化 operation intent 和幂等 key；
3. 执行副作用；
4. 重新观察 Git、文件系统或 remote；
5. 持久化结果；
6. 只有状态稳定后才向 child/用户发布成功。

崩溃后不猜“运行到第几行”，而是把 durable intent 与 Git/filesystem/remote 事实核对。identity 不匹配时拒绝认领，绝不猜测删除方向。

## Abort 与 finish 分离

`abort` 只停止正在运行的 child：发 cancellation、等待子进程和 writer quiescent、检查 worktree、写 run stopped。它不自动 reset、删除 worktree、删除 branch 或丢弃修改。

之后由显式交付动作处理 continue、branch、handoff、merge、PR、archive 或 discard。dirty 状态永不静默删除。

## 对插件规划的实际影响

- durable journal、crash reconciliation、safe abort、完整 integration 与 archive/restore 是产品组成，不是可靠性补丁；
- one-shot 与 continuable child 都必须使用同一 `WorktreeManager` 和同一 durable cwd；
- 遇到 DSH 生命周期缺口时主动提交通用上游 seam，不复制 driver/continuation manager；
- 测试覆盖每个副作用和持久化边界，以及 Windows junction、Unix symlink 和跨进程恢复；
- 不引入 lane、Pi/Harness v2 record schema、deferred LLM handle 或全局 Session 重写。

这把视角从“给 subagent 换一个目录”提升为“DSH 插件完整拥有隔离工作区及其成果的生命周期”，但产品边界仍然清楚地停留在 DSH worktree 插件内。
