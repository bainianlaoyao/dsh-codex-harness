# dsh-codex-mode

轻量的 DeepSeek Harness 编码预设。它借用 Codex 常用的工具名称和编辑工作流，但不复刻 Codex 的运行时上下文、审批策略或压缩器。

## 提供内容

- `exec_command` / `write_stdin`：DSH shell 适配器，保留长命令轮询和输出截断体验。
- `apply_patch`：自由格式补丁编辑器；这是首选文件编辑工具。
- `win32-atomic-write-fallback`：Windows host 行。ReFS / 无 WRITE_DAC 的 ACL 上，官方原子写的 `SetFileSecurityW` 会 EACCES；此行回退到 `rename`，`apply_patch` / `write` / `edit` 才能落盘。
- `view_image`：本地图片查看。
- DSH 原生工具：计划 `todo_write`、提问 `ask_user_question`、子代理 `subagent` / `subagent_fork`（+ `send_message` / `interrupt_agent` / `list_agents`）、`web_search`。
- OpenAI Chat Completions 和 Responses API 路由。
- `codex 工具模式` 预设：简短编码提示，`AGENTS.md` 指令加载，以及上述工具行。
- `codex 创造模式` 预设：同一套 Codex 工具面，再叠官方创造模式（`cordis`）能力：`tool-cordis`、composition/plugin 技能、计划模式、目标、工作流与 ralph。

DSH 自己继续处理工作目录、运行时上下文、沙箱、审批、压缩和宿主工具。预设只
替换工具面（codex 形状的终端与补丁工具），计划/提问/子代理等协作工具一律使用
DSH 原生实现；不会注入 Codex 格式的 `<environment_context>` 或
`<current_time_reminder>`。`codex 创造模式` 会再挂一份 `tool-cordis`；host
行 `share-cordis-inspect` 让它与官方创造模式共用全局 inspect provider，避免
`Service is already registered`。

## 安装

```sh
dsh plugin --profile web add file:D:/Data/DEV/dsh/dsh-codex-mode
# 或发布后：
# dsh plugin --profile web add dsh-codex-mode
```

重启 DSH 后，host 行 `codex-preset-publisher` 会把包内
`agent-presets/codex` 和 `agent-presets/codex-creative` **自动复制**到
`$DSH_HOME/.agent-presets/`（真实目录，不是 junction）。新会话可选择
**codex 工具模式** 或 **codex 创造模式**。`openai-responses` 路由可将
`apply_patch` 作为自由格式 custom tool；Chat Completions 路由则将它作为
普通函数调用。

离线/开发备用：`scripts/install.ps1` 仍可手工复制同一份预设，并保留
`$DSH_HOME/plugins` junction。日常用户不需要跑它。

> **预设发现**：`dsh-agent-presets` 的 `scanRoot` 跳过 junction / 符号链接。
> 发布器因此始终写成真实目录。工具行通过 `dsh-codex-mode/plugins/tools/...`
> 包导出解析，拷贝后的预设不依赖仓库相对路径。`replay-codex` 只是
> alignment 冻结副本，不是日常编码预设。详细排查见 `plugins/ACTIVATION.md` §5。

## 验证

```bash
npm test
```

测试覆盖预设模块可加载性、preset 自动发布、保留工具的行为，以及两个 OpenAI 路由。历史上的完整 Codex 对齐研究保留在 `docs/`，不再是该插件的运行时契约。
