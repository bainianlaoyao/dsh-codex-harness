# dsh-codex-mode

轻量的 DeepSeek Harness 编码预设。它借用 Codex 常用的工具名称和编辑工作流，但不复刻 Codex 的运行时上下文、审批策略或压缩器。

## 提供内容

- `exec_command` / `write_stdin`：DSH shell 适配器，保留长命令轮询和输出截断体验。
- `apply_patch`：自由格式补丁编辑器；这是首选文件编辑工具。
- `view_image`：本地图片查看。
- DSH 原生工具：计划 `todo_write`、提问 `ask_user_question`、子代理 `subagent` / `subagent_fork`（+ `send_message` / `interrupt_agent` / `list_agents`）、`web_search`。
- OpenAI Chat Completions 和 Responses API 路由。
- `codex 工具模式` 预设：简短编码提示，`AGENTS.md` 指令加载，以及上述工具行。

DSH 自己继续处理工作目录、运行时上下文、沙箱、审批、压缩和宿主工具。预设只
替换工具面（codex 形状的终端与补丁工具），计划/提问/子代理等协作工具一律使用
DSH 原生实现；不会注入 Codex 格式的 `<environment_context>` 或
`<current_time_reminder>`。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

重启 DSH 后，新会话选择 **codex 工具模式**。`openai-responses` 路由可将 `apply_patch` 作为自由格式 custom tool；Chat Completions 路由则将它作为普通函数调用。

> **已知缺口（2026-09-01）**：`install.ps1` 用目录 junction 挂载
> `$DSH_HOME\.agent-presets\codex → 本仓库`，而 dsh 的预设发现
> （`@deepseek-ai/dsh-agent-presets`）不跟随 junction——`readdir` 把 junction
> 当符号链接跳过，预设会从列表消失（选中旧副本 `replay-codex` 则挂载失败回退
> 默认）。对策：在 npx-cache 中给 `dsh-agent-presets/lib/index.js` 的
> `scanRoot` 打追随补丁（`!child.isDirectory() && !child.isSymbolicLink()` 才
> 跳过），`dsh` 升级后需重打；同时把 `$DSH_HOME\.agent-presets\replay-codex`
> 的三个文件与 `agent-presets/codex` 同步。详细排查见 `plugins/ACTIVATION.md`
> §5。

## 验证

```bash
npm test
```

测试覆盖预设模块可加载性、保留工具的行为，以及两个 OpenAI 路由。历史上的完整 Codex 对齐研究保留在 `docs/`，不再是该插件的运行时契约。
