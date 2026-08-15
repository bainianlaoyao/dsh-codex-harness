# Codex 上下文组装机制调研报告（openai/codex @ 5bc8da6d78）

> 目的：作为在 DSH 中复刻 codex 上下文组装的需求依据。所有结论附 `文件:行号`，重要提示词附原文摘录。
> 仓库根目录下文缩写：`core/` = `codex-rs/core/src/`，`models-manager/` = `codex-rs/models-manager/src/`，`prompts/` = `codex-rs/prompts/`。

---

## 1. 系统提示（System Prompt）组装

### 1.1 一句话总览

Codex 把"系统提示"拆成两半发送（Responses API）：

1. **`instructions` 顶层参数** = 模型的基础指令（`BASE_INSTRUCTIONS`，275 行 markdown，位于 `models-manager/prompt.md`），这是"永远不变的"系统提示正文；
2. **`input` 数组中的 developer/user 消息** = 动态上下文片段（world state、AGENTS.md、权限说明、环境信息等），以带标记（marker）的消息片段逐轮注入/差分更新。

请求构造见 `core/client.rs:844-941`（`build_responses_request`）：

```rust
// client.rs:891-896（非 responses-lite 路径）
(
    prompt.base_instructions.text.clone(),          // → Responses API 顶层 `instructions`
    Some(create_tools_raw_json_for_responses_api(&prompt.tools)?.into()),  // → `tools`
)
```

```rust
// client.rs:923-939
let request = ResponsesApiRequest {
    model: model_info.slug.clone(),
    instructions,               // 系统提示正文
    input,                      // 历史消息 items
    tools,
    tool_choice: "auto".to_string(),
    parallel_tool_calls: prompt.parallel_tool_calls && !model_info.use_responses_lite,
    ...
};
```

### 1.2 基础指令（BASE_INSTRUCTIONS）的来源与渲染

- 常量定义：`models-manager/src/model_info.rs:17` `pub const BASE_INSTRUCTIONS: &str = include_str!("../prompt.md");`
- 正文文件：`codex-rs/models-manager/prompt.md`（275 行）。章节结构（`prompt.md` 的标题）：
  - L1 `You are a coding agent running in the Codex CLI...`（身份）
  - `# How you work` (L11) → `## Personality` (L13)
  - `# AGENTS.md spec` (L17) —— **把 AGENTS.md 语义写进系统提示**，摘录见 2.4 节
  - `## Responsiveness` / `### Preamble messages` (L29-50)
  - `## Planning` + `update_plan` 工具说明 (L52-121)
  - `## Task execution` (L123)：`You are a coding agent. Please keep going until the query is completely resolved...`
  - `## Validating your work` (L149)、`## Ambition vs. precision` (L165)、`## Sharing progress updates` (L173)
  - `## Presenting your work and final message` + 最终回答格式规范 (L181-256)
  - `# Tool Guidelines` (L258)：shell 用 `rg`、`update_plan` 用法 (L267-275)
- **每个模型一份模板**：`ModelMessages.instructions_template`（`protocol/src/openai_models.rs:527-536`），可含 `{{ personality }}` 占位符，渲染见 `get_model_instructions`（`openai_models.rs:501-519`）：

```rust
// openai_models.rs:501-511
pub fn get_model_instructions(&self, personality: Option<Personality>) -> String {
    if let Some(model_messages) = &self.model_messages
        && let Some(template) = &model_messages.instructions_template
    {
        if model_messages.instructions_variables.is_none() {
            return template.clone();
        }
        let personality_message = model_messages.get_personality_message(personality).unwrap_or_default();
        template.replace(PERSONALITY_PLACEHOLDER, personality_message.as_str())
    } else { String::new() }
}
```

- 本地兜底模板：`model_info.rs:186-213`（gpt-5.2-codex 用 `DEFAULT_PERSONALITY_HEADER + {{ personality }} + BASE_INSTRUCTIONS`；其它 slug 直接 `BASE_INSTRUCTIONS`）。
- **会话启动时解析优先级**（`core/session/mod.rs:635-653`）：
  1. `config.base_instructions`（config.toml 显式覆盖，`model_info.rs:52-63`）
  2. 恢复会话时继承 `conversation_history.get_base_instructions()`（rollout 的 session_meta）
  3. `model_info.get_model_instructions(config.personality)`

### 1.3 动态上下文（world state / 片段）如何注入 input

- 首次真实回合/新上下文窗口：`build_initial_context_with_world_state`（`core/session/mod.rs:3489-3687`）把全部 world-state 片段聚合为：
  - 1 条聚合 developer 消息（`build_developer_update_item`，`core/context_manager/updates.rs:11-13`）
  - 若干独立 developer 消息（`requires_separate_message()` 的片段，如 `<context_window>`、guardian 策略）
  - 1 条聚合 user 消息（`build_contextual_user_message`，`updates.rs:15-17`）
  - `<model_switch>` 片段强制插到 developer 消息最前（`session/mod.rs:3632-3634`）
- 后续回合：**只发差分**。`record_context_updates_and_set_reference_context_item`（`session/mod.rs:3802-3876`）：有 `reference_context_item` 基线则调用 `history.update_world_state`（`core/context_manager/history.rs:123-140`）渲染 `render_history_diff`，只把变化片段写入历史；无基线则全量注入。
- 每个 step 采样前：`record_step_world_state_if_changed`（`session/mod.rs:3097-3130`）再次渲染 diff（同一回合内环境/工具状态可能变化）。
- 采样输入 = `history.for_prompt(input_modalities)`（`session/turn.rs:350-356`）→ `build_prompt`（`turn.rs:1294-1310`）→ `Prompt { input, tools, parallel_tool_calls: true, base_instructions }`（`core/client_common.rs:19-37`）。
- **world-state 快照持久化**：每节 `WorldStateSection` 有稳定 `ID` + 可序列化 `Snapshot`，按 RFC 7386 merge-patch 存 rollout（`core/context/world_state/mod.rs:211-245, 292-332`）；回滚/恢复时用快照做基线，避免重复注入（缓存友好）。

### 1.4 Realtime（语音前端）的独立系统提示

- 前端模型系统提示 = `BACKEND_PROMPT`（`prompts/templates/realtime/backend_prompt.md`，65 行，章节：`## Identity, tone, and role` / `## Interface and operating model` / `### Policies` / `## Backend use and steering` / `## Backend outputs and user inputs` / `## Presenting backend results` / `## Task-level user preferences` / `## Communication style`）。
- 组装：`core/realtime_prompt.rs:5-24` —— 优先级 `config_prompt`（experimental_realtime_ws_backend_prompt）> 请求参数 prompt > 默认模板；默认模板替换 `{{ user_first_name }}`（用 `whoami` 取用户名，`realtime_prompt.rs:26-32`）。
- 放入 realtime 会话 `instructions`：`realtime_conversation.rs:1274-1296`（prompt 与 startup context 拼接，startup context 见 `core/realtime_context.rs:59-128`，各节 token 预算：当前线程 1200、近期工作 2200、工作区 1600、笔记 300；`realtime_context.rs:33-37`）。

---

## 2. AGENTS.md / 项目上下文发现机制

### 2.1 发现算法（`core/agents_md.rs:1-16` 模块文档原文）

```
1.  Determine the project root by walking upwards from the current working
    directory until a configured `project_root_markers` entry is found.
    When `project_root_markers` is unset, the default marker list is used
    (`.git`). If no marker is found, only the current working directory is
    considered. An empty marker list disables parent traversal.
2.  Collect every `AGENTS.md` found from the project root down to the
    current working directory (inclusive) and concatenate their contents in
    that order.
3.  We do **not** walk past the project root.
```

- 实现：`agents_md_paths`（`agents_md.rs:164-238`）：`find_nearest_ancestor_with_markers` 找根（`agents_md.rs:186-193`），然后从 cwd 一路到 root 收集目录（`agents_md.rs:194-211`），**从根到 cwd，不越过根**；每目录按候选文件名顺序探测（并行 256 路，`agents_md.rs:48`）。
- 候选文件名顺序（`agents_md.rs:240-254`）：`AGENTS.override.md`（本地覆盖，优先）→ `AGENTS.md` → `project_doc_fallback_filenames`（config 可配）。

### 2.2 大小限制

- 总预算 `project_doc_max_bytes`，默认 **32 KiB**：`config/mod.rs:208` `pub(crate) const AGENTS_MD_MAX_BYTES: usize = DEFAULT_PROJECT_DOC_MAX_BYTES; // 32 KiB`，`config/src/config_toml.rs:77` `pub const DEFAULT_PROJECT_DOC_MAX_BYTES: usize = 32 * 1024;`
- 逐文件按剩余预算截断（`agents_md.rs:115-152`），读文件时 `data.truncate(remaining)` 并告警。

### 2.3 组装与注入

- 全局（用户级）AGENTS.md：`CodexHomeUserInstructionsProvider`（`codex-rs/codex-home/src/instructions/`）从 `$CODE_HOME/AGENTS.override.md` 优先、其次 `$CODE_HOME/AGENTS.md` 读取（`~/.codex/`）。
- 拼接顺序（`agents_md.rs:325-351` `legacy_text`）：user instructions → `\n\n--- project-doc ---\n\n`（`agents_md.rs:43`）→ 项目文件（从根到 cwd）；多环境时给每个环境加 `for {environment_id} with root {cwd}` 标签（`agents_md.rs:353-396`）。
- 注入为 **user 角色**片段，标记 `# AGENTS.md instructions ... </INSTRUCTIONS>`（`core/context/user_instructions.rs:9-29`）：

```rust
// user_instructions.rs:14-29
fn type_markers() -> (&'static str, &'static str) {
    ("# AGENTS.md instructions", "</INSTRUCTIONS>")
}
fn body(&self) -> String {
    let directory = ...format!(" for {directory}")...;
    format!("{directory}\n\n<INSTRUCTIONS>\n{}\n", self.text)
}
```

- 作为 world-state 节 `AgentsMdState`（`core/context/world_state/agents_md.rs:34-79`）：内容变化时重发，并带替换/移除提示：
  - `REPLACEMENT_NOTICE = "These AGENTS.md instructions replace all previously provided AGENTS.md instructions."`（`agents_md.rs:9-10`）
  - `REMOVAL_NOTICE = "The previously provided AGENTS.md instructions no longer apply."`（L11）
- 缓存：`AgentsMdManager`（`core/agents_md_manager.rs:10-54`）按环境选择缓存；`capture_step_context` 每 step 刷新（`session/mod.rs:3158-3163`）。

### 2.4 模型侧语义（写在系统提示里）

`models-manager/prompt.md:17-27`（`# AGENTS.md spec`）原文要点：

> - Repos often contain AGENTS.md files. These files can appear anywhere within the repository.
> - The scope of an AGENTS.md file is the entire directory tree rooted at the folder that contains it.
> - For every file you touch in the final patch, you must obey instructions in any AGENTS.md file whose scope includes that file.
> - More-deeply-nested AGENTS.md files take precedence in the case of conflicting instructions.
> - Direct system/developer/user instructions (as part of a prompt) take precedence over AGENTS.md instructions.
> - The contents of the AGENTS.md file at the root of the repo and any directories from the CWD up to the root are included with the developer message and don't need to be re-read. When working in a subdirectory of CWD, or a directory outside the CWD, check for any AGENTS.md files that may be applicable.

注意：codex **不解析 AGENTS.md 的 section 头**（不像 Claude Code 的 `# Language` 等结构化 section），而是整文件原文拼接，语义由上述系统提示段落教给模型。语言偏好等只能靠模型自行遵循。

### 2.5 `.codex/` 目录与 config.toml

- 配置分层（`config/src/config_layer_source.rs:6-49`，按优先级升序）：`PackagedDefaults(-10) < Mdm(0) < System(10) < EnterpriseManaged(15) < User(20, ~/.codex/config.toml) < Project(25, 项目 .codex 目录) < SessionFlags(30) < LegacyManaged...`
- `ConfigLayerSource::Project` 即"项目 `.codex` 目录"（`config_layer_source.rs:20`），hook 声明也关联 `.codex/`（`config/src/state.rs:215-230`）。
- config.toml 里与上下文相关的键：`instructions`（系统提示覆盖，`config_toml.rs:216-217`）、`developer_instructions`（额外 developer 消息，L219-221）、`include_permissions_instructions`/`include_apps_instructions` 等开关（L223-230）、`project_doc_max_bytes`（L289-290）、`project_doc_fallback_filenames`（L293-294）、`project_root_markers`（L474）、`model_auto_compact_token_limit` 等。

---

## 3. 上下文片段清单（ContextualUserFragment）

统一 trait：`context-fragments/src/fragment.rs:14-87`：

```rust
pub trait ContextualUserFragment {
    fn role(&self) -> &'static str;          // "developer" | "user" | "assistant"
    fn requires_separate_message(&self) -> bool { false }
    fn markers(&self) -> (&'static str, &'static str);   // 起始/结束标记，用于历史识别
    fn body(&self) -> String;
    fn render(&self) -> String { /* markers + body */ }
    fn into(self) -> ResponseItem;           // Message { role, content: [InputText] }
}
```

片段定义必须位于 `core/context/` 且实现该 trait（codex 仓库自身 AGENTS.md 的"Model visible context"规则：所有注入片段必须是有界大小 + 硬上限，单项 ≤10K token，>1K token 的新增需人工评审）。

### 3.1 world-state 节（会话级、按快照 diff 注入）

| 节 ID | 角色 | 标记 | 内容 / 上限 | 定义文件 |
|---|---|---|---|---|
| `model` | developer | `<model_switch>` | 模型身份；换模型时注入完整 instructions（独立消息） | `context/world_state/model.rs`、`context/model_switch_instructions.rs` |
| `personality` | developer | （由模板决定） | 人格指令片段（切换时） | `context/world_state/personality.rs` |
| `agents_md` | user | `# AGENTS.md instructions`…`</INSTRUCTIONS>` | AGENTS.md 全文（预算 32KiB） | `context/world_state/agents_md.rs` |
| `permissions` | developer | `<permissions instructions>` | 沙箱模式 + 审批策略 + exec 规则；含已批准前缀集合 | `context/world_state/permissions.rs`、`prompts/src/permissions_instructions.rs:184-186` |
| `approved_command_prefixes` | developer | `APPROVED_COMMAND_PREFIX_SAVED_MESSAGE_PREFIX` | 无完整权限说明时只通知新增批准前缀 | `context/world_state/compact_permissions.rs` |
| `environments` | user | `<environment_context>`…`</environment_context>` | cwd/shell/状态 + `current_date`/`timezone` + `<network>` + `<filesystem>`（workspace_roots + 权限条目，XML 转义） | `context/world_state/environment.rs:190-260`、`context/environment_context.rs` |
| `environments_instructions` | developer | `<environments_instructions>` | 多执行环境使用说明（"starting" 环境不可用等） | `context/environments_instructions.rs` |
| `apps_instructions` | developer | `<apps_instructions>` | Apps(Connectors) 触发语法说明 | `context/apps_instructions.rs` |
| `plugins_instructions` | developer | （取决于插件文本） | 插件用法 | `context/plugin_instructions.rs` |
| `tools` | developer | `<tools>`…`</tools>` | 延迟加载的 tool namespace 列表；渲染上限 4KiB，描述截 250 字符 | `context/world_state/tools.rs:20-22` |
| `collaboration_mode` | developer | `<collaboration_mode>` | 协作模式（默认/代码模式等） | `context/world_state/collaboration_mode.rs` |
| `multi_agent_mode` | developer | `<multi_agent_mode>` | 多智能体模式；Custom 文本截断 400 token | `context/world_state/multi_agent_mode.rs:12-13` |
| `multi_agent_usage_hint` | developer | 同上 | 使用提示 | `context/world_state/multi_agent_usage_hint.rs` |
| `realtime` | developer | `<realtime_conversation>` | 语音会话 start/end 说明（激活/结束时注入） | `context/world_state/realtime.rs` |
| `context_window` | developer | `<context_window>`…`</context_window>` | 上下文窗口 ID（first/previous/current）+ agent 名；**独立消息** | `context/token_budget_context.rs:47-71` |
| `context_window_guidance` | developer | `<context_window_guidance>` | token 预算引导消息（model/config 提供） | `context/token_budget_context.rs:103-122` |
| 扩展节 | developer/user | 扩展自定 | 插件（plugins/extension）贡献 | `world_state/mod.rs:352-366`（`host_skills` 插在 permissions 前） |

### 3.2 回合级片段（turn/step 内动态注入）

| 片段 | 角色 | 标记 | 内容 / 上限 |
|---|---|---|---|
| `UserInstructions`（AGENTS.md） | user | 见 2.3 | 见 2 |
| `EnvironmentsState` | user | `<environment_context>` | 见上 |
| `CurrentTimeReminder` | developer | `<current_time_reminder>` | `"It is {YYYY-MM-DD HH:MM:SS UTC}."`；按间隔限频（`session/time_reminder.rs:59-95`，间隔可配） |
| `PermissionsInstructions` | developer | `<permissions instructions>` | 沙箱/审批（见 3.1） |
| `TokenBudgetReminder` | developer | （无） | `"You have {n_remaining} tokens left..."`；低于阈值注入（`session/token_budget.rs:75-92`） |
| `AutoCompactFallbackPrompt` | developer | （无） | token 用尽时的兜底提示（`session/token_budget.rs:94-112`） |
| `RolloutBudgetContext` | developer | `<rollout_budget>` | 会话级 token 预算剩余 |
| `HookAdditionalContext` | developer | （无） | hook 注入的任意文本 |
| `PluginInstructions` | developer | （无） | 插件说明 |
| `ModelSwitchInstructions` | developer | `<model_switch>` | 换模型说明（独立消息） |
| `AppsInstructions`/`EnvironmentsInstructions` | developer | 见 3.1 | |
| `AdditionalContextUserFragment` | user | `<external_{key}>…</external_{key}>` | 值截断 **1000 token**（`context-fragments/additional_context.rs:5`） |
| `AdditionalContextDeveloperFragment` | developer | （无） | 同上 1000 token |
| `InternalModelContextFragment` | user | `<codex_internal_context source="...">` | 扩展内部隐藏上下文 |
| `SubagentNotification` | user | `<subagent_notification>` | 子智能体状态 JSON |
| `TurnAborted` | user | `<turn_aborted>` | 中断说明（"The user interrupted the previous turn on purpose..."） |
| `UserShellCommand` | user | （自定义） | 用户 shell 命令上下文 |
| `ImageResizeNotice` | developer | `<image_resize_notice>` | 图片被缩放的通知（独立消息） |
| `RecommendedPluginsInstructions` | user | （自定义） | 推荐插件列表（≤50 个，`recommended_plugins_instructions.rs:6`） |
| `InterAgentMessage` | assistant | （无） | `Message Type: …\nTask name: …\nSender: …\nPayload:\n…`（子智能体通信） |
| `InterAgentCompletionMessage` | user | （自定义） | 子智能体完成/错误（错误截 900 token，`session_prefix.rs:10-14`） |
| `GuardianFollowupReviewReminder` / `NodeReplReviewEvidence` | developer | （自定义） | 守卫审查相关（证据渲染上限 32KB，`node_repl_review_evidence.rs:19`） |
| `legacy_*` 警告（`LegacyApplyPatchExecCommandWarning` 等） | user/developer | （自定义） | 旧配置迁移警告 |
| `realtime_*`（start/end/delegation） | developer | `<realtime_conversation>` | 语音会话说明 |

> 判定"上下文片段"的标准函数：`core/context/contextual_user_message.rs:18-44` —— 按 marker 前缀匹配（`matches_text`），命中则视为非用户意图的注入片段，从用户回合边界计算中排除（`core/context_manager/history.rs:910-920` `is_user_turn_boundary`：user 消息且非片段才算是新回合）。

---

## 4. 消息 / 回合结构（Responses API input 组装）

### 4.1 数据结构

- `ResponseItem`（`protocol/src/models.rs:846-1030+`，`#[serde(tag="type", rename_all="snake_case")]`）：`Message{role, content: [ContentItem]}`、`FunctionCall{name, arguments(String JSON), call_id}`、`FunctionCallOutput{call_id, output: FunctionCallOutputPayload}`、`CustomToolCall/CustomToolCallOutput`、`Reasoning{summary, content, encrypted_content}`、`WebSearchCall`、`AgentMessage`、`Compaction/CompactionTrigger/ContextCompaction` 等。
- `ContentItem`（`models.rs:743-759`）：`InputText` / `InputImage{image_url, detail}` / `InputAudio` / `OutputText`。
- `FunctionCallOutputPayload`（`models.rs:1991-1998`）：body 为 `Text(String)` 或 `ContentItems(Vec<FunctionCallOutputContentItem>)`（可含 InputImage/InputAudio/EncryptedContent）。
- 入参类型 `ResponseInputItem`（`models.rs:705-739`）：Message / FunctionCallOutput / McpToolCallOutput / CustomToolCallOutput / ToolSearchOutput。
- `BaseInstructions { text, provenance }`（`models.rs`）→ 请求顶层 `instructions`。

### 4.2 历史维护与规范化（`core/context_manager/`）

- `ContextManager`（`history.rs:45-65`）：`items: Arc<Vec<ResponseItemEnvelope>>`（旧→新），`history_version`（压缩/回滚时递增）、`token_info`、`reference_context_item`、`world_state_baseline`。
- 记录：`record_items_with_metadata`（`history.rs:178-195`）—— 跳过 system 角色与 CompactionTrigger；工具输出按 `TruncationPolicy` 截断（`process_item`，`history.rs:460-503`，策略 ×1.2 序列化余量）。
- 发送前 `for_prompt`（`history.rs:200-205`）→ `normalize_history`（`history.rs:444-458`）保证三个不变量：
  1. 每个 call 有对应 output：缺则插入合成 `FunctionCallOutput{output:"aborted"}`（`normalize.rs:21-131`，合成 ID 由 UUIDv5 命名空间生成以保证缓存稳定，`normalize.rs:18-19`、`139-146`）；
  2. 无孤儿 output（`remove_orphan_outputs`，`normalize.rs:148-217`）；
  3. 模型不支持图片/音频时剥离为占位文本（`strip_images_when_unsupported` / `strip_audio_when_unsupported`，`normalize.rs:317-408`）。
- **call_id 关联**：FunctionCall 与 FunctionCallOutput 通过 `call_id` 一一对应；并行工具调用时每个 call 独立 call_id，输出按 call_id 回填；`remove_corresponding_for`（`normalize.rs:219-304`）保证删除一项时成对删除（用于压缩时去掉最旧项）。

### 4.3 回合边界与发送

- `is_user_turn_boundary`（`history.rs:910-920`）：`AgentMessage` 或 user 角色且**非**上下文片段，或 assistant 且为 inter-agent 指令文本 → 新回合边界。
- 采样：`turn.rs:349-356` `sess.clone_history().for_prompt(input_modalities)` → `build_prompt`（`turn.rs:1294-1310`，`parallel_tool_calls: true`）→ `run_sampling_request` → `client.stream`（`client.rs:1851`）。
- 工具执行：`ToolCallRuntime`（`turn.rs:1337-1341`）执行 FunctionCall，输出经 `record_conversation_items` 记录回历史（`session/mod.rs:3046-3061`，含图片准备 `image_preparation::prepare_response_items`）。并行工具调用能力由各 handler 声明（如 `view_image.rs:78-80` `supports_parallel_tool_calls() -> true`）。
- 完成回合后依据 `token_limit_reached` + `needs_follow_up` 决定是否压缩续跑（`turn.rs:440-480`）。

### 4.4 回合结构示意

```
ResponsesApiRequest {
  instructions: <BASE_INSTRUCTIONS 渲染后>,
  input: [
    developer: <初始上下文聚合消息: 权限说明+模型说明+apps/plugins/environments 说明…>（首回合）
    developer: <context_window>…</context_window>（独立）
    user: <environment_context>…</environment_context>  +  <# AGENTS.md instructions>…</INSTRUCTIONS>
    user: <真实用户消息>
    assistant: <模型输出文本/并行 FunctionCall>
    function_call_output: {call_id, output}   × N（并行）
    developer/user: <回合中 diff 片段>
    …（循环）
  ],
  tools: [...],
  parallel_tool_calls: true
}
```

---

## 5. 上下文压缩 / auto-compact

### 5.1 触发条件（`core/session/context_window.rs:23-91`）

- `context_window_token_status`：计算 `active_context_tokens`（服务端最后 usage + 本地追加项估算，`history.rs:415-432`）。
- 触发：`token_limit_reached = (auto_compact_scope_tokens >= auto_compact_scope_limit + fallback_buffer) || (active_context_tokens >= full_context_window)`（`context_window.rs:74-79`）。
- 范围模式（`AutoCompactTokenLimitScope`）：
  - `Total`：全部活跃上下文 vs `model_info.auto_compact_token_limit()`（`context_window.rs:32-36`）；
  - `BodyAfterPrefix`：`active - prefill_baseline` vs 配置值（`context_window.rs:37-50`）。
- 默认阈值：`auto_compact_token_limit()` = 无配置时 `context_window * 9/10`（`openai_models.rs:482-486`）；`effective_context_window_percent` 默认 95（`openai_models.rs:440`）。
- 触发时机（`session/turn.rs`）：
  - **回合前** `run_pre_sampling_compact`（`turn.rs:994-1023`）：`token_limit_reached` 即压缩；另 `maybe_run_previous_model_inline_compact`（`turn.rs:1062-1153`）：comp_hash 变化或换到更小上下文窗口模型时压缩；
  - **回合中**：采样后 `token_limit_reached && needs_follow_up` → `run_auto_compact`（`turn.rs:440-480`，`CompactionReason::ContextLimit, CompactionPhase::MidTurn`）。

### 5.2 实现选择（`turn.rs:1160-1240` `run_auto_compact`）

1. `Feature::TokenBudget` 开启 → `compact_token_budget::run_inline_auto_compact_task`：**不摘要**，直接换新上下文窗口 + 全量重注入初始上下文（`compact_token_budget.rs:21-64`）；
2. provider `remote_compaction` V2/V1 → **服务端压缩**（`compact_remote_v2.rs` / `compact_remote.rs`，依赖 OpenAI 服务端 memento 能力）；
3. `Unsupported` → **本地模型摘要压缩**（`compact.rs`）。

### 5.3 本地模型摘要压缩（`core/compact.rs`）

- 摘要提示词：`SUMMARIZATION_PROMPT`（`prompts/templates/compact/prompt.md`）：

> You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.
> Include: Current progress and key decisions made; Important context, constraints, or user preferences; What remains to be done (clear next steps); Any critical data, examples, or references needed to continue...

- 流程（`run_compact_task_inner_impl`，`compact.rs:240-394`）：
  1. 把摘要提示词作为 user 消息加入历史，用与正常回合相同的 `Prompt{input, base_instructions}` 发一次模型请求（`compact.rs:250-289`）；
  2. 摘要 = 压缩回合最后一个 assistant 消息：`summary_text = "{SUMMARY_PREFIX}\n{summary_suffix}"`（`compact.rs:349-352`）；
  3. 新历史 = `build_compacted_history`（`compact.rs:639-717`）：
     - 保留的用户消息：从最新往前，总计 ≤ `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（`compact.rs:57`），超出部分截断（`compact.rs:658-683`）；
     - 末尾追加摘要 user 消息（`SUMMARY_PREFIX` 见 `prompts/templates/compact/summary_prefix.md`）；
  4. 中途压缩（MidTurn）时把初始上下文插到"最后一个真实用户消息之前"（`insert_initial_context_before_last_real_user_or_summary`，`compact.rs:581-637`）；回合前/手动压缩不注入（`InitialContextInjection::DoNotInject`，`compact.rs:59-74`）；
  5. `replace_compacted_history` + `recompute_token_usage`（`compact.rs:374-385`）；
  6. 压缩中 `ContextWindowExceeded` → 从最旧开始丢项（`compact.rs:309-318`）。
- 手动压缩 `/compact`：`run_compact_task`（`compact.rs:143-167`），同样走摘要流程。
- 压缩后提示用户："Heads up: Long threads and multiple compactions can cause the model to be less accurate..."（`compact.rs:389-392`）。

### 5.4 服务端压缩（依赖 codex 服务端）

- V1（`compact_remote.rs`）：向服务端发压缩请求，`process_compacted_history` 过滤保留项（`compact_remote.rs:311-397`）；回填时 `trim_function_call_history_to_fit_context_window`（`compact_remote.rs:399-455`）按上下文窗口裁剪工具输出。
- V2（`compact_remote_v2.rs`）：`RETAINED_MESSAGE_TOKEN_BUDGET = 64_000`（L65）、`MAX_RETAINED_AGENT_MESSAGE_TOKENS = 10_000`（L66）；保留客户端开发者消息（`is_client_authored_developer_message`，L490）并按预算截断（L541-617）。

### 5.5 token 估算（`compact_token_budget.rs` 之外的估算逻辑）

- 估算在 `history.rs:247-271`：`approx_token_count`（`codex_utils_output_truncation`，按字节/4 估算）+ 逐 item 估算（`estimate_item_token_count`，`history.rs:613-616`）。
- 特殊条目：加密 reasoning 内容按 base64 长度×3/4−650 估算（`history.rs:597-603`）；加密工具输出 ×9/16（`605-607`）；图片 base64 payload 以固定 7373 字节 ≈ 1844 token 替代（`history.rs:618-622`）；`detail: original` 按 32px patch 数（≤10,000 patch）估算（`history.rs:626-756`）；音频用 `estimate_audio_token_count`（`history.rs:808-822`）。
- 服务端 usage 与本地追加项合并：`get_total_token_usage`（`history.rs:415-432`）—— `last_token_usage.total_tokens` + 最后模型生成项之后的本地估算（reasoning 是否含在服务端 usage 由 `server_reasoning_included` 决定）。

---

## 6. 图片上下文与 review

### 6.1 图片（view_image）

- 工具：`core/tools/handlers/view_image.rs`。模型调用 `view_image{path, detail?}`（`view_image.rs:55-61`）：
  - 校验模型支持图片（`view_image.rs:92-101`）；读文件并校验是合法图片（`view_image.rs:180-182`）；
  - 生成 data URL：`data_url_from_bytes("application/octet-stream", &file_bytes)`（`view_image.rs:194`）；
  - detail：默认 `high`（`DEFAULT_IMAGE_DETAIL = ImageDetail::High`，`models.rs:791`），`original` 仅当模型支持（`original_image_detail::can_request_original_image_detail`，`view_image.rs:184-191`）；
  - 输出 = `ResponseInputItem::FunctionCallOutput { call_id, output: ContentItems([InputImage{image_url, detail}]) }`（`view_image.rs:228-243`）—— 图片以 InputImage content item 进入历史。
- 历史插入时的再处理：`record_conversation_items` → `image_preparation::prepare_response_items`（`core/image_preparation.rs:95-160`）：
  - 按 `PromptImageResizeLimits` 缩放：HIGH detail 最大边 2048、最大 patch 2500；unified budget 6000/10000（`image_preparation.rs:29-36`）；
  - 失败/远程 URL/不支持 low detail → 替换为占位文本（`image_preparation.rs:21-27`）；
  - 缩放过的图追加 `<image_resize_notice>` developer 片段告知模型（`context/image_resize_notice.rs:34-73`）。
- 模型不支持图片时：`normalize::strip_images_when_unsupported` 换成 `"image content omitted because you do not support image input"`（`normalize.rs:14-15`）。

### 6.2 review（guardian 自动审查，简述）

- guardian 审查是一个独立子智能体回合：`tasks/review.rs:117` `sub_agent_config.base_instructions = Some(crate::REVIEW_PROMPT.to_string());` —— REVIEW_PROMPT 来自 `prompts/src/review_request.rs` / `templates/review/rubric.md`（审查准则：只标记作者会修复的、可操作、非风格的问题等）。
- 审查者 source 的 developer 策略提示保持为独立 developer 消息（`session/mod.rs:3504-3513`、`3672-3681`），便于审计。
- 相关片段：`GuardianFollowupReviewReminder`、`NodeReplReviewEvidence`（节点 REPL 审查证据，渲染上限 32KB）。

---

## 7. 复刻要点与风险

### 7.1 复刻要点（可在第三方 harness 实现）

1. **双通道系统提示**：`instructions`（静态基础指令）+ `input` 里的 developer/user 片段消息；片段全部走"角色 + 标记 + body"的 `ContextualUserFragment` 抽象，标记用于从历史中识别注入片段（回滚、差分、压缩时复用）。
2. **增量上下文 + 快照差分**：以持久化快照（world-state 各节 Snapshot）为基线，只把变化片段写回历史（`render_diff`），不要每回合全量重发——这是缓存命中的关键设计。
3. **AGENTS.md**：从"根（`project_root_markers`，默认 `.git`）到 cwd"收集全部 AGENTS.md（含 `AGENTS.override.md` 优先），32KiB 总预算截断，user 角色 `<INSTRUCTIONS>` 注入；用户级文件放 `~/.codex/AGENTS.md`；把"嵌套优先、系统提示优先"的语义写进系统提示而非解析。
4. **消息规范化不变量**：call/output 成对（缺输出补 `"aborted"`）、无孤儿输出、按 `input_modalities` 剥离图片/音频、工具输出按 token 截断——每次发送前跑一遍。
5. **token 预算**：字节/4 估算 + 图片/音频/加密内容的专用估算；`auto_compact_token_limit` 默认上下文窗口 90%；压缩保留最新 ≤20K token 的用户消息 + 摘要消息。
6. **压缩生命周期**：pre-compact/post-compact hooks、`ContextCompaction` turn item、窗口 ID（`<context_window>` 片段告知模型）、压缩后重算 token usage、`ContextWindowExceeded` 时丢最旧项。
7. **回合边界判定**：user 消息且非注入片段才算用户回合（`is_user_turn_boundary`），片段消息不计入。

### 7.2 风险 / 依赖 codex 服务端的部分（第三方 harness 无法直接复现）

1. **服务端远程压缩（memento）**：`RemoteCompactionSupport::V1/V2` 依赖 OpenAI Responses 服务端能力（`compact_remote.rs` / `compact_remote_v2.rs`），本地 harness 只能走"本地模型摘要"路径；摘要质量与保留策略（V2 保留 64K token 客户端开发者消息）无法等价。
2. **`encrypted_content`（加密推理内容）**：`Reasoning.encrypted_content` / `FunctionCall.encrypted_function_args` / `include: ["reasoning.encrypted_content"]`（`client.rs:904`）依赖 OpenAI 服务端加密能力与 `encrypted_function_args` 解密；第三方模型无此能力时需降级为明文 reasoning（影响 token 估算 `history.rs:597-607`）。
3. **`prompt_cache_key` / 缓存语义**（`client.rs:921`）：codex 大量依赖前缀缓存（"Trim from the beginning to preserve cache"，`compact.rs:311`）；消息 ID 稳定性（合成输出 ID 的 UUIDv5 命名空间 `normalize.rs:18-19`）与 `WorldStateHash`（`world_state/mod.rs:247-260`）都为此服务。第三方 API 若无等价缓存可忽略，但结构上应保持"只增前缀、不重写历史"（codex 仓库 AGENTS.md：no history rewrite）。
4. **`instructions` 顶层参数语义**：Responses API 的 `instructions` 与 developer 角色消息在不同后端模型上的处理有差异；codex 用 `use_responses_lite` 时把 instructions 改成 developer 消息 + `AdditionalTools` 前缀（`client.rs:867-890`）——第三方 harness 需按目标模型选其一。
5. **realtime（语音）链路**：`BACKEND_PROMPT` + startup context + realtime 会话（`instructions` 参数、`initial_items`）是 ChatGPT 语音前端专用，与 CLI 后端无关；复刻 CLI 场景可跳过。
6. **模型元数据（models endpoint）**：`ModelMessages`（instructions_template/approvals/permissions/token_budget）来自 OpenAI 服务端模型目录；离线时用 `model_info_from_slug` 兜底（`model_info.rs:138-184`，上下文窗口 272K、默认 10K 字节截断等）。
7. **启发式 token 估算**：`approx_token_count` 是字节/4 的粗略下界（`history.rs:246` "not a tokenizer-accurate count"），服务端 usage 为准；第三方需用自己的 tokenizer 替换以精确化。
8. **10K token 单项上限是仓库约定而非运行时强制**：codex 的 AGENTS.md 要求所有注入片段 ≤10K token、>1K 需人工评审——DSH 复刻时应把该约束做成运行时断言（bound + hard cap）并纳入评审流程。
9. **多执行环境（environments）**：`<environment_context>`、环境标签化 AGENTS.md、`starting` 状态等依赖 codex 的 exec-server/environment 抽象；单环境 harness 可只实现主环境部分。
