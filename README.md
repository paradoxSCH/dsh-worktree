# dsh-worktree

面向 DeepSeek Harness 的独立、可全局安装的 Git worktree 产品。每个 one-shot 或 continuable 子代理在受管理的 checkout 中工作；主工作区不会被并发任务直接修改。任务结束后可在同一套持久化状态上审阅、验证、提交、交付、归档或恢复。

本项目是独立发布仓库，不属于 Harness monorepo。DSH 上游只提供通用 child `cwd` seam；Git snapshot、锁、journal、恢复、交付策略、工具、命令和 Web dashboard 全部由本仓库维护。

## 产品能力

- `fresh`、`head`、`working-state` 三种 source mode；
- staged、unstaged、untracked 状态无损重建；ignored 内容只按 `.worktreeinclude`/配置 allowlist 带入，敏感文件需要显式放行；
- managed detached HEAD、ephemeral、permanent 三种 lifetime；
- `subagent_worktree`：foreground、background、continuable 共用的隔离子代理入口；
- durable JSONL journal、跨进程锁、每仓库 topology lock、多 owner lease、启动 reconciliation；
- 每个外部副作用前先写 plan，并覆盖 create、commit、branch、handoff、merge、push、PR、archive、restore、discard 的崩溃恢复；
- review diff、验证命令、change token、Git identity 与路径复核；
- `worktree_*` 模型工具、`/worktree` 命令和 loopback-only Web dashboard；
- dashboard 展示状态、owner、diff、doctor，并提供 commit/branch/handoff/merge/push/PR/archive/restore/discard；
- GitHub CLI PR provider；没有 `gh` 或凭据时 branch、handoff、archive 等本地能力仍可用；
- Windows、Linux、macOS CI，真实 Git 仓库与 bare remote 测试。

当前版本仍标记为 alpha，原因是所需 child `cwd` seam 尚未进入正式 DSH release，而不是因为插件只实现了 MVP。

## DSH 兼容性

插件要求 provider-prepared child `cwd` 接口。对应实现提交是 [`0647d61abf`](https://github.com/paradoxSCH/deepseek-harness/commit/0647d61abf78977cbad4f691d9e7d95763a0fd46)，分支为 [`feat/child-cwd-seam`](https://github.com/paradoxSCH/deepseek-harness/tree/feat/child-cwd-seam)。

已发布的 DSH `0.1.0-rc.6` 不包含该接口，所以 peer range 从 `rc.7` 开始。这样安装器会明确报告不兼容，不会出现“插件装上了但 child 仍写主 checkout”的静默失败。

## 全局安装

插件安装到 DSH profile，不写入任何被处理项目的 `package.json`。

从独立 GitHub 仓库安装：

```sh
dsh plugin --profile web add github:paradoxSCH/dsh-worktree
dsh plugin --profile headless add github:paradoxSCH/dsh-worktree
```

生产环境建议固定 release tag 或 commit：

```sh
dsh plugin --profile web add github:paradoxSCH/dsh-worktree#<tag-or-commit>
```

npm package 发布后：

```sh
dsh plugin --profile web add @paradoxsch/dsh-worktree
```

验证全局 Bundle：

```sh
dsh --profile web --dump-config
dsh plugin --profile web why @paradoxsch/dsh-worktree
```

卸载只移除 Bundle，不删除 retained/archived 成果：

```sh
dsh plugin --profile web remove @paradoxsch/dsh-worktree
```

仓库提交预构建 `lib/`，从 GitHub 安装不需要执行 `prepare` 构建脚本。

## 使用

委派隔离任务时使用 `subagent_worktree`。管理工具包括：

- `worktree_create`、`worktree_list`、`worktree_inspect`；
- `worktree_review`、`worktree_validate`；
- `worktree_act`：commit、branch、handoff、merge、push、PR、archive、restore、discard；
- `worktree_recover`、`worktree_doctor`。

人工命令统一从 `/worktree` 进入，例如：

```text
/worktree list
/worktree review <id>
/worktree commit <id> <message>
/worktree branch <id> <branch>
/worktree doctor
```

Web profile 的 sidebar footer 会出现 `Worktrees`，打开后可查看并操作同一份 durable projection。

## 默认与安全边界

- source：`working-state`；lifetime：`managed`；provider：`worktree`；
- durable data：`$DSH_HOME/plugins/dsh-worktree`；
- managed checkout 默认 detached HEAD 并保持 Git lock；
- dirty worktree 不静默删除；discard 需要最新 `changeToken`、无 active owner 和明确确认；
- ignored 文件默认不复制；`.env`、密钥、证书等即使命中 allowlist 也需要额外允许；
- 模型工具不接受原始 Git flags；handoff/merge 目标必须是同仓库、identity 通过且满足 clean/base 条件；
- dashboard 的 host API 只接受 loopback、same-origin 请求；
- Git 子进程清除 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE` 等重定向环境变量；
- worktree 是写冲突隔离，不替代 DSH sandbox。`workspace-write` 会以 child session 的 worktree cwd 作为可写根。

## 开发与验证

```sh
pnpm install
pnpm run check
pnpm run pack:check
```

主要文档：

- [完整产品规格](./PRODUCT_SPEC.md)
- [技术设计](./DESIGN.md)
- [其他 Agent 的 worktree 行为研究](./OTHER_AGENT_WORKTREE_RESEARCH.md)
- [长时间运行 Agent 的耐久性原则](./PRODUCTION_LESSONS.md)

## License

MIT
