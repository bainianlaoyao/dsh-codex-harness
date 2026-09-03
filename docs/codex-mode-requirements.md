# 历史记录：Codex 模式（DSH）完整对齐需求规格说明书

> 本文记录 2026-08 的完整对齐实验。当前 `dsh-codex-mode` 已不实现其中的提示词、环境上下文、审批、沙箱升级或压缩器要求；计划/提问/子代理也改用 DSH 原生工具（`todo_write`/`ask_user_question`/`subagent`）。现行契约见根目录 `README.md`、预设和活动测试。

> 状态：已定稿（2026-08-14 决策点全部确认，进入实施；§6.1 执行后端按 D1 改为 git bash）
> 目标读者：实现者（subagent / 主 agent）
> 规范源：本地 codex 仓库 `D:\Data\DEV\dsh\codex`（openai/codex 官方，HEAD `5bc8da6d78`）
> 宿主：DeepSeek Harness（DSH，`@deepseek-ai/dsh@0.1.0-rc.6`，本机部署 profile `web`）

## 实施进度（2026-08-14，晚更新）

- **M0 模型接入**：✅ 结构完成。
  - `llm-openai.js`（`openai-official` route，chat-completions wire，SSE 零依赖解析，冒烟 ALL PASS）。
  - **`llm-responses.js`（新增，`openai-responses` route）**：OpenAI **Responses API** wire（codex 自身协议，`POST /v1/responses` + SSE），两路由均已注册进 profile 补丁层（`--dump-config` 校验通过；需重启 dsh 生效）。
  - ⏳ 真机 GPT 调用待用户提供 `OPENAI_API_KEY`。
- **M1 工具与上下文静态对齐**：✅ 磁盘完成（运行时激活待重启 dsh）。
  - 5 个 codex 工具全部就绪且冒烟 PASS：`exec_command`+`write_stdin`（git bash PTY，`backendType` 可单独配置；模型侧 `shell` 参数校验 bash/shell/git-bash）、`apply_patch`（Lark 语法 + 父目录自动创建 + 工作区外删除拒绝）、`update_plan`（会话投影）、`view_image`（魔数校验）、`request_user_input`（1-3 问）。
  - **`apply_patch` 无妥协化（本轮）**：工具描述改为 codex **逐字**字符串（`apply_patch_spec.rs:20`）；`openai-responses` 路由上声明为 `custom` freeform 工具（`format: {type:grammar, syntax:lark, definition:apply_patch.lark}` 逐字），模型输出裸 patch 文本、无 JSON，适配器仅在 DSH 内部 transport 层包 `{patch:…}`；`openai-official`（chat-completions）路由无 custom-tool 类型，退化为 JSON 函数（文档化差异）。
  - codex 预设 `C:\Users\30280\.dsh\.agent-presets\codex\`：preset.yml + agent.cordis.yml（persona=275 行 BASE_INSTRUCTIONS 移植；agent-instructions 按 §5.2 配置 32KiB/.git 根/AGENTS.md+override；5 工具行；web fetch:false；compaction 组）。行解析校验 ALL PASS。
- **M2/M3**：✅ 完成（除激活验证与已声明的范围外项）。
  - ✅ `policy/exec-policy.js`（§7.2：安全/危险名单、git 规则、Windows 形式、规范化、四策略分类矩阵）。
  - ✅ `harness/compact.js`（§5.5：90% 触发、20K 用户消息保留、摘要组装、模板原文移植）。
  - ✅ `harness/approvals.js`（§7.6：决策词汇、动态决策集、会话缓存、沙箱拒绝升级矩阵）。
  - ✅ **exec 工具审批闸**（tools/exec-command.js）：exec-policy 分类 → `ctx.approval.request`（DSH 审批缝）；会话级 `never` 覆盖 = codex never 语义（危险命令 Forbidden 不弹窗）；`require_escalated` + justification 升级路径；unrestricted 沙箱按 codex `Skip` 不弹窗。冒烟覆盖 5 条路径 ALL PASS。
  - ✅ **视觉通道（M3）**：llm-openai / llm-responses 适配器支持 ImageBlock → `image_url` / `input_image` 内容部件（经附件存储装配 data URL）；view_image 经附件存储保存并产出真实图片块。冒烟 ALL PASS。
  - ✅ **Collab V1（P1→完成）**：`tools/multi-agent.js`（spawn_agent/send_input/resume_agent/wait_agent/close_agent 映射 DSH subagent 缝）。
  - ✅ **codex 压缩引擎**：`harness/codex-compactor.js`（CompactionEngine：90% 触发、≤20K 新近用户消息保留（最旧截断）、SUMMARIZATION_PROMPT 真实摘要调用、compaction/* 事件协议、surface replace 事务）——已接入预设 compaction 组（替换 compaction-basic），冒烟 ALL PASS。
  - ✅ **工具面收紧**：`tools/restrict.js` 隐藏 host 全局 `bash`（否则与 exec_command 并存且绕过审批闸）。
  - ✅ 静态对齐附录 B + `ACTIVATION.md` 激活手册（9 条首跑用例 + 故障排查表）。
  - ⏳ 剩余：真机激活验证（重启 dsh + `OPENAI_API_KEY` + 模型路由切换 **推荐 `openai-responses`**，按 ACTIVATION.md 执行）。

---

## 1. 背景与目标

### 1.1 目标

在 DSH 中新增一个 **codex 模式**：

1. 以本地 codex 项目为规范源，在 DSH 内**从零建立一个 codex 对齐的子 harness**（独立 agent 循环 + 独立提示组装 + 独立审批语义），而不是在现有标准模式上做表面修饰。
2. 接入 **GPT 系模型**（OpenAI 官方 API / OpenAI 兼容端点），使 DSH 能驱动 GPT 模型执行 codex 式编码任务。
3. 该模式下模型获得的**上下文**（系统提示、AGENTS.md、消息结构、压缩策略）与**可调用工具**（名称、schema、执行语义）与原生 Codex CLI **基本一致**。

### 1.2 "基本一致"的对齐等级定义

对齐分四级（本需求以 L2 为目标，L3 条目逐项标注是否纳入 P0）：

| 等级 | 含义 | 验收方式 |
|------|------|----------|
| L1 表面一致 | 工具名、系统提示主要章节相同 | 静态 diff |
| L2 行为一致 | 同一 prompt 下工具调用序列、上下文内容、审批时机基本可复现 | 对照回放 |
| L3 边界一致 | 截断、超时、后台命令、错误消息等边界行为一致 | golden 测试 |
| L4 完全一致 | 含 TUI、账号体系、云端特性 | 不做（见 §10 范围外） |

### 1.3 参考源与版本锁定

- 规范源锁定为本地 checkout 的 HEAD `5bc8da6d78`，关键行为点记录"文件:行号"引用。
- 上游升级时通过 §9 的对照测试重新校准；本地 checkout 保持不动（只读参考）。
- 公开稳定版 Codex CLI 文档作为补充参考（用于区分"本地 checkout 的新工具形态"与"公开稳定行为"的差异）。

---

## 2. 需求分解总览

| 能力域 | 需求点 | 对应 DSH 集成面 |
|--------|--------|-----------------|
| A. 模型接入 | GPT 模型经 OpenAI API 驱动；reasoning effort 映射；SSE 流式 | 新建 `dsh-llm-openai` 适配器（§4） |
| B. 上下文 | codex 系统提示组装、AGENTS.md、fragments、消息结构、compact | 新模式自带提示组装，替换 `dsh-system-prompt` 路径（§5） |
| C. 工具 | codex 工具集（名称/schema/语义） | 复用/改造 `dsh-tool-*` + 新建 `dsh-tool-codex-*`（§6） |
| D. 审批 | approval_policy：untrusted / on-request（默认）/ granular / never | `dsh-user-approval` 扩展 + 工具级策略（§7） |
| E. 沙箱 | sandbox_mode：read-only / workspace-write / danger-full-access + allowlist | `dsh-sandbox-policy` 已有同名模式，需 allowlist 对齐（§7） |
| F. 会话/UI | Web GUI 呈现 codex 会话、审批卡片、权限预设 | `dsh-client-ui-*` 复用（§8） |
| G. 模式形态 | 作为新 agent preset `codex` 挂载 | `dsh-agent-presets`（§3） |

---

## 3. 运行形态："从零建立的 harness"

### 3.1 设计选项

**选项 A：全新独立 codex 循环（推荐，贴合"从零建立"表述）**

- 新建包 `dsh-codex-harness`：自持 loop（提交→流式→解析工具调用→执行→回填→循环）、自持提示组装、自持 compact 逻辑。
- 不依赖 `dsh-agent-loop` 的 `ReactLoopAgent`，但复用其下的原子能力（`ctx.shell`、`ctx.fs`、jobs 注册表、`dsh-llm` 的 `LlmRuntime.stream()`、`dsh-user-approval`）。
- 理由：codex 的语义（call_id 关联的后台 shell、审批时机、`on-failure` 审批、`untrusted` 策略、工具输出截断格式）与 ReactLoopAgent 的通用语义有实质差异，硬塞进通用循环会造成两边互相污染。

**选项 B：在 ReactLoopAgent 上配置 codex 皮（低成本、约 70% 对齐）**

- 只做 preset + 工具 schema 对齐 + 提示词替换，循环语义用 DSH 通用循环。
- 适合先验证模型接入（§4），作为里程碑 M0，不满足 L2 验收。

### 3.2 挂载方式

- 新增 agent preset：`${DSH_HOME}/.agent-presets/codex/`，含 `preset.yml` + `agent.cordis.yml`。
- preset 内用 `isolate` realm 承载本模式独有服务；模型路由、沙箱/审批栈、jobs/session 注册表仍走 host plane（与 `standard` preset 的注释约定一致）。
- 预设只读参考 `D:\Data\DEV\dsh\codex`；升级策略：复制到用户 preset 目录后独立演进，不受部署升级覆盖。

---

## 4. 模型接入（GPT）

### 4.1 现状差距

DSH 当前仅有 `dsh-llm-deepseek`（/chat/completions）与 `dsh-llm-pi-ai` 两个适配器，**没有 OpenAI 适配器**。本需求需新建：

- 包 `dsh-llm-openai`，实现 `dsh-llm` 的适配器接口：`providerInfo` / `providerRetryPolicy` / `listModels` / `resolveModel` / 流式翻译。
- 注册 provider route（建议 `openai-official`），settings 命名空间接入 `dsh-client-ui-settings-models` 现有模型选择 UI。
- 端点：`https://api.openai.com/v1/responses`（Responses API，codex 同协议）为主；`/chat/completions` 兜底；`baseURL` 可配置以支持 OpenAI 兼容端点（与 `LlmModelDiscoveryRequest` 的 `api`/`baseURL` 字段形态一致）。

### 4.2 reasoning effort 映射与适配器插件形态

- 映射 DSH `ReasoningEffortId` ↔ OpenAI `reasoning.effort`（minimal/low/medium/high 或 xhigh，按模型支持面）。
- 默认模型：随本地 checkout 默认值（当前 `gpt-5.5`，见 `codex-rs/core/src/config/mod.rs:330`）；模型清单允许用户经配置覆盖。
- 插件形态对照 `dsh-llm-deepseek`（已验证其注册协议）：插件名 `llm-openai`，注册 `OpenAIAdapter` 到 route（建议 `openai-official`），Config 字段：`apiKeyEnv`（默认 `OPENAI_API_KEY`）、`baseURL`（默认 `https://api.openai.com/v1`，兼容端点可覆盖）、`reasoningEffort` 默认值、`maxTokens`、`defaultContextWindow`、`models` 目录（gpt-5.x 系列）、`retryPolicy`。连接事实按请求解析（密钥/端点变更下一请求即生效），复用 `ctx.credentials` 凭据缝。

### 4.3 与 codex 请求形态的差异清单（复刻注意）

- codex 走 Responses API 的 `input` 数组 + 并行工具调用；DSH `GenerateOptions` 已有 messages/tools/system/reasoningEffort/stop 抽象，翻译层负责差异。
- 错误码映射（429→QUOTA、上下文超限→CONTEXT_WINDOW_EXCEEDED 等）复用 `dsh-llm` 的 `LlmFailure` 体系。

---

## 5. 上下文对齐

> 依据：`research/codex-context-assembly.md`（"core/"=codex-rs/core/src，下同）。

### 5.1 双通道系统提示（核心结构需求）

codex 把系统提示拆两半（Responses API）：

1. **顶层 `instructions`** = 静态基础指令 `BASE_INSTRUCTIONS`（`models-manager/prompt.md`，275 行），章节：身份（"You are a coding agent running in the Codex CLI…"）→ How you work/Personality → **AGENTS.md spec（语义条款，见 §5.2）** → Responsiveness → Planning（+update_plan 工具说明）→ Task execution（"keep going until the query is completely resolved"）→ Validating your work → Ambition vs. precision → Sharing progress updates → 最终回答格式 → Tool Guidelines。
2. **`input` 内的 developer/user 片段消息** = 动态上下文（world state、AGENTS.md、权限说明、环境信息），带标记（marker）逐轮注入/差分更新。

会话启动时 instructions 解析优先级：config `base_instructions` > 恢复会话继承 > 模型模板（`{{personality}}` 占位符渲染）。

**DSH 映射**：`GenerateOptions.system` 承载 instructions；片段消息映射进 `messages` 数组（developer 角色 → DSH 消息模型需支持 developer/user 区分）。DSH 现有 `dsh-system-prompt` 组装路径在 codex 模式内不适用，由 codex harness 自持（§3.1 选项 A）。

### 5.2 AGENTS.md 机制

- **发现**：项目根 = 从 cwd 向上找到 `project_root_markers`（默认 `.git`）为止；收集根→cwd 路径上所有 `AGENTS.md`（`AGENTS.override.md` 优先于 `AGENTS.md`），不越过根；用户级 `~/.codex/AGENTS.md` 最先。
- **注入**：user 角色、`# AGENTS.md instructions … </INSTRUCTIONS>` 标记；总预算默认 32 KiB（`project_doc_max_bytes`），逐文件按剩余预算截断；作为 world-state 节，内容变化时重发 + 替换/移除提示语（"These AGENTS.md instructions replace all previously provided…"）。
- **不解析 section 头**：整文件拼接，嵌套优先/系统提示优先的语义写进系统提示（prompt.md 的 `# AGENTS.md spec`）。
- **DSH 映射**：DSH 需实现同构发现（当前工作区遍历 + 32KiB 截断）；与 DSH 现有 skills/instructions 注入路径并存但不混用。

### 5.3 上下文片段清单（复刻子集）

统一抽象：`ContextualUserFragment{role, markers, body}`；所有片段有界 + 硬上限，单项 ≤10K token（仓库约定，DSH 应做成运行时断言）。

**P0 复刻的 world-state 节**（会话级、按快照 diff 注入，勿每回合全量重发）：

| 节 | 角色 | 标记 | 要点 |
|----|------|------|------|
| model | developer | `<model_switch>` | 换模型时注入完整 instructions（独立消息） |
| permissions | developer | `<permissions instructions>` | 沙箱模式+审批策略+已批准前缀集合 |
| agents_md | user | `# AGENTS.md instructions` | 见 §5.2 |
| environments | user | `<environment_context>` | cwd/shell/状态 + 日期时区 + network/filesystem 权限 |
| tools | developer | `<tools>` | 懒加载 tool namespace 列表（渲染上限 4KiB/描述 250 字符） |
| context_window | developer | `<context_window>` | 窗口 ID + 引导；独立消息 |

**P0 回合级片段**：`CurrentTimeReminder`（`It is {UTC}…`，限频）、`TokenBudgetReminder`（剩余 token 低于阈值）、`TurnAborted`（中断说明）。

**范围外**：personality/realtime/apps/plugins/collaboration/multi-agent/guardian 相关节（依赖 codex 云端或对应 DSH 概念另行映射）。

### 5.4 消息结构与规范化

- ResponseItem：Message{role, content} / FunctionCall{name, arguments, call_id} / FunctionCallOutput{call_id, output} / Reasoning；call_id 一一配对，并行工具调用各持独立 call_id。
- 发送前规范化三不变量：① 每个 call 必须有 output（缺则补合成 `"aborted"`，ID 用 UUIDv5 保证缓存稳定）② 无孤儿 output ③ 模型不支持图片/音频时剥离为占位文本。
- 工具输出按 TruncationPolicy 截断后记录。
- 回合边界：user 消息且**非注入片段**才算新回合。
- **DSH 映射**：DSH `Message`/`ToolCallBlock`/`ToolResultBlock` 已具备同构能力；codex harness 需补 developer-role 消息类型与上述规范化三不变量。

### 5.5 上下文压缩（auto-compact）

- 触发：`active_context_tokens ≥ auto_compact_token_limit`（默认**上下文窗口 90%**）+ fallback buffer；回合前与回合中（token 用尽且 needs_follow_up）两处检查。
- 第三方 harness 可用的实现 = **本地模型摘要**（服务端 memento 压缩无法复刻，见 §5.6）：
  - 摘要提示词 `SUMMARIZATION_PROMPT`（"You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary…"，`prompts/templates/compact/prompt.md`）；
  - 保留最新 ≤ **20K token** 用户消息 + 末尾摘要消息；
  - MidTurn 压缩把初始上下文插到"最后真实用户消息之前"；压缩后重算 token usage；`ContextWindowExceeded` 时从最旧丢项。
- **DSH 映射**：DSH `dsh-compaction-basic` + `dsh-token-meter` 存在但语义不同（阈值/保留策略/摘要提示需换成 codex 版）；codex harness 自持压缩逻辑。

### 5.6 不可复刻项（如实声明，验收时按"已知差异"处理）

1. 服务端远程压缩（memento，V1/V2）。
2. `encrypted_content`（加密 reasoning/工具输出）→ 降级明文 reasoning。
3. `prompt_cache_key` 前缀缓存语义 → 结构上保持"只增前缀、不重写历史"，缓存命中率差异接受。
4. Responses API `instructions` 顶层参数与 developer 消息的后端差异 → 按 GPT 目标模型选 messages 映射方式。
5. 模型元数据（ModelMessages 模板）→ 本地固化一份 GPT 模型指令模板。
6. token 估算启发式（字节/4）→ 用更精确 tokenizer 替换。
7. 多执行环境（environments/exec-server）→ 单环境实现。

---

## 6. 工具对齐

> 依据：`research/codex-tools-inventory.md`（spec_plan.rs + features 默认值全量核对）。

### 6.0 关键事实：对齐目标的工具面真相（先读这条）

规范源 HEAD `5bc8da6d78` **没有** `read` / `edit` / `write` / `todo_write` / `notebook_edit` / `notebook_read` 工具：

- 文件读取 = shell 命令（cat/rg/sed/ls/git show/nl/wc，系统提示明确引导）；文件编辑 = freeform `apply_patch`；交互命令 = `exec_command` + `write_stdin`。
- 计划工具叫 **`update_plan`**（`todo_write` 改名只在未合入的远端分支）。
- 上述"经典工具"是 ChatGPT Codex 云端产品的工具面，不是开源 CLI 的。**复刻目标若为"现代开源 codex CLI"，不要实现 read/edit/write；若用户要的是 ChatGPT Codex 产品手感，那是另一套 hosted 工具面**（→ 决策点 D1）。

### 6.1 默认工具总表（P0 复刻目标集 = 默认配置下的模型可见集）

| codex 工具 | 关键入参（要点） | 出现条件 | DSH 落点 |
|-----------|-----------------|----------|----------|
| `exec_command` | cmd(必填)、workdir、tty、yield_time_ms(默认10000)、max_output_tokens(10000)、shell、login、sandbox_permissions、justification、prefix_rule、additional_permissions | UnifiedExec + 有环境 | **新建** `dsh-tool-codex-exec`（改造 `dsh-tool-bash-persistent` 的 PTY 会话模型：session_id、yield、输出 delta、进程上限 64、输出 1MiB/10k token） |
| `write_stdin` | session_id(必填)、chars(空=轮询)、yield_time_ms | 同上 | 同上包内第二个工具 |
| `apply_patch`（freeform） | 自由文本 patch：`*** Begin/Add File/Update File/Delete File/Move to/End Patch` | 模型元数据声明 Freeform | **新建** `dsh-tool-codex-apply-patch`（Lark grammar 解析 + fs 变更 + 审批，非 JSON function） |
| `update_plan` | plan[{step,status(pending/in_progress/completed)}]、explanation | update_plan_enabled（默认 true） | **新建薄壳**或改造 `dsh-tool-todo`（schema 与事件语义对齐，事件=PlanUpdate） |
| `request_user_input` | questions 1-3 个 {id,header≤12,question,options 2-3} | 默认 true；DirectModelOnly | **复用** `dsh-tool-ask-user`/`dsh-user-questions`（结构几乎同构，需对齐上限与返回格式） |
| `view_image` | path(必填)、detail(high/original) | ViewImage + 有环境 | **复用** DSH `read_image`，schema 对齐 + 输出 `{image_url,detail}` 形状 |
| `tool_search` | query(必填)、limit(8) | 模型 supports_search_tool | **新建**（BM25 over deferred 工具目录；若 DSH 模型路由无此元数据则按模型可配） |
| `web_search`（hosted） | 服务端参数（filters/user_location/context_size…） | provider 支持 + 模式非 Disabled | **不可复刻**（服务端执行）；用 DSH `dsh-tool-web` 的 `web_search` 替代并**如实标注 schema 差异**（DSH: query/sources） |
| `web.run`（ns `web`） | search_query/open/click/find/screenshot/… | StandaloneWebSearch（默认关） | P1 可选：独立 web 扩展替代 hosted |
| `multi_agent_v1.spawn_agent` 等 5 个 | spawn/send_input/resume/wait(timeout 10s–1h)/close | Collab V1 | **映射** DSH subagent 体系（`dsh-tool-subagent` + control/list/send/interrupt；wait_agent 语义由后台任务化替代） |
| `collaboration.*`（V2，6 个） | spawn(task_name+message)/send/followup/wait/interrupt/list | MultiAgentV2（默认关） | P1（DSH 现工具体系与 V2 高度同构，可作映射目标） |
| `mcp__<server>.<tool>` | MCP schema；fileParams 掩码 | 配置了 MCP server | **复用** `dsh-mcp-client`；对齐 `mcp__` 前缀命名（sanitize ≤64 字节/冲突加哈希） |
| `list_mcp_resources` 等 3 个 | server/cursor/uri | 有 MCP server | 同上包 |
| 默认关（clock.*/get_context_remaining/new_context/request_permissions/wait_for_environment/test_sync_tool/插件工具） | — | 各 feature 默认关 | **不纳入 P0**；仅保留 feature 开关位 |

**明确排除**：`shell_command`（unified 生效时 Hidden，不注册）；Guardian 审核会话 3 工具模型（范围外）；`exec`/`wait` code-mode（DSH 已有独立 Code Mode SDK 预设，不复刻此通道）。

### 6.2 工具语义要点（复刻不可省）

- **exec_command**：`supports_parallel_tool_calls=true`；**无独立 kill 工具**（终止=write_stdin 写控制字节或进程自然结束）；回包文本前缀（"Chunk ID:"/"Wall time:"/"Process exited with code N"/"Process running with session ID N"）与截断警告（"Warning: truncated output (original token count: N)"）需一致——模型提示词会依赖这些串。
- **apply_patch**：freeform（模型输出纯文本 patch，不包 JSON）；exec_command 内嵌 `apply_patch` 命令会被拦截转原生执行；解析失败返回错误文本；多环境 `*** Environment ID:` 行（单环境可省）。
- **update_plan**：Plan 协作模式（DSH plan mode 对应物）调用报错；事件 `PlanUpdate` 渲染给用户。
- **schema 条件生成**：exec_command 的 `shell`/`login`/`environment_id`/`additional_permissions` 参数按运行时配置**条件出现**（登录 shell 策略/环境数量/ExecPermissionApprovals）——schema 必须按同样条件生成，否则训练分布错位。

### 6.3 exposure/deferred 体系（模型可见性）

- 模型可见 = `Direct | DirectModelOnly`；Deferred 工具（MCP、collab V1）默认经 `tool_search` 延迟暴露。
- DSH 侧需求：`search_tool_enabled`（模型元数据开关）决定 MCP 工具是 Direct 还是 Deferred；**不复刻 deferred 链路则模型看不到 MCP 工具**——P0 若简化，必须显式把 MCP 设 Direct 并记录差异。

### 6.4 与公开稳定版的差异（勿照抄旧文档）

`shell`→`exec_command`/`write_stdin`（unified exec）；`tool_search` 为新增；`update_plan` 名称不变；`web_fetch` 不存在。复刻以 HEAD 源码为准（详见调研报告 §4）。

---

## 7. 审批与沙箱对齐

> 依据：`research/2026-08-14-codex-approval-sandbox.md`（60+ 条 `文件:行号` 证据，下称"报告"）。

### 7.1 approval_policy 语义表（复刻目标）

| codex 取值 | 语义 | DSH 落点 |
|-----------|------|----------|
| `untrusted` | 仅命中安全命令名单自动放行，其余一律弹窗 | 循环/工具层实现 |
| `on-request`（**默认**；`on-failure` 为历史别名） | 模型自行决定何时请求审批；受限沙箱下普通命令直接跑、沙箱兜底 | 循环/工具层实现 |
| `granular` | 5 个独立开关：sandbox_approval / rules / skill_approval / request_permissions / mcp_elicitations | 配置映射 |
| `never` | 永不弹窗；需弹窗的命令直接 Forbidden | 复用 DSH `never`，语义对齐为"Forbidden 而非静默执行" |

**关键语义变化（规范源 HEAD 已生效）**：旧的"on-failure 事后弹窗重试"已取消——`never`/`on-request` 下沙箱拒绝**不重试、不弹窗**，直接返回模型；升级只有一条路：模型显式传 `sandbox_permissions: require_escalated`（带 justification）或 `with_additional_permissions`（报告 §1.4）。复刻必须遵守此行为，不能照搬旧文档。

### 7.2 命令分类（决策三元组 + 规则）

- 决策三元组 `Allow / Prompt / Forbidden`，多规则命中取**最严格**（Forbidden > Prompt > Allow）。
- 三层判定：① `.rules` 前缀规则（Starlark，含 justification/示例校验）→ ② 未匹配启发式：危险黑名单（Prompt，never 则 Forbidden）、安全白名单（仅 untrusted 自动放行）、受限沙箱兜底放行 → ③ shell 降级解析（`bash -lc` 拆子命令逐条评估；命令规范化为审批缓存键）。
- 需要复刻的名单（原文见报告 §1.3）：
  - **安全白名单**：`cat cd cut echo expr false grep head id ls nl paste pwd rev seq stat tail tr true uname uniq wc which whoami`；受限形式 `base64`(禁 -o)、`find`(禁 -exec/-delete 等)、`rg`(禁 --pre 等)、`git`(仅 status/log/diff/show/branch 只读)、`sed -n p`。
  - **危险黑名单**：force 删除（`rm -f/--force`、`sudo rm`、trap 内等，递归深度≤8）；Windows 另有 `Remove-Item -Force`、`del /f`、`rd /s /q`、URL 启动 GUI（Start-Process/mshta/explorer 等）。
  - **Windows 安全名单**：仅 PowerShell 调用 + 只读 cmdlet 白名单（`echo/dir/gc/select-string/test-path/get-item/git/rg`…），禁写类 cmdlet、重定向、`&`、`-EncodedCommand`。

### 7.3 sandbox_mode 语义（DSH 已同名，需对齐细节）

| 模式 | codex 语义 | DSH 现状 |
|------|-----------|----------|
| `read-only` | 全盘只读（`:root=read`） | 已有 |
| `workspace-write` | root=read + workspace_roots=write + tmp 可写；可写根下 `.git`/`.agents`/`.codex` 元数据强制只读 | 需核对对齐元数据保护 |
| `danger-full-access` | 无限制 | 已有 |

- 网络默认禁（受限模式注入 `CODEX_SANDBOX_NETWORK_DISABLED=1` 语义）→ DSH 侧需在受限模式给子进程同等信号/策略。
- deny-read 存在时**禁止无沙箱升级**（升级即绕过 deny-read，codex 强制）。

### 7.4 Windows 降级策略（本机 = Windows，核心需求）

codex 在 Windows 上的答案是"默认关沙箱 + 策略降级 + 更严审批"，DSH 复刻同一策略：

1. 无沙箱后端时 `workspace-write` 强制降级 `read-only`（对齐 `config_toml.rs:759-767`）。
2. 无沙箱后端 + 受限 profile 时，未匹配命令**不自动放行**、一律审批/禁止（`exec_policy.rs:754-780`）。
3. Windows 默认 deny-read 名单：用户目录下 `.ssh .tsh .brev .gnupg .aws .azure .kube .docker .config .npm .pki .terraform.d`（`windows-sandbox-rs/src/setup.rs:55-68`）。
4. macOS/Linux 现代版**不内置** ~/.ssh 类 deny——DSH 复刻按平台同构处理。
5. 可选增强（P2）：受限令牌 + ACL + WFP 的进程级沙箱（codex `windows-sandbox-rs` 路线，工作量大，不做默认）。

### 7.5 后台命令与交互 shell（unified_exec 语义）

- `exec_command`（PTY）参数：`cmd, workdir, tty, yield_time_ms, max_output_tokens, shell, login` + 审批参数；**无 background 布尔**——未在 `yield_time_ms` 内结束即返回 `session_id`。
- `write_stdin`：`session_id + chars + yield_time_ms`；空写=轮询（5s–300s），非空写 ≤30s。
- 上限：64 进程、输出 1MiB/10k tokens；超时默认 10s、退出码 124；取消/超时杀**进程组**（TERM 50ms 后 KILL）。
- 输出增量事件 `ExecCommandOutputDeltaEvent{call_id, stream, chunk}`——DSH 工具卡片需按 call_id 流式渲染。

### 7.6 审批事件 → DSH 审批卡片字段需求

codex `ExecApprovalRequestEvent` 字段即 UI 需求全集：`command(完整 argv) / cwd / reason / available_decisions / network_approval_context{host,protocol} / proposed_execpolicy_amendment / additional_permissions / call_id`。`available_decisions` 按上下文动态计算（普通=Approved/修规则/Abort；带权限=Approved/Abort；网络=AllowOnce/ForSession/修规则/Abort）。DSH 审批卡片需承载同等字段与按钮，并支持会话级审批缓存（规范化命令键）。

### 7.7 网络与 hooks（分级）

- 网络审批：codex 依赖 MITM 代理 + 域名策略，未命中 allowlist 同步弹窗（AllowOnce/ForSession/持久化规则）。DSH 复刻分两级：**P0**=域名 allowlist/denylist 预检（不做 MITM，无法连接瞬间拦截，如实声明差距）；**P2 可选**=MITM 代理完整复刻。
- hooks（PreToolUse 可 deny/改写入参、PermissionRequest 审批前裁决、PostToolUse）：**P1** 复刻 PermissionRequest+PreToolUse 的裁决接口；完整 Claude-hooks 兼容层为 P2。
- Guardian LLM 自动审批子代理：**范围外**（依赖 codex 云侧），接口留 `approvals_reviewer` 配置位但仅 `user`。

### 7.8 配置键映射（codex config.toml → DSH settings）

`approval_policy` / `sandbox_mode` / `sandbox_workspace_write{writable_roots, network_access}` / `default_permissions` / `[permissions.<name>]` / `[windows]` / `deny_read`（requirements 层）→ 映射到 DSH 的 `sandbox-policy` 配置 + codex 模式专属 settings 命名空间。requirements.toml 托管强制语义（只许更严、规则只许 prompt/forbidden）由 DSH 部署策略层对应实现（可选）。

### 7.9 DSH 侧差距清单

1. `dsh-user-approval` 现有 policy 仅 `ask`/`never` → 需新增 `untrusted`/`on-request`/`granular` 或在 codex 循环内实现等价策略层（**策略层是纯数据逻辑，可 1:1 复刻**）。
2. 审批卡片字段扩展（§7.6）。
3. `dsh-sandbox-policy` 需支持：deny-read 路径规则、workspace-write 元数据保护（.git/.agents/.codex）、Windows 降级链（workspace-write→read-only）。
4. `dsh-tool-bash` 的执行语义需对齐 unified_exec（yield_time_ms/session_id/write_stdin/进程组 kill/输出 delta）。
5. 本机 DSH 默认 `danger-full-access + never`（profile 补丁层），codex 模式预设需自带更严默认（workspace-write + on-request；Windows 无沙箱后端时自动降级 read-only，见 §7.4），不改变其他模式。

---

## 8. 会话与 UI

- codex 模式会话继续走 DSH Web GUI：`dsh-client-ui-tool` 呈现工具卡片（shell 命令、diff、后台任务状态），`dsh-client-ui-permission-presets` 呈现三档沙箱+审批预设切换。
- 审批在网页卡片完成；原生 TUI 不复刻（范围外）。
- 会话持久化走 `dsh-session-persistence-jsonl`，满足 codex 式"恢复会话/继续"要求。

---

## 9. 验收标准

- [ ] 模型层：`dsh-llm-openai` 驱动 gpt-5.x 完成一次多轮工具调用会话，流式与 usage 正确。
- [ ] 上下文层：codex 模式系统提示与规范源章节 diff ≤ 允许偏差清单（逐节标注）。
- [ ] 工具层：默认配置下注册的工具集名称集合 == 规范源默认工具集（对照清单）。
- [ ] 行为层：取 3-5 个固定任务 prompt（含 修改文件/后台命令/权限请求/网页搜索），在原生 codex（同模型）与本模式分别运行，比对工具调用序列与关键输出；差异逐条分类为"接受/缺陷"。
- [ ] 审批层：untrusted / on-request / never（granular 为 P1）策略在 DSH 审批 UI 上的行为符合 §7.1 语义表（含 require_escalated 升级路径）。
- [ ] 沙箱层：workspace-write 下 allowlist/denylist 行为与规范源一致（含 Windows 降级路径）。

---

## 10. 范围外（Out of scope）

- TUI 复刻、账号体系（ChatGPT 登录/订阅）、云端特性（guardian、managed sandbox、hosted web_search 服务端执行、collaboration/remote sessions、cell-based code-mode runtime 的远端执行后端）。
- seatbelt/landlock/seccomp 内核沙箱在 Windows 上的真实实现（只做与 codex 一致的降级）。
- codex review 子命令、slash 命令、插件市场（plugin install）。

---

## 11. 风险与开放问题

- [?] 本地 checkout 处于内部重构期（unified_exec / exec_command / code-mode cells），工具集形态与公开稳定版差异大——对齐目标版本需用户确认（见 §13 决策点 D1）。
- [?] GPT 模型在非 codex 提示体系下的行为漂移（reasoning 长度、工具调用风格）。
- [!] Responses API 的 `web_search` 是服务端工具，DSH 侧需用本地实现代替，行为不可能完全一致。
- [!] 上下文注入的缓存友好性：频繁变化 fragment 会导致 OpenAI 侧缓存失效、成本上升（codex 自身也有此约束）。
- [?] `require_escalated`（模型显式请求无沙箱升级）在网页 UI 的交互节奏需 UX 设计（codex HEAD 已无旧 on-failure 事后弹窗）。

---

## 12. 里程碑分期（建议）

- **M0（模型接通）**：`dsh-llm-openai` + 最小会话流（可用选项 B 皮验证）。验收：GPT 在 DSH 跑通。
- **M1（工具与上下文静态对齐）**：codex 工具 schema + 系统提示组装 + AGENTS.md。验收：静态对照清单全绿。
- **M2（独立循环与审批语义）**：`dsh-codex-harness` 循环、后台 shell、on-failure/on-request、compact。验收：§9 行为层对照。
- **M3（打磨）**：UI 呈现、权限预设、错误消息与截断边界、文档。

---

## 13. 决策点（已确认 2026-08-14）

- **D1 对齐目标与执行后端（已定）**：以本地 checkout HEAD 为规范源（工具面 = `exec_command`/`write_stdin` + freeform `apply_patch` + `update_plan` + …，**不含 read/edit/write/todo/notebook**）；但 **exec 执行后端用 git bash 替代**——即保留 HEAD 的工具名与 schema（yield_time_ms/session_id/write_stdin），底层执行走 DSH 现有 bash seam（git bash，pwsh 禁用），不做 Windows conpty unified-exec 后端。
- **D2 模型接入（已定）**：OpenAI 官方 API（Responses API）为主 + `baseURL` 可配置兼容端点。
- **D3 界面形态（已定）**：仅 DSH Web GUI。
- **D4 实施（已定）**：按 M0→M3 全量实施，项目命名 **`dsh-codex`**（核心包 `dsh-codex`，preset id `codex`）。

---

## 附录 A：参考资料索引

### codex 仓库（D:\Data\DEV\dsh\codex）

- 工具注册/筛选：`codex-rs/core/src/tools/spec_plan.rs`
- 工具规范枚举：`codex-rs/tools/src/tool_spec.rs`
- 执行策略：`codex-rs/core/src/exec_policy.rs`
- 默认模型：`codex-rs/core/src/config/mod.rs:330`
- 提示模板：`codex-rs/prompts/`；基础指令正文：`codex-rs/models-manager/prompt.md`（275 行）
- 上下文片段：`codex-rs/core/src/context/`（world_state 各节 + 回合级片段）
- 消息规范化：`codex-rs/core/src/context_manager/normalize.rs`
- 压缩：`codex-rs/core/src/compact.rs`、`codex-rs/prompts/templates/compact/`
- 审批/沙箱全套证据：见 `research/2026-08-14-codex-approval-sandbox.md` 的 Evidence Chain 表
- 上下文全套证据：见 `research/codex-context-assembly.md`（§1–§7 均附文件:行号）
- 工具集清单：见 `research/codex-tools-inventory.md`（默认工具总表 + gating 行号 + 公开版差异）

### DSH（本机部署）

- profile 补丁层：`C:\Users\30280\.dsh\profiles\web\cordis.patch.yml`
- 预设样例：`<dsh>\config\agent-presets\standard\agent.cordis.yml`
- LLM 接口：`dsh-llm/lib/types/types.d.ts`（`LlmConfigurableProvider`/`GenerateOptions`/`StreamChunk`）
- 审批：`dsh-user-approval`（`ApprovalRequest`、policy `ask`/`never`）
- 沙箱：`dsh-sandbox-policy`（`read-only`/`workspace-write`/`danger-full-access`）

## 附录 B：静态对齐对照表（§9 验收证据，2026-08-14/15）

### B.1 工具集（codex HEAD 默认配置 vs codex 预设）

| codex 工具 | codex 默认出现 | DSH codex 模式 | 状态 |
|-----------|---------------|----------------|------|
| `exec_command` | ✅ UnifiedExec+环境 | `tool-codex-exec`，git bash PTY 后端，yield/session_id/退出码标记/64 上限 + 审批闸 | ✅ 已对齐（schema 逐字段同；`shell` 校验 bash/shell/git-bash 映射 git-bash 后端，`login`/`tty` 为兼容占位） |
| `write_stdin` | ✅ | 同上（空写轮询 5s–300s / 非空写 ≤30s） | ✅ |
| `shell_command` | Hidden（unified 生效） | 不注册 | ✅（Hidden 等价） |
| `apply_patch` | ✅（模型元数据声明） | `tool-codex-apply-patch`（状态机移植、seek 序列、EOF 锚定、父目录自动创建、heredoc 剥离）；描述逐字（`apply_patch_spec.rs:20`） | ✅ **`openai-responses` 路由上真 freeform**（custom 工具 + lark 语法逐字，裸 patch 文本无 JSON）；`openai-official`（chat-completions）退化为 JSON 函数（该 wire 无 custom-tool 类型） |
| `update_plan` | ✅ | `tool-codex-plan` + `plan` 会话投影 | ✅ |
| `request_user_input` | ✅ DirectModelOnly | `tool-codex-request-user-input`（1-3 问校验） | ✅（DirectModelOnly 无对应概念，备注） |
| `view_image` | ✅ | `tool-codex-view-image`（附件存储 + 真实图片块，M3） | ✅ |
| `tool_search` | ✅（模型 supports_search_tool） | 未实现（DSH 模型路由无该元数据） | ⏳ P1 已知差异 |
| `web_search`（hosted） | ✅（provider 支持） | DSH `web_search`（tool-web, fetch:false）替代 | ✅ 替代（schema 差异注明） |
| `web.run` / `image_gen.imagegen` | ❌ 默认关 | 不注册 | ✅ |
| `multi_agent_v1.*`（5 个） | ✅ Collab 默认开 | `tool-codex-multi-agent`（spawn_agent/send_input/resume_agent/wait_agent/close_agent 映射 DSH subagent 缝；agent_type/service_tier/reasoning_effort 为 schema 占位） | ✅ 已映射（P1 项，本轮完成；命名扁平 + resume 语义近似已注明） |
| `collaboration.*`（V2） | ❌ 默认关 | 不注册 | ✅ |
| `mcp__<server>.<tool>` | 视配置 | `dsh-mcp-client` 模板行（用户配置 server 即启用，命名 `mcp__<server>__<raw>`） | ✅ 模板（命名略异，备注） |
| `clock.*`/`get_context_remaining`/`new_context`/`request_permissions`/`wait_for_environment`/`test_sync_tool`/插件工具 | ❌ 默认关 | 不注册 | ✅ |
| Guardian 审核 3 工具会话 | 独立场景 | 不适用 | ✅ 范围外 |

### B.2 上下文（§5）

| 项 | 状态 |
|----|------|
| BASE_INSTRUCTIONS 275 行移植（全部章节） | ✅ 逐字节 diff 验证（body == 源 + 3 处适配） |
| 双通道提示（system + 片段消息） | ✅ DSH `GenerateOptions.system` + messages 承载 |
| AGENTS.md（.git 根/32KiB/override 优先） | ✅ `dsh-agent-instructions` 显式配置（注入措辞与 codex `</INSTRUCTIONS>` 标记不同，语义等价，备注差异） |
| **DSH 平台段落泄漏（`app:web-surface`/`tool:bash`/`tool:web_search`/`tool:web_fetch`/`ui:deliverable-file-references`）** | ✅ **`tool-codex-prompt-align`（2026-08-15）**：scoped 空文本 shadow 移除（含误导性 `exit code marker` 尾部）；`harness:identity` 保留 |
| **world-state 片段：`<environment_context>`** | ✅ **prompt-align**（2026-08-15）：legacy-single 形状（`cwd`/`shell`/`current_date`/`timezone` + 文件系统权限形状映射 DSH 沙箱模式）；network 省略（DSH 无域名模型，codex 无网络配置时同样省略） |
| **回合级片段：`<current_time_reminder>`** | ✅ **prompt-align**（2026-08-15，2026-08-17 行为修正）：逐字标记 + `It is {UTC}.`。**限频注入（codex `take_reminder_due` 移植）**：默认 `reminderIntervalSeconds=60`（codex 默认 1s——dsh 差分粒度是"全部段合成一个 joined snapshot"，秒级 tick 会把稳定的 environment/策略段每步都拖着重渲染，违背 codex 独立片段的缓存友好差分；60s 保持时间新鲜度同时让快照在工具循环内 diff 免疫；可配任意 u64，设 1 即 codex 逐字对齐）。按会话（agent）限频，间隔内文本恒定 → dsh-agent-loop 的 joined-diff 跳过，稳定段只注入一次 |
| world-state 片段（model/permissions/tools/context_window） | 部分（权限=DSH 快照措辞，保留为必要差异；model/tools/context_window 未复刻 ⏳） |
| 消息规范化三不变量 | 部分（DSH 循环自带成对/孤儿清理；UUIDv5 合成 ID 未复刻）⏳ |
| 压缩（90%/20K/SUMMARIZATION_PROMPT） | ✅ `harness/codex-compactor.js` 已接入预设 compaction 组，冒烟 ALL PASS |

### B.3 审批与沙箱（§7）

| 项 | 状态 |
|----|------|
| 策略层（安全/危险名单、git 规则、Windows 形式、规范化、四策略矩阵） | ✅ `policy/exec-policy.js` 冒烟全绿 |
| 执行闸（classify → DSH 审批缝；never 覆盖；require_escalated；unrestricted Skip） | ✅ 织入 exec_command，5 路径冒烟 |
| 审批编排（决策词汇/动态决策集/会话缓存/拒绝升级矩阵） | ✅ `harness/approvals.js` 冒烟 |
| granular / untrusted 会话级切换 | ⏳ P1（DSH 会话 policy 仅 ask/never；插件 config.policy 已留 untrusted 档） |
| sandbox_mode 三档 | ✅ DSH 同名模式 + Windows 降级链待运行时验证 |
| 网络审批 MITM | ❌ 范围外（P2 可选） |
| hooks 兼容层 | ❌ 范围外（P2 可选） |

### B.4 工具行为对照测试（2026-08-15/16 更新，fixture 提取自官方 HEAD 测试）

| 对照面 | fixture 来源 | 测试 | 状态 |
|--------|-------------|------|------|
| exec-policy 决策矩阵（safe/dangerous 名单） | shell-command/src/command_safety/is_safe_command.rs + is_dangerous_command.rs 官方单测 | alignment/exec-policy.alignment.smoke.js（172 safe + 46 dangerous 用例 × linux/win32） | ✅ ALL PASS。2026-08-16 追加第 8 条 forced_rm_in_complex_shell_syntax_is_dangerous（MDE review 循环脚本）；实现修复：sed -n 长度上界（is_safe_command.rs:159-168 要求 len ≤ 4）、bash -lc 空命令位拒绝（ls && / && ls / ;; / | |，tree-sitter 解析错误等价）、受限沙箱 + 显式升级时已知安全命令也 prompt（exec_policy.rs:800-811）、canonicalize 键元素改为 shell 标志 -lc/-c（command_canonicalization.rs:21-28） |
| exec_command 结果文本格式 | core/src/tools/context.rs response_text()/truncated_output()（412-468）+ unified_exec（head_tail_buffer.rs、utils/string/truncate.rs、utils/output-truncation） | alignment/exec-command.alignment.smoke.js（7 用例） | ✅ ALL PASS。2026-08-16 重写对齐：Chunk ID: 段（generate_chunk_id 6 hex）、Original token count: 恒输出（Option 恒 Some）、段序 Chunk ID → Wall time → exit → session → tokens → Output:；截断改中截断 …N tokens truncated… + Total output lines: L 前缀 + 1 MiB 采集帽 ... N bytes omitted ...；win32 exec_command yield 下限 10000ms（WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS）；max_output_tokens 按 token 计（默认 10000，chars=tokens×4）；会话 id 随机 1000..100000；64 进程上限改 LRU 驱逐（不报错）；write_stdin 非 Ctrl-C 输入抛官方 StdinClosed 错误（write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open）、Ctrl-C 中断后信号死亡不渲染 exit-code 段、删除全部合成提示串；输出 schema = unified_exec_output_schema（chunk_id/wall_time_seconds/exit_code/session_id/original_token_count/output，required [wall_time_seconds, output]）。2026-08-16 追加 justification 空串豁免回归：gpt-5.6（cc-switch OpenAI wire）在每次调用都回声可选字段（`justification:""` + `sandbox_permissions:"use_default"` + `prefix_rule:[]`/`shell`/`login`/`tty`/`max_output_tokens`/`workdir`/`yield_time_ms` 全量），旧守卫对这些"回声形态"硬失败（`justification requires an explicit sandbox_permissions`，2026-08-16 10:20 会话复现）；实现修复：空/纯空白 justification 视为省略放行（trim 判空），非空 justification 无 `require_escalated` 仍按 handlers/mod.rs shared rule 拒绝；exec-command.smoke.js 增补回声形态回归用例。2026-08-16 追加自适应升级窗口（sandbox 概念 dsh 适配）：codex 的 sandbox 是 dsh 不复刻的 OS 隔离层，故沙箱词汇只在「DSH 宿主沙箱受限 + 审批可弹窗」的会话里有意义（escalationLive = fs.sandboxMode ∉ {undefined, danger-full-access} ∧ 有效策略 ≠ never）；窗口外 `sandbox_permissions`/`justification`/`prefix_rule` 全部惰性化——接受并忽略、永不硬失败（原"非空 justification 无 require_escalated 一律拒绝"改为仅窗口内生效）；窗口内 codex 配对规则与审批流不变（冒烟覆盖两个窗口 + prefix_rule）；`prefix_rule` 落地：窗口内审批通过的升级请求携带 prefix_rule 时按 token 前缀写入会话级审批缓存，后续匹配命令免弹窗（rm -rf build 用例）；prompt-align 新增 codex:sandbox-escalation 运行时上下文段（order 116），按会话告知模型字段是 LIVE（require_escalated + justification）还是 INERT（省略），与 DSH approval never 的 NEVER_SENTENCE 同思路；exec-command.js?v=6、prompt-align.js?v=2。2026-08-17 行为修正（时间提醒限频）：`<current_time_reminder>` 改为**会话级限频注入**（`createTimeReminder`，默认 `reminderIntervalSeconds=60`，codex `take_reminder_due` 移植）——dsh 的 agent-loop 按「全部上下文段合成的 joined 文本」做 diff，秒级时间戳（原 codex 默认 1s）会让稳定的 environment/sandbox-escalation/策略段每步重渲染重注入；60s 间隔内文本恒定 → joined-diff 跳过、稳定段只注入一次，对齐 codex「独立上下文片段差分、缓存友好」的模型（codex AGENTS.md rule #2）。可配任意 u64，设 1 即 codex 逐字对齐；prompt-align.js?v=3 |
| apply_patch 输入输出（成功/失败路径） | core/tests/suite/apply_patch_cli.rs + apply-patch/tests/suite/{scenarios,tool}.rs + streaming_parser.rs | alignment/apply-patch.alignment.smoke.js（29 用例） | ✅ ALL PASS（2026-08-16 从 9 扩到 29）。新增：重复目标路径拒绝（invalid patch: multiple operations target {abs}）、验证先行无副作用（Add+Update-missing 全盘不写）、空 patch patch rejected: empty patch（safety.rs，无 verification 前缀）、move 覆盖既有目标、add 覆盖既有文件、EOF 锚点、上下文消歧、第二 chunk 缺上下文、scenarios 016-022（纯插入/空白补丁标记/Unicode/仅删除/EOF 标记/空 update hunk/删目录）、*** Environment ID: 解析（合法/重复/空，streaming_parser.rs:84-101）。实现修复：验证阶段先读后写（try_verify_apply_patch_args）、删除目录在验证期报 Failed to read {abs}: Is a directory (os error 21)、*** End Patch 前导空白容忍（finish() 先 trim）、环境 id 错误用 invalid patch: 前缀、错误路径全部用绝对路径 + Rust io 错误拼写（No such file or directory (os error 2)）、Wall time 1 位小数（format_exec_output_for_model）、输出末尾换行 |
| 工具 schema 结构（全 11 工具） | core/src/tools/handlers/{shell_spec,plan_spec,view_image_spec,request_user_input_spec,multi_agents_spec,apply_patch_spec}.rs | alignment/tool-schema.alignment.smoke.js（11 工具；描述逐字比对） | ✅ ALL PASS（26 项文档化差异豁免：DSH defineTool 开放参数根、exec_command.login 恒在、multi_agent_v1 描述为 DSH 改写（fork_context 描述为官方原文；语义经 `fork` provider 落地，见下）、wait_agent.task_ids 扩展、apply_patch 内部 JSON 传输、namespace 差异、exec_command 描述改简短 git-bash 契约（2026-09-03，删除 PowerShell 安全规则文本，见 exec-command.js EXEC_COMMAND_DESCRIPTION 注释））。修复：write_stdin 描述与参数描述逐字对齐；exec_command 描述与参数描述先逐字对齐（含 Windows safety rules 文本）后于 2026-09-03 转为有意偏离——官方 win32 文本的 PowerShell 安全规则在本部署具误导性（实测 gpt-5.6 三次并发提交 shell:"powershell.exe" 全部被拒，唯一 shell 是 git bash），现为简短 git-bash 契约，shell 参数描述由 SHELL_VALUES 生成防漂移；sandbox_permissions 枚举收敛为 [use_default, require_escalated]、输出 schema 对齐、update_plan/view_image/request_user_input/multi_agent schema 对齐 |
| 其余工具行为（update_plan/view_image/request_user_input/multi_agent） | plan_spec.rs/plan.rs、view_image.rs、request_user_input_spec.rs、multi_agents_spec.rs | 对应 tools/*.smoke.js | ✅ ALL PASS。修复：update_plan 去掉空 plan/空 step/多 in_progress 校验（官方只查枚举与未知字段），输出文本 Plan updated；view_image 官方错误串（unable to process image: invalid or unsupported image data 等 5 条）、去扩展名门禁与 200KB 硬错误、data URL MIME 固定 application/octet-stream、输出 schema 仅 image_url；request_user_input 必填 [id,header,question,options]、只保留 options 非空校验（request_user_input requires non-empty options for every question）、响应形 {answers: {id: {answers: [...]}}}、取消时 request_user_input was cancelled before receiving a response；multi_agent wait_agent.targets 必填 + {status: map, timed_out}、spawn_agent message 可选 + items/fork_context、send_input→submission_id、close_agent→previous_status、resume_agent→status、timeout_ms ≤ 0 拒绝、message/items 互斥与空值错误串。2026-08-16 追加回声噪声归一化回归（对齐 exec_command 的 blank-justification 豁免思路）：gpt-5.6 回声全部可选字段，实测失败形态为真实 message + 全空 stub items 数组（`[{audio_url:"",image_url:"",name:"",path:"",…}]`）→ 旧校验抛 `Provide either message or items, but not both`（2026-08-16 10:21 会话复现）；实现修复：真实 message 胜出 items 的空载荷回声——items `[]`（18:37 会话形态：真实 message + `items:[]`）或全 stub 数组伴随非空 message 时视为省略、message 放行；反向（空白 message + 真实 items）items 胜出；无 message 时单独的 `items:[]` 仍保留 codex `Items can't be empty` 错误、单独全 stub 数组仍保留 one-of 错误、单独空白 message 仍保留 `Empty message can't be sent to an agent`；stub 条目在渲染前过滤；非数组 items 不参与互斥（schema 层已拒 null）；`spawn_agent` message + `items:[]` + `fork_context:true` 回声形态冒烟回归（multi-agent.js?v=4）；`fork_context` 落地（2026-08-16 下午）：true → 选 DSH `fork` 子代理 provider（子代理 seed 继承父已完成回合历史，对应 codex fork 语义）；false/省略 → 配置 provider（默认 `spawn`，全新无历史子代理）；部署未注册 `fork` provider 时回退配置 provider（`ctx.subagents.getProvider` 判定）；描述恢复官方原文，schema 对照豁免移除（26 项）；归一化逻辑收敛到共用模块 `tools/echo-noise.js`（isBlankText/omitBlank/meaningfulEntry/stripStubEntries），exec_command 与 multi_agent 共享 |
| 压缩与审批（compact/approvals） | compact.rs、utils/string/truncate.rs、protocol/src/approvals.rs | harness/compact.smoke.js、harness/approvals.smoke.js | ✅ ALL PASS。修复：COMPACTION_WARNING 第二句逐字（Start a new thread when possible...）、截断改中截断 + …N tokens truncated… 标记（truncate.rs）、approxTokens 按 UTF-8 字节/4、REVIEW_DECISION 值改官方 snake_case（approved_execpolicy_amendment 等） |

fixture 目录：dsh-codex/alignment/fixtures/*.json（每 case 标注官方来源测试函数）；HEAD 升级时重新提取 fixture 即可回归。

### B.5 轨迹重放对照（2026-08-16 新增，alignment/replay/）

10 条 mock 轨迹（只 mock 模型输出、真实执行工具）在官方 codex CLI（win32/pwsh）与 DSH headless-codex 预设（git bash）上各重放一次，得到两条规范化上下文（user/assistant 文本、工具调用、工具结果），LCS 对齐后统计差异。运行：node alignment/replay/replay-all.mjs，报告见 alignment/replay/out/report.md（结果表与逐条差异见该文件）。
