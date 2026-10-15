---
date: 2026-09-23
topic: Codex single-session context lifecycle and DSH-native preset migration
status: completed
mode: context-gathering
upstream: openai/codex
upstream_sha: 30fc6864cc1318121eca1843c217fe00ce1212f1
baseline_sha: 5bc8da6d78fe32343dc51eaf73b96fd288ae0e87
---

# Context Report: Codex 单会话上下文完整生命周期

### Why This Was Gathered

为 `agent-presets/codex` 从 **DSH 原生上下文/压缩**迁移到 Codex 语义提供事实依据，不实施迁移。只读调研 `/d/Data/DEV/dsh/codex`，固定 HEAD `30fc6864cc1318121eca1843c217fe00ce1212f1`（下文 H）；对照本仓库 `docs/research/codex-context-assembly.md` 所据 `5bc8da6d78fe32343dc51eaf73b96fd288ae0e87`（下文 B）。日期是本次报告日期，不代表上游发布日期。

**范围**：一个线程内的启动、真实用户回合、工具循环、上下文更新、传输复用、预算、压缩、恢复/分叉/回滚/新窗口。多智能体仅说明其如何改变本线程上下文；不把多智能体、guardian、realtime 或实验 Notes 的路径当作普通单会话默认行为。所有上游链接固定 H；历史差异单列 B→H。测试结论是**阅读测试源代码**，不是声称运行通过。

### Summary

1. Codex 保存的是本地结构化历史与 world-state 基线，不是每轮重造一条“大 system prompt”。普通 Responses 请求分为顶层 `instructions`、完整的活跃 `input`、当步 `tools`；“world-state 只追加 diff”不等于“所有 HTTP 请求只上传 diff”。
2. 初始上下文与每步工具/权限/模型选择必须来自**同一 captured step**。差分消息进入历史，快照/patch 进入 rollout；两者不能相互代替。
3. 前缀缓存、`prompt_cache_key`、WebSocket `previous_response_id` 是三种不同机制。续传有严格前缀与请求属性兼容检查，不能把 ID 当持久会话数据库。
4. 常规压缩是本地摘要或 provider 支持的远程 V2；**H 已删除 V1**。实验 TokenBudget 则重置窗口，不是普通摘要压缩。新增回合结束压缩默认关闭。
5. 旧笔记的大框架仍成立，但 personality 模板渲染、消息内容注解、step settings、managed instructions、远程压缩和恢复细节确有代码变化。以下结论不是仅更新旧笔记行号。

## 1. 模式、默认值和迁移起点

| 机制 | H 中的门槛 / 默认 | 不应混淆的事情 |
|---|---|---|
| 普通单线程上下文 | 无需 TokenBudget；使用历史、world-state、常规压缩 | “single-session”是研究范围，不表示上游全局禁用子代理工具 |
| `multi_agent` / `multi_agent_v2` | 前者 stable、默认 true；后者 stable、默认 false | 多代理工具可用不等于已经产生多个会话；V2 usage hint、agent path 不应无条件照搬到 DSH 单会话 |
| `token_budget` / `context_management` | 都是 UnderDevelopment、默认 false | `<context_window>` / Notes / `new_context` 属于另外一条运行模式 |
| `deferred_tool_world_state` | UnderDevelopment、默认 false | `<tools>` 延迟 namespace 提示不是所有会话必有 |
| `responses_websockets` / `_v2` 旧 feature key | Removed、默认 false | 实际 transport 能力应追 provider/client；不能用已移除 flag 推断禁用所有 WS |

依据：[features/src/lib.rs:1317-1339](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/features/src/lib.rs#L1317-L1339)、[1407-1412](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/features/src/lib.rs#L1407-L1412)、[1677-1688](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/features/src/lib.rs#L1677-L1688)、[1809-1819](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/features/src/lib.rs#L1809-L1819)。

迁移目标当前不是 Codex context runtime：本地 `agent-presets/codex/agent.cordis.yml:1-13,24-30,131-156` 明确由 DSH 负责上下文/压缩，挂载 `dsh-agent-instructions`，以及隔离的 `dsh-compaction-basic`、`dsh-command-compact`、`dsh-compaction-tool-result-pruner`（字符阈值 8192 / head 4096 / tail 1024）；`agent-presets/codex/preset.yml:1-3` 同样声明 DSH 原生。此处只证明**composition 选择**，不把插件名字当作已审计的 DSH 内部算法。

## 2. 状态模型与正常回合流水线

### 2.1 四种“上下文”必须分开

| 状态 | 所有者 / 用途 |
|---|---|
| 基础指令 `BaseInstructions` | 会话启动选定；普通请求顶层 `instructions`；与动态 developer 片段不同 |
| 活跃模型历史 | `ContextManager.items: Arc<Vec<ResponseItemEnvelope>>`，旧→新；压缩/rollback 会替换它 |
| reference context / world state | `reference_context_item` 决定是否全量重注入；`world_state_baseline` 决定片段 diff；不是模型可直接读取的额外记忆 |
| rollout / retained host facts | 可持久化的事件和检查点；包含并非本次模型输入的内容；guardian retained authorization 不能当摘要文字处理 |

H 增加/区分 `history_version`、`reset_version`、`user_message_revision`：压缩并不等于 destructive reset，也不等于收到新用户授权。见 [context_manager/history.rs:74-126](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context_manager/history.rs#L74-L126)。

### 2.2 基础指令不是永远同一份 275 行文件

启动优先级：配置 `base_instructions` → initial history 的 base instructions → 当前 model metadata 的 `render_model_instructions`。动态工具若启动未显式提供，也从历史继承。见 [session/mod.rs:746-757](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L746-L757)。

H 的 renderer **返回 literal instructions template**；缺失时 warning + 空字符串，显式空模板有效，不再按旧文所述在该函数替换 `{{ personality }}`。配置仍可覆盖模板；`Personality::None` 会移除 personality section。本地未知模型兜底才使用 `models-manager/prompt.md`，并带 272000 窗口、95% effective window、10000 **bytes** 工具截断元数据；不能断言所有服务端模型相同。见 [prompts/src/model_instructions.rs:1-17](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/prompts/src/model_instructions.rs#L1-L17)、[models-manager/src/model_info.rs:20-85](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/models-manager/src/model_info.rs#L20-L85)、[120-156](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/models-manager/src/model_info.rs#L120-L156)。

换模型并不简单覆盖旧历史开头：world state 根据当前/前一模型及基础指令 provenance 构造 `ModelInstructionsState`；需要的 `<model_switch>` 在初始 developer bundle 最前。见 [session/world_state.rs:51-80,115-120](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/world_state.rs#L51-L120)、[session/mod.rs:4380-4387](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L4380-L4387)。

另有 request-copy 例外：`get_prompt_base_instructions` 在 `!update_plan_enabled && model_catalog.is_none()` 且 model provenance 时，从请求副本移除 update_plan 指令；持久化和 fork 继承的原文不变。因此“基础指令永远不变”只能描述存储意图，不能当 wire-level 不变量。见 [session/mod.rs:1490-1507](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L1490-L1507)。

### 2.3 一次真实用户回合包含多个 sampling step

```text
恢复/建立会话
  → 回合前预算/换模型检查及必要压缩（新输入尚未记录）
  → capture first StepContext（settings/model + environments + AGENTS + tools/MCP）
  → 首次全量 context 或 steady-state diff + 持久化 world-state/TurnContext
  → skills/plugins、session-start/input hooks、真实用户输入
  → 循环：capture step → time reminder / world-state diff / reasoning override
          → normalized history → Prompt(input, tools, base_instructions)
          → transport → assistant/tool calls → tool results 写回历史
          → pending input / follow-up / token pressure 决定继续、压缩或结束
  → 可选 post-turn compaction → 回合结束
```

顺序证据：[session/turn.rs:164-220](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L164-L220)、[257-320](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L257-L320)、[365-390](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L365-L390)、[458-565](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L458-L565)。

**一致性边界**：capture 在锁内一起读取 `next_step_settings` 和 environment snapshot，AGENTS 随 step 刷新；执行中的 step 不因稍后的 sparse settings 更新被重新解释。同一个 `StepContext` 提供 world-state、model-visible tool specs 与 `ToolCallRuntime`。重试可以重新读取历史，但仍使用该 request step。见 [session/mod.rs:3781-3835](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L3781-L3835)、[session/turn.rs:1555-1629](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L1555-L1629)。

### 2.4 初始组装、后续 diff 与持久化顺序

初始组装：聚合 developer 内容（配置指令、扩展 policy/capability/turn contributions、world-state developer 片段）；需要隔离的消息另放；聚合 user 内容（AGENTS/environment）；multi-agent mode、guardian policy、managed developer instructions 按专门顺序处理。**managed policy 最后独立 developer 消息**，不混进 client-authored bundle。所有替换历史初始项补 turn id。TokenBudget 的窗口描述和 Notes bridge hint 仅在相应 gate 下构造。见 [session/mod.rs:4230-4467](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L4230-L4467)。

常规 turn：无 reference 时全量 context + `WorldStateItem::full`；有 reference 时 `history.update_world_state` 并合并 diff；TurnContext 变化时还可加入扩展 turn contribution。先记录模型可见片段，再持久化描述它的 snapshot/patch，最后推进 reference；snapshot-only 变化不强行生成重复 TurnContext。step 内也用同一对 snapshot 同时生成模型 diff 和 rollout patch。见 [session/mod.rs:4600-4683](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L4600-L4683)、[3672-3705](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L3672-L3705)。

world-state 稳定 ID 对应序列化 snapshot，rollout patch 用 RFC 7386（null 删除）；不是把 patch JSON 发给模型。无精确 snapshot 的旧历史退回 marker 检测：`Known` / `Unknown` / `Absent` 有不同 replacement/removal 语义。部分节还检查相应片段是否真的仍在 retained model history，防止“快照说存在、压缩后实际已丢失”而漏注入。见 [context/world_state/mod.rs:283-346](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context/world_state/mod.rs#L283-L346)、[397-433](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context/world_state/mod.rs#L397-L433)。

### 2.5 动态内容清单：按单会话需要分层

| 内容 | 角色 / 更新策略 | 源码 |
|---|---|---|
| 模型、permissions 或 compact approved-prefix 信息 | developer，模型/权限状态改变时追加，不重写旧项 | [world_state.rs:115-190](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/world_state.rs#L115-L190) |
| AGENTS、environment（cwd/shell/date/timezone/network/filesystem） | user，独立 world-state diff；环境列表可含移除项 | [world_state.rs:160-233](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/world_state.rs#L160-L233)、[environment.rs:239-289](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context/world_state/environment.rs#L239-L289) |
| collaboration / persistent reasoning mode | developer；persistent 只有 effort=Persistent 才有正文，离开模式追加失效声明 | [persistent_mode.rs:50-114](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context/world_state/persistent_mode.rs#L50-L114) |
| apps/plugins、deferred environment/tools、extension sections | 按配置/模型/可用工具 gate；不是固定文本列表 | [world_state.rs:234-300](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/world_state.rs#L234-L300) |
| managed developer instructions | requirements 所有，独立 developer；更新/删除声明；包含标记和 replacement 开销后 >10000 estimated tokens **报错而非静默截断** | [managed_developer_instructions.rs:13-78](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context/world_state/managed_developer_instructions.rs#L13-L78)、[107-151](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context/world_state/managed_developer_instructions.rs#L107-L151) |
| 时间提醒 | 独立 append，按窗口/间隔与 delivery mode 限频；AfterUserOrToolOutput 模式消费边界，即使间隔抑制 | [time_reminder.rs:40-95](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/time_reminder.rs#L40-L95) |
| multi-agent/realtime/guardian | 条件路径；影响 parent/child 当前历史，但非普通单会话通用必需内容 | [world_state.rs:81-114,146-159](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/world_state.rs#L81-L159)、[301-319](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/world_state.rs#L301-L319) |

`ContextualUserFragment` 名称不表示一定 user role。H 新增 `content_kind`，渲染后同时携带 role、文本和分类；merge 只合并**相邻、同 role、允许合并**的片段，保持 content item 与分类一一对应。见 [context-fragments/src/fragment.rs:55-118](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/context-fragments/src/fragment.rs#L55-L118)、[context_manager/updates.rs:12-60](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context_manager/updates.rs#L12-L60)。

### 2.6 AGENTS 发现与不可信项目边界

根标记默认 `.git`，从最近项目根到 cwd，目录内依次 `AGENTS.override.md`、`AGENTS.md`、fallback filenames；不是递归扫描整个仓库。总 project docs 默认 32 KiB，逐文件消耗剩余预算；用户/线程级 host instructions 另有来源，不应把 project 预算解释成所有 instruction 的统一 cap。H **不可信项目跳过 project instructions**；受限文件系统带 sandbox context，相关读取错误可以传播失败；fallback 名称按 executor OS 排除路径语法（特别 Windows `\\`、`:`，避免网络路径探测）。见 [agents_md.rs:56-115](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/agents_md.rs#L56-L115)、[125-185](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/agents_md.rs#L125-L185)、[192-295](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/agents_md.rs#L192-L295)、[config/src/config_toml.rs:75-82](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/config/src/config_toml.rs#L75-L82)。

AGENTS 文本变化时不是覆盖此前 user message，而是追加 “These AGENTS.md instructions replace all previously provided AGENTS.md instructions.”；删除追加 “The previously provided AGENTS.md instructions no longer apply.”。见 [context/world_state/agents_md.rs:9-78](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context/world_state/agents_md.rs#L9-L78)。

## 3. 历史规范化与工具结果生命周期

1. 工具 call / output 为结构化 `ResponseItem`，不是压扁成带角色标签的字符串。写入历史时，function/custom output 按模型截断策略处理；H 支持 harness metadata 的 `history_truncation_token_limit` 覆盖，**该值已含序列化 allowance**，不能再乘一次。
2. `for_prompt` 在副本上补缺失 output、移除不合法孤立 output、处理不支持的媒体。**named external outputs 可独立存在**，所以旧文“所有 output 必须有 call”过强。
3. synthetic output ID 由原 call item ID + 固定 UUIDv5 namespace 派生；没有原 ID 则保持无 ID。重复规范化、重试、恢复不应生成随机新 ID 破坏前缀。
4. `is_user_turn_boundary` 仍用 contextual fragment marker 排除环境/AGENTS/hooks 等注入；真正 user authorization 则另用 host content-kind 注解判断，未知/不完整/旧注解保守处理。不要把 marker 匹配当成授权安全边界。

依据：[history.rs:422-475](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context_manager/history.rs#L422-L475)、[797-811](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context_manager/history.rs#L797-L811)、[1197-1206](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context_manager/history.rs#L1197-L1206)、[normalize.rs:140-152](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context_manager/normalize.rs#L140-L152)、[contextual_user_message.rs:20-80](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context/contextual_user_message.rs#L20-L80)。

**“工具 pruning”必须拆开看**：入库限长、prompt normalization、压缩时裁剪、模型工具目录的 deferred loading 是不同层；延迟 namespace 文本本身只有 4 KiB、描述最多 250 字符（[world_state/tools.rs:12-35](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context/world_state/tools.rs#L12-L35)），不是对历史 tool output 做 8192 字符清扫。DSH 的现有 pruner 配置不能直接称为 Codex 等价实现。

## 4. Token accounting、窗口与触发条件

### 4.1 不要混用三个数字

`resolved_context_window = context_window.or(max_context_window)`；`usable_context_window = resolved × effective_context_window_percent / 100`（常见默认 95%）；普通 `auto_compact_token_limit = min(configured_limit, resolved × 90%)`，无 resolved window 时使用配置值。配置窗口还受模型 max window 限制。见 [openai_models.rs:514-536](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/protocol/src/openai_models.rs#L514-L536)、[model_info.rs:20-30](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/models-manager/src/model_info.rs#L20-L30)。这不是通用“到模型窗口 90% 就压缩”一句话可以完整描述的规则。

`active_context_tokens` 以最后服务端 usage 为基底，加最后模型生成项之后本地新增项估算；服务端未计 reasoning 时另补相应估算。估算不是 tokenizer 精确值，不应当成 API 实际计费。见 [history.rs:513-535](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context_manager/history.rs#L513-L535)、[755-791](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context_manager/history.rs#L755-L791)。

估算采用字节启发式（约 bytes/4），另处理 encrypted reasoning、图片及音频；不是把整个 JSON 序列化长度直接除四。item ID、内部 bookkeeping metadata、外层 JSON escaping 不算模型正文；base64 图片 payload 使用替代估算，`original` detail 按 image patches 估算。相关估算及边界说明见 [history.rs:900-1060](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context_manager/history.rs#L900-L1060)。入库截断默认还有序列化 allowance（policy ×1.2），与“模型输入 token estimate”不是同一预算；metadata 已给含 allowance 的 cap 时不再加，见 [output-truncation/src/lib.rs:14-17](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/utils/output-truncation/src/lib.rs#L14-L17)。

预算 scope 有两个分支：

| scope | 用量 | 限额 |
|---|---|---|
| `Total`（默认） | 整个 active context | `model_info.auto_compact_token_limit()` |
| `BodyAfterPrefix` | active 减 prefill baseline（饱和减） | 显式 config limit 优先，否则 model auto limit |

两者仍受 **full usable window** 护栏约束。`base_window_tokens_remaining` 取 scope 与 full-window remaining 的更小值；配置 fallback prompt 时 scope limit 才可加 fallback buffer。触发是 `scope_usage >= scope_limit + buffer` **或** `active >= usable_window`。见 [session/context_window.rs:53-129](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/context_window.rs#L53-L129)、[config_types.rs:42-55](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/protocol/src/config_types.rs#L42-L55)。

每窗口有 first/previous/current UUID、window number、prefill 和一次性 reminder/fallback latch；server-observed prefill 优先于 estimate。压缩后重算活跃历史 usage；BodyAfterPrefix 才重设估算 prefill。这里的“换窗口”不是换会话 ID，也不保证 provider 清空 cache。见 [state/auto_compact_window.rs:5-130](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/state/auto_compact_window.rs#L5-L130)、[session/mod.rs:4780-4818](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L4780-L4818)。

### 4.2 自动压缩时机

| 时机 | 条件与语义 |
|---|---|
| PreTurn | 先检查 previous model comp-hash 变化 / 更小窗口下切，再检查 token limit；新输入还没记录，因此失败路径必须把本轮输入/hook 结果保存 |
| MidTurn | 采样/工具后 `needs_follow_up` 且 token limit 或 `new_context` request；压缩后继续当前用户任务 |
| PostTurn（H 新增） | final response、stop hooks 后；阈值 >0、非 TokenBudget、重新计算达阈值、无 pending input、未取消；仍在同一 turn task 内执行 |
| Manual | 独立 compact task，会发自己的 TurnStarted；与 inline auto 的生命周期事件不同 |

依据：[turn.rs:1271-1300](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L1271-L1300)、[1339-1436](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L1339-L1436)、[598-638](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L598-L638)、[700-732](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L700-L732)、[tasks/compact.rs:19-75](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/tasks/compact.rs#L19-L75)。

**PostTurn 不是后台并行总结任务**：同一 turn 内串行历史更新；pending input/cancel 是入场检查，不承诺未来没有输入到达。`model_post_turn_compact_threshold_percent` 默认 **0（关）**，合法 0..100；>0 时达到普通 token limit，或 active 达 usable-window 百分比即可。Interrupted/TurnAborted 传播，其它错误 warning，保留已经完成的回答。本地 post-turn 摘要输出先缓冲，成功且存在非空 assistant summary 后才提交，不能误把刚完成的普通 final 当摘要。见 [config/mod.rs:3219-3224](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/config/mod.rs#L3219-L3224)、[4247-4249](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/config/mod.rs#L4247-L4249)、[context_window.rs:111-117](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/context_window.rs#L111-L117)、[compact.rs:349-359](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact.rs#L349-L359)、[804-816](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact.rs#L804-L816)。

## 5. 压缩实现：local、remote V2、experimental reset

### 5.1 分流与 provider specificity

manual 和 auto 都按：**TokenBudget → window reset；否则 RemoteCompactionSupport::V2 → streamed remote；Unsupported → local summary**。H 枚举只有 Unsupported/V2，旧 V1 已删除；`remote_compaction_v2` flag 也已 Removed。不要用旧文 V1/V2 分支实现迁移。见 [turn.rs:1443-1501](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L1443-L1501)、[model-provider/src/provider.rs:39-44](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/model-provider/src/provider.rs#L39-L44)、[features/src/lib.rs:1821-1838](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/features/src/lib.rs#L1821-L1838)。

V2 **不只 OpenAI ChatGPT backend**：配置 provider 的 OpenAI/Azure Responses 路由可声明 V2，Amazon Bedrock 实现也声明 V2。这里证明的是客户端 capability/路由代码与 mock 测试，未实际验证任何第三方服务端。DSH 迁移要显式 capability negotiation，不能仅看到 OpenAI-compatible URL 就发送 CompactionTrigger。见 [provider.rs:410-417](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/model-provider/src/provider.rs#L410-L417)、[amazon_bedrock/mod.rs:258-265](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/model-provider/src/amazon_bedrock/mod.rs#L258-L265)。

### 5.2 Local summary：原文、保留与替换

默认摘要 prompt **B→H 字节未变**；`config.compact_prompt` 可覆盖（含配置读取的实验 prompt file）。默认原文：

```text
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

摘要前缀同样未变：

```text
Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
```

源：[compact/prompt.md:1-9](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/prompts/templates/compact/prompt.md#L1-L9)、[compact/summary_prefix.md:1](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/prompts/templates/compact/summary_prefix.md#L1)、[compact.rs:121-126](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact.rs#L121-L126)。

流程细节：

1. 克隆活跃历史，追加摘要 user prompt，正常规范化，带 request-copy base instructions 发请求；`Prompt` 其余字段 default，**不是再给摘要模型提供完整正常工具列表**。Code Mode 执行元数据可附带。local runner 自己建 client session，在此次摘要重试间复用；不能因为外层 dispatcher 收到正常 turn 的 client session，就断言 local summary 复用同一连接。
2. 输出取 assistant summary；合成 `SUMMARY_PREFIX + newline + summary`。筛掉旧摘要、contextual user 片段，保留真实用户文本，从最新往前选 **总计 20000 estimated tokens**，超预算那条截断，再恢复原顺序。这不等于保留全部 assistant/tool 历史，也不承诺保留用户图片。
3. 压缩历史为保留用户文本 + **user role** `CompactionSummary`（`content_kind=compaction.summary`）。不是 system 指令；不能让其中“历史事实”获得新的授权等级。
4. MidTurn 用 `BeforeLastUserMessage` 重注入初始上下文：插到最后真实 user/agent message 前；无真实项时再找 summary/compaction item，最终才 append。PreTurn/manual/PostTurn `DoNotInject` 清 reference，下一正常 turn 全量注入。
5. 推进 window ID，记录 Compacted checkpoint（含 response ID/hash 等），替换历史、重算 usage、完成 ContextCompaction item，并提示多次压缩会降低准确性。
6. 摘要本身 context overflow：只在还有可删项时移除最旧项并重试；只剩一项则标满窗口并报错。普通 stream error 按 provider retry budget；取消/SessionBudgetExceeded 不继续。

证据：[compact.rs:250-410](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact.rs#L250-L410)、[560-602](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact.rs#L560-L602)、[614-761](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact.rs#L614-L761)、[context/compaction_summary.rs:1-37](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context/compaction_summary.rs#L1-L37)。

### 5.3 Remote V2：不是“发同一个摘要 prompt 到 /compact”

V2 用普通流式 Responses 路径发送历史 + `CompactionTrigger`，携带当前 model-visible tools；验证输出必须恰好一个 `Compaction` item。remote stream retry 上限 2；previous-model compaction 失败可以 fallback 当前模型，H 将 fallback 条件扩大为排除 Interrupted / TurnAborted / SessionBudgetExceeded，其余错误可尝试，**不是自动改走 local summary**。见 [compact_remote_v2_attempt.rs:30-133](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact_remote_v2_attempt.rs#L30-L133)、[compact_remote_v2.rs:253-293](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact_remote_v2.rs#L253-L293)、[395-399](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact_remote_v2.rs#L395-L399)、[489-532](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact_remote_v2.rs#L489-L532)、[compact_model_fallback.rs:8-16](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact_model_fallback.rs#L8-L16)。

客户端重建：过滤可保留 user/hook/agent 等消息，按 **64000 token** 总预算截断，agent 单项 **10000 token** cap，最后 append opaque Compaction。client-authored developer retention 要 `RetainClientDeveloperMessages`（UnderDevelopment，默认 false），**64000 不是“永远保留 64k developer policy”**。图片预算 `CompactionImageBudget` stable 默认 true，图片与相关 resize notice 需保持原子语义；managed/server policy 不应仅凭 developer role 混为 client-authored。见 [compact_remote_v2.rs:75-79](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact_remote_v2.rs#L75-L79)、[541-601](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact_remote_v2.rs#L541-L601)、[621-715](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact_remote_v2.rs#L621-L715)、[features/src/lib.rs:1827-1838](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/features/src/lib.rs#L1827-L1838)。

**remote 请求前工具裁剪**：若估算（含 base instructions）超窗口，从最新向旧遍历**连续可改写后缀**，遇首个非可改写项立即停止。function/custom output 换成 `Output exceeded the available model context and was truncated`，保持 success/identity；ToolSearchOutput 的 tools 变空数组；相关附着 notice 随组处理。不是扫全历史找“最旧大输出”。见 [compact_remote_history.rs:68-186](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact_remote_history.rs#L68-L186)。

### 5.4 Experimental TokenBudget / Notes：第三条路线

必须分别识别三个入口：

* 显式配置 `features.token_budget`；受 managed requirements 约束。
* 模型 metadata `model_messages.token_budget.enabled` 可在没有显式 token-budget config 时**自动启用**；因此 registry false 不代表任何模型默认都关闭。prompt defaults 每 step/model 解析，避免换模型仍用旧 guidance。
* `ContextManagement` 的实验自动激活额外要求支持 experimental context 的模型、Codex-backend provider、特定 auth 配置及 ChatGPT Plus/Pro/ProLite；成功后启用 TokenBudget + native history Notes。此门槛不是所有 TokenBudget 使用方式的共同门槛。

见 [session/token_budget.rs:13-58](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/token_budget.rs#L13-L58)、[80-159](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/token_budget.rs#L80-L159)。要求 native Notes 而 starting model 不支持会报错，不能静默退到 legacy bridge，见 [session/mod.rs:727-736](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L727-L736)、[4326-4345](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L4326-L4345)。

TokenBudget 的 manual/auto compaction 运行 hooks、发 ContextCompaction lifecycle，调用 `start_new_context_window`，**不调用模型做摘要**。reminder 达阈值只发一次；fallback prompt 在基础 remaining=0 且允许时发一次，buffer 不是无限续跑许可；显式 `new_context` 绕过 fallback。见 [compact_token_budget.rs:19-83](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact_token_budget.rs#L19-L83)、[session/token_budget.rs:161-224](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/token_budget.rs#L161-L224)、[turn.rs:598-622](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L598-L622)。Notes/原历史检索能力与普通“保留一条摘要”不是同一种产品契约，DSH 不应只复制窗口清空而漏掉续接机制。

## 6. 请求、缓存与 `previous_response_id` 的 endpoint 边界

### 6.1 普通 Responses 与 Responses-lite

普通请求 `instructions=base text`，`input=formatted active history`，`tools=当前 schema`；lite 则在 input 前加 `AdditionalTools` 和 developer base-instructions 片段，顶层 instructions 为空、tools=None，并以 thread namespace + 内容 hash 派生稳定 ID。非 OpenAI provider 请求会清除 internal chat metadata；能力差异不能只靠同名模型推断。见 [client.rs:889-1004](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L889-L1004)。

### 6.2 三种缓存概念

| 概念 | 本地可证明行为 | 不可据此声称 |
|---|---|---|
| 稳定前缀 | append-only diff、稳定 synthetic/lite IDs、减少历史重写 | 一定 cache hit，或模型供应商必定提供同样价格折扣 |
| `prompt_cache_key` / session header | 路由 affinity；key 优先 override，其次 internal source + parent thread，最后 metadata.session_id | key 等于持久化历史，或任何时候都等于本线程 ID |
| WS `previous_response_id` | 已完成响应 + 兼容请求 + 精确历史前缀时省略 input 前缀 | HTTP 也会自动使用，或 resume 仅凭旧 ID 即可续传 |

key 与 header 在 root/non-root 有意区分：root session header 用 cache key，非 root 使用 metadata.session_id；ephemeral root fork 可复用父 session key 保持 affinity，而 thread identity 仍独立。内部 guardian/memory 与普通根线程 key 也不同。见 [client.rs:571-595](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L571-L595)、[session/session.rs:890-928](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/session.rs#L890-L928)。

### 6.3 精确续传条件与失败降级

**此 checkout 的 HTTP `ResponsesApiRequest` 没有 previous_response_id 字段**，发完整 input；WS `ResponseCreateWsRequest` 才有该字段。此结论是 Codex 客户端实现，不是宣称公共 HTTP Responses API 从不支持该参数。见 [codex-api/src/common.rs:260-323](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/codex-api/src/common.rs#L260-L323)。

WS continuation 必须满足：

1. 存在上一请求和已 Completed 的 `LastResponse`，response ID 非空；中断/失败 stream 不产生可用 LastResponse。
2. 比较 model、instructions、tools、tool_choice、parallel_tool_calls、reasoning、store、stream、include、service_tier、prompt_cache_key、text 等属性相同；**不比较** stream_options / client_metadata / access_programs；input 单独处理。
3. 新 input 前缀精确等于“上一请求 input + 上一响应 items_added”（忽略内部 bookkeeping metadata）；只发送剩余 suffix，**空 suffix 也允许**。任一检查失败就 full create，不是错误地继续引用旧响应。

源：[client.rs:331-387](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L331-L387)、[1381-1443](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L1381-L1443)、[1945-1972](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L1945-L1972)、[2340-2362](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L2340-L2362)。

WS session 可从 request session drop 回 ModelClient，再跨 turn 取回；但 headers/provider-auth revision/owner 改变或连接关闭会 reset；owner change 还清 turn_state。服务器 `previous_response_not_found` / connection limit 错误可重试，缺失已完成前缀时 full send。upgrade required 或 retry budget 耗尽可降级 HTTP；`disable_websockets` 是**本会话剩余生命周期**的 latch，不是仅重试一次。见 [client.rs:599-616](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L599-L616)、[644-663](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L644-L663)、[1332-1337](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L1332-L1337)、[1510-1578](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L1510-L1578)、[responses_retry.rs:96-113](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/responses_retry.rs#L96-L113)、[responses_websocket.rs:614-640](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L614-L640)。

## 7. Resume、fork、rollback、rollout 与新上下文

### 7.1 历史恢复不是打开同一条 WS

`InitialHistory::{New,Cleared,Resumed,Forked}` 有独立分支。resume/fork 从持久化 items 重建活跃历史、previous model settings、reference、world state 和窗口；media replay 在本地处理，禁 resize notice，保持 envelope metadata 一一对应，**不上传/迁移已记录媒体**。随后以当前 filesystem/settings capture 出新 diff。见 [session/mod.rs:1557-1678](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L1557-L1678)、[1703-1804](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L1703-L1804)。

重建器逆扫真实用户回合与 rollback：`TurnContext` 本身不算真实用户回合；rollback 跳过最新 N 个真实 user segments。找到最新存活且含 replacement_history 的 compaction 作为完整历史基底，旧前缀不再影响 active history；legacy 无 replacement 的 compaction 兼容重建会清理 reference，避免错误 diff。WorldState full/patch 单独重放，compaction 使此前 baseline 失效。见 [rollout_reconstruction.rs:108-160](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/rollout_reconstruction.rs#L108-L160)、[224-317](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/rollout_reconstruction.rs#L224-L317)、[434-510](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/rollout_reconstruction.rs#L434-L510)。

resume/fork 标记 `restored_history` 只用于 full-send reason 等；第一 WS send 仍须全量。startup warmup 可先 `generate=false` 全量发历史，然后真正 generation 增量续 warmup response，所以“恢复后的第一条生成请求必无 previous_response_id”也不准确。见 [session/session.rs:1735-1745](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/session.rs#L1735-L1745)、[client.rs:1915-1942](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L1915-L1942)、[2071-2115](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L2071-L2115)。

### 7.2 持久化检查点与 reset

常规 compact 的 replacement history/metadata 写入 `Compacted`，随后 reference/world-state 信息恢复后续 diff 所需的基线；这和逐项 ResponseItem 事件一起构成恢复协议。TokenBudget `start_new_context_window` 清 pending request、推进窗口、重新 build initial context，并以新历史 checkpoint 替换，不创建另一根线程。`new_context` 工具只是请求 rollover，实际切换在采样后的控制流里发生。见 [session/mod.rs:4045-4125](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L4045-L4125)、[4533-4593](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L4533-L4593)、[tools/handlers/new_context_window.rs:18-46](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/tools/handlers/new_context_window.rs#L18-L46)。

**审计 trace replay 与会话恢复不是同一个 reducer**：rollout-trace 的 conversation reducer 遇 WS previous_response_id 时，在同线程找已知 inference call，把其 request + response IDs 补回；未知 ID 是 reducer error。warmup 不在 trace 时，客户端记录 logical full request，避免出现无法解析的 delta。见 [rollout-trace/src/reducer/conversation.rs:34-127](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/rollout-trace/src/reducer/conversation.rs#L34-L127)、[client.rs:1938-1942](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/client.rs#L1938-L1942)。DSH 若只保存 wire delta 而不保存完整逻辑历史和可解析前缀关系，重启恢复不可靠。

## 8. B→H：实际 diff 与旧笔记修正

执行了 `git diff 5bc8da6d78fe32343dc51eaf73b96fd288ae0e87 30fc6864cc1318121eca1843c217fe00ce1212f1 -- <paths>`，不是根据文件日期猜测。完整 [固定 SHA compare](https://github.com/openai/codex/compare/5bc8da6d78fe32343dc51eaf73b96fd288ae0e87...30fc6864cc1318121eca1843c217fe00ce1212f1) 很大，以下只列本题已阅读的差异；当前证据链接见对应章节。

| 范畴 | 实际 B→H 变化 / 未变 | 对旧笔记的影响 |
|---|---|---|
| base/model | 新 `prompts/src/model_instructions.rs`；删除 personality world-state；模板改 literal；新增 persistent-mode | 不再照搬 personality placeholder 渲染步骤 |
| fragments | `content_kind` / RenderedFragment / metadata 分类进入历史和请求 copy | 只保存 role+text 不再足够覆盖授权/retention 语义 |
| managed policy | 新 managed_developer_instructions section、超限校验、独立消息和替换/移除 | 普通 client developer 与 requirements-owned policy 要区分 |
| captured step | step_settings/activation 加入，prompt、world-state 与执行共享 snapshot | 动态配置更新不能改变已开始的 step |
| AGENTS | untrusted project gate、sandbox-aware read、fallback filename 校验 | 原 discovery 框架仍在，错误/信任边界不同 |
| compaction | 删除 `core/src/compact_remote.rs`、`compact_remote_request.rs` 和旧 API endpoint；V2 flag 退役；fallback error 集扩大 | 不能再实现“V1/V2 二选一”或假定只有 OpenAI backend |
| post-turn | 新阈值、PostTurn phase、local response buffering | 默认 0；opt-in；不是默认每个 final 后自动摘要 |
| token budget | 新模型默认激活与实验 ContextManagement eligibility；按 active model 解析 guidance | registry false 不能代表所有模型始终 off |
| tool output | `history_truncation_token_limit` override、named external output、remote trailing-tool rewrite 和图像预算变化 | 旧的绝对配对/统一截断说法要收窄 |
| transport | 新 ephemeral fork affinity、auth-owner reset、restored-history reason、允许 empty delta | **HTTP full-input / WS previous_response_id 的位置并非本次新增** |
| reconstruction | 新 surviving checkpoint/suffix 和 retained-context 路径；真实用户回合与 context-only segment 分开 | 不可仅重新拼接全部 rollout items |
| summary 文本 | `prompts/templates/compact/{prompt,summary_prefix}.md` diff 空 | 摘要 prompt 原文未变；变化在调用/替换/元数据/错误处理 |

旧文还有两类**不是 H 新增行为**的表述纠正：`instructions` 本来就可配置/继承/由 model metadata 决定，不能称统一不变文件；OpenAI/Azure 的 V2 capability 在 B 已存在，不能把纠正“只 OpenAI”写成新功能。上游 `ProviderCapabilities::default` 的 remote 支持则确由 V2 改 Unsupported（[provider.rs:60-68](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/model-provider/src/provider.rs#L60-L68)）。

## 9. 边界测试、迁移验收与开放问题

### 9.1 上游测试源定位（未执行）

| 覆盖点 | 测试 / 精确源码位置 |
|---|---|
| captured-step 更新一致性 | `submitted_sparse_updates_preserve_captured_steps_and_ordering` [step_activation_tests.rs:507-763](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/step_activation_tests.rs#L507-L763) |
| 全量缺基线、clear 后重注入、无 diff 仍持久化 baseline | [session/tests.rs:10611-10756](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/tests.rs#L10611-L10756) |
| 自定义摘要 prompt / context overflow retry / 连续两次手动压缩 | [suite/compact.rs:913-1002](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/compact.rs#L913-L1002)、[3872-3971](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/compact.rs#L3872-L3971)、[4042-4130](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/compact.rs#L4042-L4130) |
| hook block 不是一概阻止 compact | `manual_pre_compact_block_decision_does_not_block_compaction` [suite/compact.rs:784-850](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/compact.rs#L784-L850) |
| 冷恢复压缩 checkpoint / limit clamp / BodyAfterPrefix | [suite/compact.rs:4382-4450](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/compact.rs#L4382-L4450)、[4645-4937](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/compact.rs#L4645-L4937) |
| Bedrock remote V2 / retained-image budget | [suite/compact_remote.rs:532-710](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/compact_remote.rs#L532-L710) |
| ToolSearchOutput 裁剪 / base instructions 参与 estimate | [suite/compact_remote_trimming.rs:90-203](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/compact_remote_trimming.rs#L90-L203) |
| model-owned TokenBudget / 显式关闭 / guidance 跟随 active model | [suite/token_budget.rs:442-743](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/token_budget.rs#L442-L743) |
| token reset/hooks/mid-turn/fallback/new_context | [suite/token_budget.rs:1117-1677](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/token_budget.rs#L1117-L1677) |
| WS prefix/non-prefix/属性变化/error 后 full send | [suite/client_websockets.rs:2286-2535](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/client_websockets.rs#L2286-L2535) |
| WS resume/fork 首次全量 warmup 后增量 | `responses_websocket_restored_history_metric` [client_websockets.rs:2905-2952](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/client_websockets.rs#L2905-L2952) |
| fork cache affinity 与自身 identity 分离 | `ephemeral_fork_shares_cache_routing_but_keeps_session_identity` [prompt_cache_key.rs:162-219](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/suite/prompt_cache_key.rs#L162-L219) |

测试限制：WS 集成测试大量使用 `skip_if_no_network!`；受 `CODEX_SANDBOX_NETWORK_DISABLED` 影响时不能把 skip 当实测网络覆盖（[tests/common/lib.rs:598-615](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/tests/common/lib.rs#L598-L615)）。本次 grep **未找到专门设置 post-turn threshold 或构造 PostTurn phase 的测试**；这是发现的覆盖空白，不声称“已验证所有 PostTurn race”。

### 9.2 DSH 迁移建议（推导，不是已实现事实）

1. 先定义单会话状态契约：immutable base/provenance、active annotated history、reference/world-state、usage/prefill/window IDs、durable checkpoint；保持 DSH UI transcript 与模型窗口的分离。
2. 将 normal assembly、HTTP/WS projection、local summary、remote capability、experimental reset 分为独立层。先实现普通单会话 local 模式，不因接口名称相似就启用 Notes / opaque remote compaction。
3. 迁移时只能有一个预算/压缩 owner。替换当前 DSH compaction group 前，先覆盖 manual command、auto pressure、工具结果截断、abort、resume/fork；不能把 Codex 阈值和 DSH pruner 叠加后称等价。
4. 自动化验收必须覆盖完整生命周期：初次 full→不变 turn 无重复→AGENTS/权限/model 变化→工具循环→超限压缩→下一 turn 重注入→进程重启恢复→fork/rollback；再加 stream failure、缺 output、named external output、媒体不支持、summary 为空、post-turn 有 pending input/取消等分支。
5. 以请求快照和 persisted checkpoint 断言行为，而非只看最终回答文字；缓存命中率必须用真实 provider usage/telemetry 验证，不能从 `prompt_cache_key` 存在推导成功。

### 9.3 Open Questions / 明确未证实

* DSH 首期究竟要求哪一层等价：普通 local summary + incremental context，还是还要 remote V2、WS continuation、实验 Notes？需要产品选择，不能用“Codex 模式”隐含全部。
* 目标各 endpoint 是否真的支持 CompactionTrigger、opaque compaction、encrypted reasoning、namespace tools 和前缀缓存？本报告未调用真实服务，需逐 provider capability + contract tests。
* DSH 原生 plugin hook、goals、OpenViking 等注入如何进入 content-kind / world-state / user-boundary 分类，压缩后哪些必须重放？本次只研究 Codex 并核对 preset composition，未审计这些插件内部。
* metadata 不完整的旧 DSH 历史如何迁移，是否可接受保守全量 reinjection / full transport send？Codex 的兼容 marker 推断不能自动视为适合 DSH。
* post-turn 功能若纳入迁移，需补空摘要/断流不污染已完成历史、steering/cancel、remote failure 等测试；默认保持 0 是较保守的对齐。

### Checks Performed

* 开始：`pwd`，两树 `git status --short` 为空；upstream `git rev-parse HEAD` 与 H 一致；B 全 SHA 已解析。
* 主证据：本地固定源码 `nl -ba ... | sed -n ...`、`rg -n ...`、`git show B:<path>` 与限定路径 `git diff B H`；引用固定 H，不引用 moving branch。
* 摘要 prompt/prefix 的 B→H diff 为空；V1 文件删除、managed/persistent/step-settings 新增及相关调用变更有真实 diff。
* 未运行 Rust 测试/构建、未访问真实模型 endpoint；上游只读。唯一研究输出为本文件；同工作区父任务可能另改 issues 文档，不属于本研究改动。
* 结束检查：上游 status 仍为空；目标树仅本研究文件与父任务 `docs/issues/` 未跟踪输出。固定 SHA 链接逐个检查文件存在和行范围合法；`git diff --check` 无报错（新文件另做文本/引用检查）。
