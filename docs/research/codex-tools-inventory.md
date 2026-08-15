---
date: 2026-08-14
topic: codex model-visible built-in tool inventory (for DSH codex-mode replication)
status: completed
mode: context-gathering
sources: codex-rs/core/src/tools/spec_plan.rs + tools/src/* + handlers/* 等（HEAD 5bc8da6d78）
---

# codex @ 5bc8da6d78 模型可见内置工具集完整清单（复刻需求依据）

调研范围：`D:\Data\DEV\dsh\codex`（openai/codex，HEAD 5bc8da6d78，工作树干净，只读）。

## 0. 最重要的结论

**这个版本已经不再有独立的 `read` / `write` / `edit` / `todo_write` / `notebook_edit` / `notebook_read` 工具。**
- 整个 checkout（含 Rust/TS/Python/MD）搜不到 `todo_write`、`notebook*`；`read_file/write_file/edit_file` 只出现在 MCP/Guardian 测试夹具里。
- 文件读取被明确引导走 shell 命令（`gpt_5_2_prompt.md:252` "Parallelize tool calls ... especially file reads, such as cat, rg, sed, ls, git show, nl, wc"）；文件编辑走 `apply_patch`（freeform）；交互式命令走 unified exec（`exec_command` + `write_stdin`）。
- 计划工具在 HEAD 上仍叫 **`update_plan`**；`todo_write` 改名只存在于远端分支 `origin/rename-update-plan-tool-to-todo-write`（非 HEAD 祖先）。
- `read/edit/write/notebook_edit/todo_write` 是 ChatGPT Codex 云端产品（hosted）的工具面，不在开源 CLI 中（文件工具在旧版 codex 也从未作为 CLI 内置工具存在）。

## 1. 默认工具总表（单本地环境、默认配置、真实 codex 模型元数据）

默认 feature（`codex-rs/features/src/lib.rs` FEATURES 表）：ShellTool✅、ViewImage✅、UnifiedExec✅(非 Windows)、Collab(multi_agent)✅、Apps✅、Plugins✅、ToolSuggest✅、ImageGeneration✅、Goals✅；StandaloneWebSearch❌、MultiAgentV2❌、DeferredExecutor❌、RequestPermissionsTool❌、TokenBudget❌、CurrentTimeReminder❌、ExecPermissionApprovals❌、DefaultModeRequestUserInput❌、NonPrefixedMcpToolNames❌、DeferredToolWorldState❌。
默认 config：`update_plan_enabled=true`、`experimental_request_user_input_enabled=true`、`web_search_mode` 默认 Cached、`prefix_mcp_tool_names=true`。

| 工具名 | 用途 | 关键入参 | 出现条件 | 定义位置 |
|---|---|---|---|---|
| `exec_command`（ns `functions`） | 统一 PTY 交互 shell；未完成返回 session_id | cmd(必填)、workdir、tty、yield_time_ms(10000)、max_output_tokens(10000)、shell、login、sandbox_permissions、justification、prefix_rule、additional_permissions、environment_id | ShellTool+UnifiedExec 且 conpty 支持；有环境 | shell_spec.rs:21-111 |
| `write_stdin` | 向 exec session 写 stdin / 空写轮询 | session_id(必填,i32)、chars、yield_time_ms、max_output_tokens | 同上 | shell_spec.rs:113-155 |
| `shell_command` | 传统一次性 shell（unified 生效时 Hidden） | command(必填)、workdir、timeout_ms(10000)、login、sandbox_permissions | ShellTool 且 shell 类型为 ShellCommand | shell_spec.rs:157-225 |
| `apply_patch`（freeform custom） | 受限 diff 语法编辑文件（Add/Update/Move/Delete） | 自由文本 patch（非 JSON） | 有环境且 `model_info.apply_patch_tool_type==Freeform` | apply_patch_spec.rs:9-28 |
| `update_plan` | 计划维护 | plan(必填 [{step,status}])、explanation | config.update_plan_enabled（默认 true） | plan_spec.rs:7-57 |
| `request_user_input` | 向用户提问 1-3 问 | questions(必填) | experimental_request_user_input_enabled（默认 true）；DirectModelOnly | request_user_input_spec.rs:9-88 |
| `view_image` | 读取本地图片返回 data URL | path(必填)、detail(high/original)、environment_id | Feature::ViewImage（默认开）+ 有环境 | view_image_spec.rs:16-51 |
| `tool_search` | BM25 检索延迟加载工具 | query(必填)、limit(8) | `model_info.supports_search_tool && namespace_tools` 且有 deferred 工具 | tool_search_spec.rs:16-105 |
| `web_search`（hosted） | 服务端执行的 Responses 托管搜索（无本地执行器） | external_web_access/indexed_web_access/filters/user_location/search_context_size/search_content_types | standalone web.run 不可用且 provider 支持且模式≠Disabled | hosted_spec.rs:14-46 |
| `web.run`（ns `web`） | 独立扩展 web 搜索/浏览 | search_query/open/click/find/screenshot/finance/weather/sports/time/image_query | Feature::StandaloneWebSearch（默认关） | ext/web-search/src/tool.rs:53-72 |
| `image_gen.imagegen` | 扩展式图像生成 | 扩展定义 | ImageGeneration + 非 Free + provider 能力 + 模型支持图像（默认关） | ext/image-generation/src/tool.rs |
| `multi_agent_v1.spawn_agent` 等 5 个 | V1 子代理 spawn/send_input/resume/wait/close | target/id/message/items/interrupt/timeout_ms | Collab 且版本 V1 | multi_agents_spec.rs |
| `collaboration.spawn_agent` 等 6 个 | V2 子代理（默认关） | task_name+message 必填等 | Feature::MultiAgentV2 | multi_agents_spec.rs |
| `mcp__<server>.<tool>` | MCP 工具（默认 `mcp__` 前缀） | MCP schema；fileParams 掩码 | 配置了 MCP server；deferred 或 Direct | codex-mcp/src/tools.rs:113-234 |
| `list_mcp_resources` 等 3 个 | 列/读 MCP 资源 | server、cursor / server+uri | `mcp.has_servers()` | mcp_resource_spec.rs |
| `request_permissions` | 请求额外 fs/网络权限 | permissions(必填)、reason、environment_id | Feature::RequestPermissionsTool（默认关） | shell_spec.rs:227-262 |
| `wait_for_environment` | 等待 starting 环境 | environment_id(必填) | Feature::DeferredExecutor（默认关） | handlers/wait_for_environment.rs |
| `clock.curr_time` / `clock.sleep` | UTC 时间 / 休眠 | duration_ms(1..12h) | Feature::CurrentTimeReminder（默认关） | handlers/current_time.rs, sleep.rs |
| `get_context_remaining` / `new_context` | 剩余 token / 新上下文窗口 | 无 | Feature::TokenBudget（默认关） | get_context_remaining_spec.rs, new_context_window_spec.rs |
| `test_sync_tool` | 内部测试 barrier | 无 | `experimental_supported_tools` 含 test_sync_tool | test_sync_spec.rs |
| `request_plugin_install` / `list_available_plugins_to_install` | 请求/推荐安装插件连接器 | tool_id/suggest_reason 等 | ToolSuggest+Apps+Plugins 且候选非空 | request_plugin_install_spec.rs |
| 动态工具（app-server 注入） | 服务端动态注册 | 服务端 schema | `turn_context.dynamic_tools` 非空 | spec_plan.rs:1220-1251 |
| `exec` + `wait`（code-mode） | Code Mode：嵌套工具收进 JS `exec` | JS/TS 代码块 | Feature::CodeMode/CodeModeOnly（默认关） | spec_plan.rs:709-815 |

- Guardian 审核会话只暴露 `exec_command`、`write_stdin`、`view_image`（spec_plan.rs:893-931）。
- fallback 模型元数据（未知 slug）下：无 apply_patch、无 tool_search、MCP Direct（model_info.rs:138-184）。

## 2. 重点 schema 细节（摘）

### exec_command / write_stdin / shell_command
- exec_command（strict=false）参数见上表；输出 schema `{chunk_id?, wall_time_seconds, exit_code?, session_id?, original_token_count?, output}`；回包文本前缀 "Chunk ID:" / "Wall time:" / "Process exited with code N" / "Process running with session ID N"；截断附 "Warning: truncated output (original token count: N)"。`supports_parallel_tool_calls=true`。
- **无独立 kill 工具**——终止靠向 session 写控制字节（Ctrl-C）或进程自然结束；进程上限 64、输出上限 1MiB/10000 token；空写轮询 5000-300000ms、非空写默认 250ms。
- shell_command（legacy）unified 生效时 Hidden 保留。

### apply_patch（freeform）
- `ToolSpec::Freeform`，描述含 "This is a FREEFORM tool, so do not wrap the patch in JSON"；Lark grammar（apply_patch.lark）：`*** Begin Patch / *** Add File / *** Update File / *** Delete File / *** Move to / *** End Patch`；多环境支持 `*** Environment ID:` 行；exec_command 内嵌 apply_patch 命令会被 intercept 转为原生执行。

### update_plan
- `plan`(required [{step, status: pending|in_progress|completed}])、`explanation`；Plan 协作模式调用报错；事件 `EventMsg::PlanUpdate`。

### request_user_input
- DirectModelOnly；`questions` 1-3 个 {id(snake_case), header(≤12), question, options(2-3 {label,description})}；客户端自动加 "Other"。

### view_image
- `{path(required), detail(high/original), environment_id}`；输出 `{image_url, detail?}`；detail 默认 high，original 需模型支持。

### web
- **没有 `web_fetch`**。hosted web_search 由服务端执行（client 无执行器）；standalone `web.run`（默认关）才是客户端执行面。

### MCP 命名
- 模型可见名 = `mcp__<server>.<tool>`（sanitize ≤64 字节，冲突加 sha1 后缀）；deferred 时走 tool_search 检索。

### 子代理
- V1 namespace `multi_agent_v1`：spawn_agent/send_input/resume_agent/wait_agent(timeout_ms 默认 30000，范围 10s-1h)/close_agent。
- V2 namespace `collaboration`（默认关）：spawn_agent(task_name+message 必填)/send_message/followup_task/wait_agent/interrupt_agent/list_agents。

## 3. 注册/筛选逻辑要点（spec_plan.rs）

- `build_tool_router`（120-175）→ add_core_tool_sources(892-937) 四组：shell(961)/mcp_resource(1024)/core_utility(1033)/collaboration(1131)；再 MCP、扩展、动态、hosted web_search；`finalize_tool_router`（317-451）→ direct-only 覆盖、code-mode 移除/合并、tool_search 注入、碰撞检测、`build_model_visible_specs`（只收 `exposure.is_direct()`）。
- **Exposure 语义**：Direct / Deferred（tool_search 可检索）/ DeferredModelOnly / DirectModelOnly / CodeModeOnly / Hidden；模型可见 = Direct|DirectModelOnly。
- 关键 gating：`search_tool_enabled = model_info.supports_search_tool && provider.capabilities().namespace_tools`；apply_patch ⇐ model_info.apply_patch_tool_type；update_plan ⇐ config；request_user_input ⇐ config + DirectModelOnly；view_image ⇐ Feature + 环境；collab ⇐ 版本/深度；web.run ⇐ StandaloneWebSearch；imagegen ⇐ ImageGeneration + 计划 + provider；MCP exposure 随 search_tool_enabled 切换 Deferred/Direct。
- 命名空间默认描述 "Tools in the <ns> namespace."；默认函数命名空间 `functions`。

## 4. 与公开稳定版的差异

1. `shell` → `exec_command`/`write_stdin`（unified exec 默认，非 Windows），`shell_command` 仅 Hidden。
2. `tool_search`（BM25）公开版无；MCP/collab 默认 deferred。
3. request_user_input / sleep / curr_time / wait_for_environment / request_permissions / get_context_remaining / new_context / test_sync_tool 为新增/实验工具。
4. 多代理 V2（`collaboration.*`）默认关。
5. `web.run` / `image_gen.imagegen` 默认关。
6. 计划工具 HEAD 与公开版均叫 `update_plan`；`todo_write` 仅在未合入分支。ChatGPT Codex 产品的 read/write/edit/notebook/todo_write 不是 CLI 工具面。

## 5. 复刻风险点

- Schema 版本漂移：以 HEAD 源码为准，勿照抄旧文档。
- hosted web_search 无客户端执行器，复刻必须自实现（或注册 web.run 替代）。
- freeform apply_patch 走 Responses `custom` 类型 + Lark grammar，非 JSON function；解析/校验/沙箱回滚按 apply_patch.lark 实现。
- exposure/deferred 体系：MCP 默认被 tool_search 延迟加载，不复刻则模型看不到 MCP 工具。
- Code Mode 启用后工具面整体替换为 exec/wait（默认关，需显式关闭）。
- exec_command 参数随配置变化（shell/login/environment_id/additional_permissions），按同样条件生成 schema。
- 无 kill 工具；进程上限 64、输出 1MiB/10000 token。
- test_sync_tool/get_context_remaining/new_context/clock.* 默认不出现，默认集合勿带。
- Guardian/审核会话只有 3 个工具，若复刻审核侧需单独建模。
