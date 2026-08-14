# dsh-worktree

面向 DeepSeek Harness 的独立 Git worktree 插件。每个子代理在受管理的 checkout 中工作，主工作区不会被并发任务直接修改；任务结束后，插件根据精确状态指纹安全清理或保留结果。

这是独立发布仓库，不属于 Harness monorepo。DSH 上游只提供通用的 child `cwd` 扩展接口，Git 快照、worktree、恢复、交付和产品界面均由本仓库维护。

## 当前状态

仓库正在按完整产品范围开发，尚未发布稳定版。当前已实现：

- `fresh`、`head`、`working-state` 三种工作基线；
- staged、unstaged、untracked 状态的无损复制，ignored 文件默认不带入；
- one-shot 与 continuable DSH 子代理 provider；
- durable journal、状态指纹、安全清理、显式 discard token；
- 可注入崩溃边界与启动恢复；
- Windows 上的真实 Git、Cordis 和 provider 测试。

交付动作、管理 CLI、DSH tools、审批边界和 Web UI 仍在实现，因此当前版本标记为 alpha，而不是缩减范围的 MVP。

## DSH 兼容性

插件需要 DSH 的 provider-prepared child `cwd` 接口。对应上游提交为 [`0647d61abf`](https://github.com/paradoxSCH/deepseek-harness/commit/0647d61abf78977cbad4f691d9e7d95763a0fd46)，正在等待进入 DeepSeek Harness 的正式发布版本。

已发布的 DSH `0.1.0-rc.6` 不包含该接口；本仓库会显式拒绝把它列为受支持运行时，避免出现“插件安装成功但子代理仍写入主 checkout”的静默失效。

## 从独立仓库安装

在兼容的 DSH 版本发布后，可直接把 GitHub 仓库安装到任意全局 DSH profile：

```sh
dsh plugin --profile web add github:paradoxSCH/dsh-worktree
dsh plugin --profile headless add github:paradoxSCH/dsh-worktree
```

建议生产环境固定 release tag 或 commit：

```sh
dsh plugin --profile web add github:paradoxSCH/dsh-worktree#<tag-or-commit>
```

验证 Bundle 已加入全局 profile，而不是当前项目：

```sh
dsh --profile web --dump-config
dsh plugin --profile web why dsh-worktree
```

卸载：

```sh
dsh plugin --profile web remove dsh-worktree
```

发布到 npm 后，安装入口将简化为：

```sh
dsh plugin --profile web add dsh-worktree
```

仓库提交预构建的 `lib/`，GitHub 安装不需要执行不受信任的 `prepare` 构建脚本。

## 默认行为

- 默认 source：`working-state`；
- 默认 lifetime：`managed`；
- 默认 provider 名称：`worktree`；
- 状态目录：`$DSH_HOME/plugins/dsh-worktree`；
- ignored 文件不自动复制；
- 子代理有新增变化时自动保留 worktree；
- destructive discard 必须携带最新检查 token 和显式确认。

## 开发

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
