# dsh-worktree

面向 DeepSeek Harness 的完整 Git worktree 子代理产品。它保持为独立、可全局安装的 DSH Bundle；当 DSH 缺少通用扩展缝时，插件项目负责主动向上游提交最小、可复用、带测试和文档的改动，而不是复制或 monkey patch DSH 生命周期代码。

产品不是“运行几条 `git worktree` 命令”的薄封装。它覆盖：

- `fresh`、`head`、`working-state` 三种工作基线；
- one-shot、可继续子代理和多并发任务；
- managed、ephemeral、permanent 三种生命周期；
- 变更审阅、继续工作、创建分支、handoff、merge、PR、归档恢复和安全丢弃；
- durable journal、崩溃恢复、路径防护、Windows/Linux/macOS 和完整 UI；
- 全局安装、升级、诊断和卸载。

文档：

- [PRODUCT_SPEC.md](./PRODUCT_SPEC.md)：产品行为、竞品对照和默认策略。
- [DESIGN.md](./DESIGN.md)：技术架构、状态机、DSH 集成和测试门槛。
- [OTHER_AGENT_WORKTREE_RESEARCH.md](./OTHER_AGENT_WORKTREE_RESEARCH.md)：其他 Agent 的官方行为核验。
- [PRODUCTION_LESSONS.md](./PRODUCTION_LESSONS.md)：从长期运行 Agent 引擎吸收、但不照搬的耐久性原则。

