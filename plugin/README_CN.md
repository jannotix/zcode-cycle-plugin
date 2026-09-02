# Cycle for Zcode

Cycle for Zcode 是一个在本地运行、以证据为准入条件的 ZCode 交付插件。它将架构、
实现、功能审查、安全审查和最终裁决分离，并由确定性的 Rust 控制平面管理工作流状态、
候选文件、验证证据和交付。

## 发布状态

- `1.0.2-rc.4` 是尚未发布的生产候选版本。在同一个不可变插件制品完成 Windows/Linux
  发布矩阵之前，不得分发。
- `1.0.2-rc.3` 已被替代：精确 Desktop 探针将原始角色作为 camelCase `agentType`
  传入，该候选版本未进行规范化，不得安装或复用。
- `1.0.2-rc.2` 已被替代：精确 Desktop 原始调度探针发现未受治理的宿主原生 `SubAgent`
  路径，不得安装或复用。
- `1.0.2-rc.1` 因 Desktop 未发现其标准 Hook 文件而被替代，不得安装或复用。
- `1.0.1` 是已被替代且从未发布的候选版本，不得安装或复用：不同候选字节曾使用该身份进行测试。
- `1.0.0` 已撤回，请勿安装。历史标签仅用于审计，不会被移动或重复使用。

## 1.0.2-rc.4 支持范围

| 平台 | 状态 |
|---|---|
| Windows 11 x64 | 认证目标 |
| Linux x64（Ubuntu 22.04、24.04） | 认证目标 |
| macOS x64 / arm64 | 仅在原生构建通过后声明“兼容但未经测试” |
| Windows/Linux ARM64 | 不支持 |

认证会绑定发布凭据中记录的具体 ZCode Desktop 版本。ZCode 升级后，必须重新执行宿主
集成矩阵，原凭据才可更新。

## 安装

生产用户应仅在 `1.0.2` 被接纳并发布后，从 ZCode 官方公共插件市场安装。公共环境中的
角色保护依赖 ZCode 从可信来源加载插件 Hook，因此官方发布是安全门槛。

开发和认证时，请在 Settings -> Plugins -> Create -> Add marketplace 中添加本地目录
市场，选择本仓库并安装 `zcode-cycle`。在每个受治理项目中运行
`/cycle:setup install`，新建 ZCode 会话，再运行 `/cycle:setup` 验证五个受管理角色配置。
主会话负责编排，各角色作为子 Agent 运行。
每次 Cycle 角色调度都必须有唯一的 Cycle 注册；绕过注册直接启动 Agent 会被拒绝。

要求：

- 支持插件的 ZCode Desktop；
- 插件进程可用 Node.js 22 或更高版本；
- Git，以及被治理项目所需的构建和测试工具；
- Windows x64 或受支持的 Linux x64；
- 当变更需要浏览器证据时，系统中有 Chrome、Edge 或 Chromium。

对应平台的 `workflowd` 守护进程包含在经过校验的插件制品中。运行时不会从远程地址
下载或执行二进制文件。

## 插件内容

- 五个显式项目角色配置：架构师、执行器、两名审查者和裁决者；主 ZCode 会话负责编排；
- 斜杠命令和五个工作流 Skill；
- `PreToolUse` 角色保护 Hook 与 `PostToolUse` 审计 Hook；
- 一个本地 stdio MCP 服务；
- 根据锁定的 npm 依赖图构建的自包含 MCP/浏览器桥；
- 平台限定的 `workflowd` 二进制文件、用户文档和法律声明。

## 权限与副作用

Cycle 只有在用户明确启动受治理运行后才会修改项目。

### 文件和 Git

- 普通对话、设置、架构和审查均为只读。
- `/cycle:setup install` 会在当前项目的 `.zcode/agents` 下写入五个受管理文件；修复、
  模型变更和删除必须使用对应的显式命令，且不会覆盖不属于 Cycle 的冲突文件。
- 执行器仅在隔离的 Git worktree 和声明的写入范围内修改文件。
- 执行器可以暂存并提交该 worktree 的变更，但不能委派子 Agent、push、tag、切换分支、
  新建 worktree、重写历史或执行破坏性 Git 清理。
- 控制平面冻结候选文件的精确字节，完成验证后只把获批路径提升到记录的基础修订。
- 导出、可能丢失数据的取消、外部浏览器来源和发布均需要用户明确决定。Cycle 不会绕过
  ZCode 的确认或安全策略。

### 命令执行

控制平面执行已验证计划中声明的验证命令。命令通过参数向量直接启动，而不是交互式
Shell；不安全操作符、被阻止的程序和破坏性形式会被拒绝。命令使用当前操作系统用户的
权限运行。请按 ZCode Terms 的建议在隔离的开发环境中使用，并人工审查高风险操作。

### 网络和浏览器

- Cycle 不包含遥测、账户服务、更新服务或远程后端。
- MCP 桥与守护进程仅通过本地认证管道或 Unix socket 通信。
- 托管浏览器使用隔离的临时配置。默认允许 loopback；任何外部来源都必须明确批准，
  之后浏览器请求会直接访问该已批准来源。
- ZCode 及用户选择的模型/提供商受各自条款和隐私政策约束。Cycle 不读取或保存模型
  凭据。

### 本地数据

工作流状态、防篡改账本、签名密钥、worktree、浏览器证据和项目记忆位于应用安装目录
之外：

| 平台 | 默认目录 |
|---|---|
| Windows | `%LOCALAPPDATA%\ZCode Cycle` |
| Linux | `$XDG_DATA_HOME/zcode-cycle` 或 `~/.local/share/zcode-cycle` |
| macOS | `~/Library/Application Support/ZCode Cycle` |

卸载插件不会删除这些审计数据。只有在完成必要备份并明确决定销毁数据后，才应单独删除
该目录。

## 交付流程

1. `/cycle:run auto|quick|full` 原样捕获用户的下一条请求。
2. 架构师生成与需求关联、范围有限的任务图。
3. 执行器在隔离 worktree 中实现并提交任务。
4. 控制平面冻结候选版本并运行强制 Gate。
5. Full 模式并行调用两名无 Shell 权限的独立审查者。
6. 裁决者根据原始请求、精确候选版本和原始证据作出判断。
7. 只有获批候选版本才会提升。拒绝会进入有上限的修复循环；中断后通过
   `/cycle:resume` 恢复。

更多信息见[用户手册](docs/USER_MANUAL.md)、[命令参考](docs/commands/reference.md)、
[威胁模型](docs/security/threat-model.md)和[发布计划](docs/releases/production-release-plan.md)。

## 更新、回滚和删除

- 已发布版本不可复用。刷新市场后升级到更高的语义版本，运行
  `/cycle:setup repair`，并新建会话。
- 发布认证包含从上一公共版本升级、保留数据的回滚。较新的数据库 Schema 只能按文档
  以安全只读模式打开。
- 卸载前在每个已配置项目运行 `/cycle:setup remove`，然后在 ZCode 中删除插件。只有在
  不再需要账本、记忆、证据和恢复状态时，才单独删除数据目录。

## 开发检查

```text
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features --no-fail-fast
cd mcp && bun install --frozen-lockfile && bun run typecheck && bun run build && bun run test
node tests/qualification/battery.mjs 1
```

公共发布还要求：官方市场验证和构建、两个认证平台各自 20/20 次确定性测试、基于最终
制品的 ZCode 全新安装/运行验证、SBOM/第三方声明/来源证明，以及已签名的 Windows
二进制文件。

## 安全与法律

插件漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。ZCode 宿主本身的漏洞应通过 ZCode
官方私密渠道报告。

Copyright 2026 Gianluca Iannotta。采用 FSL-1.1-MIT 许可；每个已发布版本在发布日期两年
后转为 MIT。详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

Cycle for Zcode 是独立集成，不隶属于 ZCode 或其运营方，也未获得其赞助或背书。ZCode
名称及商标归各自权利人所有。

开发披露：为 `1.0.2-rc.4` 准备的变更包含 AI 辅助生成的代码和文档，发布前必须由项目所有者
进行人工审查。
