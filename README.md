# dsh-worktree

为 DeepSeek Harness（DSH）子代理提供隔离的 Git worktree。并行任务在独立 checkout 中工作，不直接修改主工作区；任务结束后可以审阅、验证、提交、交付、归档或恢复结果。

> [!IMPORTANT]
> 当前 alpha 版本要求 DSH `0.1.0-rc.7` 或更高版本。已发布的 DSH `0.1.0-rc.6` 缺少插件所需的 child working-directory 接口，无法安全使用本插件。

## 安装

插件安装到全局 DSH profile，不会修改业务项目的 `package.json`。

Web profile：

```sh
dsh plugin --profile web add @paradoxsch/dsh-worktree@alpha
```

Headless profile：

```sh
dsh plugin --profile headless add @paradoxsch/dsh-worktree@alpha
```

检查是否安装成功：

```sh
dsh plugin --profile web why @paradoxsch/dsh-worktree
dsh --profile web --dump-config
```

## 第一次使用

让 Agent 使用 `subagent_worktree` 委派任务，子代理会自动进入独立 worktree。Web profile 的侧边栏底部会出现 **Worktrees**，可以在其中查看状态、diff 和可用操作。

也可以使用 `/worktree` 命令手动管理：

```text
/worktree list
/worktree create working-state managed
/worktree review <id>
/worktree validate <id>
/worktree doctor
```

不带子命令的 `/worktree` 等同于 `/worktree list`。`<id>` 来自 list/create 的返回结果。

## 选择任务起点

| 模式 | 子代理从哪里开始 | 适合场景 |
| --- | --- | --- |
| `working-state` | 当前 HEAD，加上 staged、unstaged 和非 ignored 的 untracked 变更 | 继续当前正在进行的工作；默认值 |
| `head` | 当前已提交的 HEAD | 不希望继承未提交修改 |
| `fresh` | 远端最新基线 | 与本地当前分支无关的独立任务 |

ignored 文件默认不会复制。确实需要的普通 ignored 文件可以写入仓库根目录的 `.worktreeinclude`；`.env`、密钥和证书等敏感内容即使列在其中也不会复制，请通过 DSH credentials 或运行环境提供。

## 选择保留方式

| 模式 | 任务结束后的行为 |
| --- | --- |
| `ephemeral` | 用于一次性任务；clean checkout 自动移除，有修改时仍会保留 |
| `managed` | 默认值；clean checkout 可自动移除，有修改的结果保留供审阅和交付 |
| `permanent` | 长期保留，直到用户明确处理 |

managed worktree 默认处于 detached HEAD。需要推送或创建 Pull Request 时，先使用 `branch` 创建分支。

## 审阅和交付

| 操作 | 结果 |
| --- | --- |
| `review` | 查看相对任务基线的 diff 和 untracked 文件，不修改仓库 |
| `validate` | 在 worktree 中运行管理员配置的验证命令 |
| `commit` | 提交 worktree 当前修改 |
| `branch` | 为 detached worktree 创建分支 |
| `handoff` | 将 commits、staged、unstaged 和 untracked 状态交付到当前会话 checkout |
| `merge` | 将已提交结果以 non-fast-forward merge 合入当前会话的 clean 分支 |
| `push` | 将当前分支非强制推送到 `origin` |
| `pr` | 推送当前分支并通过 GitHub CLI 创建或复用 Pull Request |
| `archive` | 保存可恢复结果并释放 checkout 占用的磁盘空间 |
| `restore` | 从 archive 恢复 worktree |
| `discard` | 永久删除未交付结果，需要明确确认 |

常用命令：

```text
/worktree commit <id> <message>
/worktree branch <id> <branch-name>
/worktree handoff <id>
/worktree merge <id>
/worktree push <id>
/worktree pr <id> <title>
/worktree archive <id>
/worktree restore <id>
/worktree discard <id> confirm
```

`handoff` 和 `merge` 的目标是运行命令时当前 DSH 会话的 checkout。目标不属于同一仓库、存在未提交修改或不满足安全条件时，操作会停止并报告原因。

创建 Pull Request 需要已登录的 GitHub CLI：

```sh
gh auth status
```

没有 `gh` 不影响本地创建、审阅、commit、branch、handoff、merge、archive 和 restore。

## 安全与恢复

- 有修改的 worktree 不会被自动丢弃。
- 删除、合并、提交、推送和 Pull Request 等操作会在执行前重新检查 worktree 状态。
- ignored 文件和常见敏感文件默认不进入新 worktree。
- `push` 不使用 force；`merge` 要求目标 checkout clean。
- worktree 解决并行写冲突，但不替代 DSH sandbox 或审批策略。
- 默认持久化数据位于 `$DSH_HOME/plugins/dsh-worktree`。

诊断环境和记录：

```text
/worktree doctor
```

进程崩溃或操作中断后重新核对 Git 与持久化状态：

```text
/worktree recover
```

如果 recover 返回 `manual` 项目，请在继续 merge、discard 或删除磁盘目录前处理报告中的 identity/path 问题。

## 卸载

```sh
dsh plugin --profile web remove @paradoxsch/dsh-worktree
dsh plugin --profile headless remove @paradoxsch/dsh-worktree
```

卸载 Bundle 不会删除 retained 或 archived 结果。确认不再需要这些结果后，再单独处理 `$DSH_HOME/plugins/dsh-worktree` 中的数据。

## License

MIT
