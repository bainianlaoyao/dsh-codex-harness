# 工单：Codex 单会话上下文管理迁移至 `codex` 预设

**状态：实施中，P0 路由冻结关口待决。2026-09-23 用户确认整棵设计树；2026-09-25 已按用户后续“开始实现”启动包内开发，尚未启用/安装该模式。**

> **实施进度（2026-09-25）：**包内新增 `plugins/context/` 的持久 Note/窗口状态、模型工具、授权 Web 读取端点、`plugins/harness/codex-context-compaction.js` 的单 compaction owner 原型，及 `plugins/client.js` 的上下文面板/Chat 分隔标记原型。新文件有局部 smoke 测试，**尚无真实浏览器与模型端到端验收**。安全关口未越过：现有 DSH `agent/pre-step` 在 `agent/request` 确定真实路由和 adapter `prepareCall` **之前**触发，包内插件不能在 Note-reset 选路时持有并冻结随后实际发送的 provider/model/contextWindow。为避免用上一请求容量猜测新请求，当前原型禁用自动 Note-reset；手动 reset 需要现有运行时并不提供的 `agent.codexCapturedRoute`，因而正常路径不可达；模型主动 `new_context` 尚未挂载。任何 smoke 通过仅证明局部逻辑，不代表验收闭环；**不要挂载到 preset、打包重装或声称已迁移完成**。要解除此关口，需经用户决定是否允许改 DSH 源码提供“路由/adapter 准备完成 → 在同一不可变请求快照上作 compaction → 发送同一快照”的 seam，或批准削弱先前锁定的路由一致性要求。原始 Note 的旧前缀 fork 私有快照、跨日志/文件恢复与真实浏览器复核也未达到验收。

## 决策总览（截至第十四轮）

| 产品契约 | 已选方案 |
| --- | --- |
| 目标与范围 | 仅新建 `codex` 会话；旧会话和 `codex-creative` 不变；只写本地工单，包内插件实现，不改官方 DSH |
| 正常窗口交接 | **必须同一个 durable session** 内模型窗口 reset；本窗口有持久化新 Note 才能正常切；新窗口**主动读取** Note，全文不自动注入；人类聊天旧历史照常滚动。若验证做不到，应暂停迁移并重新和用户讨论方案，不自动新建另一个 session。 |
| 没有本窗 Note | 临界时自动或手动 `/compact` 时改走**显式标记的普通摘要兜底**，失败报错不静默 reset；兜底后逻辑删除活跃 Note，旧日志副本仍保留 |
| 预算 | 模型可主动查询预计剩余量，临界提醒；按模型的安全默认和高级可调阈值；容量未知不自动 Note-reset |
| 历史与隔离 | 模型仅分页读取自己会话曾经模型可见且已记录的消息；不保证恢复从未记录/已截断内容，旧文本不是新授权；fork 私有复制 Note、继承旧/新模式 |
| GUI | 右栏「上下文」tab + 会话标题入口；人类只读 Note，保留 composer 圆环、区分估算与模型剩余额；Chat 插入切窗分隔标记、旧消息仍可滚动；时间线可点跳回同一 Chat |

**实现前置事实关口：**同一真实路由的模型/工具/窗口快照一致性、单 compaction owner、切窗/日志/Note 的 crash-safe 顺序、历史工具 ACL、Note 写入内容的日志副本、浏览器安装版重新打包/重装验证。未运行实现或在线模型实验；研究报告和以下清单均不是“已实现”的陈述。

> **用户已决定（第一、二轮，2026-09-23）：**目标**不是**普通本地摘要复刻，而是 Codex 的 TokenBudget / 自主 Notes / 新上下文窗口：让模型知道剩余预算、主动写 Notes，并在 rollover 后可按需读取旧窗口历史；只影响 `codex`，工单只保存在本地。第二轮曾说“如果无法同 session，归档旧 session → 新 session 有引用也可接受”，**第八轮随后明确要求人类在同一个聊天流滚动旧历史且感受不到 session 切换；本工单以更具体的第八轮要求为准：不得把另起 session 当作已批准的自动 fallback。**若同 session 经实测无法实现，必须先回来重新确认产品范围。允许在本包 `plugins/` 实现仅由 `codex` 挂载的运行时能力；早期 local-summary 分期不是目标。

> **第三轮决定：**选择 DSH 本地 Notes + 原始 session log 的**行为迁移**，不接 Codex 私有后端；模型通过主动 `get_context_remaining` 查询剩余预算，临界时系统提醒，而不是每步重发数字。用户提出应急问题：**没有 Note 且超出预算时能否降级到普通 Compact？**本工单暂将其视为待确认的保底分支，不把“任何时候都能摘要成功”写成承诺。

> **第四轮决定：**历史回读范围是当前任务流**当时模型可见且已写入日志**的消息/工具结果，不读内部审批、凭据或未记录的内容；默认只读自己的历史（不共享给其他子代理/兄弟会话）。会话所有者要能在**首期提供优雅的 Web GUI 可视化面板**查看 Notes，不仅靠 CLI/export。面板的插槽、前后端 API、刷新及安装验证需要专项核查。

> **第五轮决定：**无已持久化 Note 且临近硬上限时，**允许提前自动尝试普通摘要 Compact**，须在会话/面板明确标为偏离 Codex 的应急兜底；摘要失败不能悄然 reset，须保留可回读日志并显式报错。新机制仅对**新建** `codex` 会话默认生效，老会话继续原行为（未来是否显式迁移另议）；无法获取可信模型容量时不猜测预算，不自动 Note-reset，走单一现有 DSH 压缩路径并解释原因。

> **第六轮决定：**Note 用**一份文件**承载，允许模型写入/追加/读取，不做首期多文件管理；写入持久化失败当成无可用 Note，在还有预算时走已批准的应急摘要，两条路都失败则明确报错、不静默切窗。旧历史单次工具返回有上限，但允许通过分页/偏移遍历所有允许、已记录的内容。人类可在 GUI 看 Note，**不能直接编辑或删除**。

> **第七轮决定：**Web 面板放在**右侧栏「上下文」tab**，会话标题区有仅新机制 `codex` 会话可见的入口；保留原 composer token 圆环，面板分别标注使用率估算与模型工具可见的剩余预算。**当前窗口必须有新近已确认持久化的 Note 写入**才能走正常 Note-reset：上一窗口留下的旧 Note 不满足条件，迫近上限时进入已批准的摘要兜底。

> **第八轮决定：**模型主动 `new_context` 而当前窗口未确认新 Note 时拒绝并提醒先写，临界时才执行摘要兜底。**人类应直接在同一会话的聊天滚动区访问全部历史**，面板不必做另一套历史浏览器；模型活跃上下文切换不能使人类界面看起来变成新会话。摘要兜底发生后，用户要求**直接删除旧 Note**，而不是留存过期版本；待核查其含义是清除活跃 Note 文件，还是要求从追加式事件日志中硬删除全部副本（后者可能与保留完整会话历史冲突）。

> **第九、十轮决定与事实修正：**第九轮用户一度选择“新窗口自动注入 Note 全文”，其理由是猜测 Codex 官方如此实现。核查[模型指引](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/models-manager/models.json#L105-L112)与[新窗口片段](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/context/token_budget_context.rs#L55-L75)后，用户在第十轮**明确改选官方风格：新窗口仅收到定位/指导，模型主动调用 Note 读取工具恢复交接，不自动注入 Note 全文**。第九轮决定已作废。

> **追加核查：**DSH Chat 本来从 append-origin 历史构建人类 transcript，即使模型 surface replace，旧消息仍可在同一 session 加载/滚动；本机 `dsh-client-ui-conversation/lib/types/client/contract/records.d.ts:176-198` 明文区分两种视图。DSH 把工具调用原始参数记在追加式 V3 `tool/call.arguments`；Note `write` 的完整内容可能留在历史日志，**删除活跃 Note 文件不等于抹去日志/导出副本**。第十一轮已决定只逻辑清除活跃文件，UI 不能说成已彻底销毁。

> **第十一轮决定：**应急摘要兜底后只**逻辑删除活跃 Note 文件**和面板当前内容，明确说明历史日志/导出仍保留已写过的内容，不承诺硬擦除。在原聊天流中增加小型可折叠「新上下文窗口」分隔标记（区分 Note-reset 和摘要兜底），不隐藏旧消息。新窗口**提示**模型主动读 Note、不硬性拦截其他工具；面板标示 Note 尚未读取，便于发现交接失败。

> **第十二轮部分决定：**模型和面板的剩余 tokens 明确为**估算值**（provider usage/本地估算及保守余量），不保证逐 token 准确；阈值按路由模型给测试过的默认值，并允许在高级设置调整。手动 `/compact` 语义用户要求先核实：上游 TokenBudget 开启时，无论有无 Note，手动 compact 直接新建同线程窗口，**不命令模型写 Note，也不退化本地摘要**（[tasks/compact.rs:26-38](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/tasks/compact.rs#L26-L38)、[compact_token_budget.rs:23-42,64-83](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact_token_budget.rs#L23-L83)）。本迁移的偏离行为见第十三轮决定。

> **第十三轮决定：**新机制会话手动 `/compact` 时，本窗口有效 Note → 正常切窗；无有效 Note → **显式普通摘要兜底（B）**，失败报错、不暗中切窗。这是对官方 TokenBudget manual compact 的有意偏离，与自动应急策略一致；旧会话仍保持 DSH 原有 `/compact`。

> **第十四轮决定：**从新机制会话 fork 时，复制 Note 的当时版本，此后父子各自读写自己的副本，**不共享可写文件**；从旧机制会话 fork 继续旧机制，即使得到新 session ID 也不偷偷切新策略。右侧栏窗口时间线的节点首期可点击：在**同一个 Chat 会话**中分页加载并滚动到对应的切窗分隔标记，不打开另一份历史视图。

## 背景与基线

- 上游基线：[`openai/codex@30fc6864cc1318121eca1843c217fe00ce1212f1`](https://github.com/openai/codex/tree/30fc6864cc1318121eca1843c217fe00ce1212f1)（2026-09-23）；本仓库基线：`b484f18`（`dsh-codex-mode` 0.3.5）。详细原始源码调查见 [`../research/2026-09-23-codex-single-session-context.md`](../research/2026-09-23-codex-single-session-context.md)。此前的 [`../research/codex-context-assembly.md`](../research/codex-context-assembly.md) 仅反映旧版 `5bc8da6d78`，不应据此直接实施。
- 用户所选模式的专项核查见 [`../research/2026-09-23-codex-tokenbudget-notes-dsh-session-log.md`](../research/2026-09-23-codex-tokenbudget-notes-dsh-session-log.md)：剩余预算是模型调用 `get_context_remaining` 工具返回的当前窗口剩余量，另有可选阈值提醒；`<context_window>` 带窗口 ID，**不是**每步刷新的剩余计数。Codex `new_context` 在同一 durable thread 重置模型窗口，不自动执行摘要或强制写 Note。
- Codex **native** Notes/history 是经过鉴权的私有后端 API，而非本地 Markdown；历史读取接口公开描述的是“最终一致的 normalized history”，源码**未证实**可逐字回读所有旧输入/未截断 stdout/媒体/服务端隐私推理。若以 DSH V3 append-only session log 做本地等价物，必须先定义“完整历史”的范围和权限，不能声称和私有 Codex 后端同一实现。
- 当前 [`agent-presets/codex/agent.cordis.yml`](../../agent-presets/codex/agent.cordis.yml) 明确把上下文/压缩留给 DSH，预设内挂 `compaction-basic`、`command-compact` 与 `tool-result-pruner`。目前没有在该预设中安装 Codex 的历史/world-state/压缩生命周期实现；因此**只改 persona 或摘要提示词不能称为迁移单会话方案**。
- 本工单的目标是可复现、可安装的插件 + 预设配置，不直接改官方 DSH npm 安装目录，也不修改上游 Codex 源码；如需运行时新能力，放在本包的 `plugins/`，由 `agent-presets/codex/` 挂载，遵守 DSH 的会话隔离/宿主边界。
- 这不是从零编写：本仓库 `54d5627^` 历史里有 `plugins/tools/prompt-align.js`、`plugins/harness/codex-compactor.js`、`plugins/harness/compact.js` 及旧 `agent-presets/codex/BASE_INSTRUCTIONS.md`；`54d5627` 删除它们并改为 DSH-native。应审查/测试再利用其扩展缝，**不要直接回滚旧版实现**；历史需求文档 `docs/codex-mode-requirements.md` 的 ✅ 不能当作现状。

### 现状与迁移所需的能力缝

| 领域 | 已有 DSH / 本包能力 | 当前目标的关口 / 明确不纳入首期的差异 |
| --- | --- | --- |
| 上下文片段 | `ctx.systemPrompt.context()` 与 `agent/pre-step` 能注入内容；`typed-subagents.js` 已有 prompt assemble 钩子 | Note-reset 后需要可靠重注入本会话必要的世界状态；Codex developer 角色/逐片段 diff 的**完整**默认方案不纳入本工单 |
| 压缩 | `CompactionEngine` 可替换；现有 `compaction-basic` 支持 `agent/pre-step`、溢出重试、`/compact`；旧版 Codex compactor 可供审计 | 单一 owner 能否原子提交 Note-reset 与应急普通 DSH 摘要；不以 Codex local summary 的 20K 用户消息重建作为 Notes 功能前置 |
| 历史/恢复 | DSH 持久化 surface/replace，LLM Responses adapter 传 system→instructions | 需验证替换历史/快照基线/恢复后 world state 重注入；本包 adapter 没有 developer-role 发送路径 |
| 文件指令 | 预设配置 `.git` 根、AGENTS.md/AGENTS.override.md 与 32 KiB | DSH local 指令为叠加而非 Codex override；嵌套指令发现只针对 DSH `read/write/edit`，当前 Codex 工具可能绕开此路径 |
| token 统计 | 当前 DSH token meter 和 adapter 声明的 `contextWindow` | 必须对照路由模型真实窗口和服务端 usage；不能把 DSH 粗估当作 Codex 的精确容量 |

以上 DSH 事实依据本机 `@deepseek-ai/dsh-compaction-basic@0.1.5-rc.2` 的 `lib/index.js`（默认阈值/保留量在 15–18、62–73 行，pre-step 在 798 行）、本包 `agent-presets/codex/agent.cordis.yml:24-30,138-156`、`plugins/llm-responses.js:203-260,294-311`。上游 Codex 对照见研究笔记（固定 SHA）；这里的限制需要在真实插件 API 和安装环境中验证，不能只凭提示词宣称已消除。

**当前实现关口，不要和其它 Codex 模式混淆：**DSH 现有 compaction-basic 用**单个 checkpoint user node**替换选定 surface 区间（本机 `dsh-compaction/lib/types/index.d.ts:66-73,111-120`）。本工单须验证它能否安全表示 **Note/历史定位符 + 窗口身份 + 必需初始化上下文**、能否 crash-safe 地保留原始历史/重启重放；不能只改 `summarize()` 或阈值就宣称完成。Codex **另一条、非首期** local-summary 路径会保留用户消息并重建多项历史（[compact.rs:366-391](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact.rs#L366-L391)、[672-759](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/compact.rs#L672-L759)）；**不要求为了当前 Note-reset/普通 DSH 应急摘要先复刻该结构**。

**P0 路由一致性阻碍必须实测：**Codex 在同一 captured step 内取配置/环境并用它定义本步工具和上下文（[session/mod.rs:3781-3835](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/mod.rs#L3781-L3835)）；DSH 则先 assemble/context/pre-step，后 prepareRequest，`agent/request` 仍可能改真实路由（本机 `dsh-agent-loop/lib/index.js:889-901,1017-1030,1143-1154`）。只看上一步 routed header 的压缩逻辑不能覆盖热切小窗口模型。**P2 可选扩展，不是 P0 阻碍：**remote V2 在本包 Responses adapter 尚未接收 Compaction output item，成功响应可能被判 empty，且无 opaque replay 序列化（`plugins/llm-responses.js:203-259,472-542`）；如果未来纳入，须先验证 trigger→SSE item→`ReplayEnvelope`→持久化→恢复重发的 mock round-trip，当前 Note-reset 不依赖它。

**新版本不能误读为默认开启的能力：**上游 `model_post_turn_compact_threshold_percent` 默认 0；大于 0 时才在本轮完成且无 pending input/取消、非 TokenBudget 模式下执行回合结束压缩（[config/mod.rs:4247-4250](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/config/mod.rs#L4247-L4250)、[session/turn.rs:700-728](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L700-L728)）。远程压缩由 provider capability 决定；实验性 TokenBudget/context-management 不等于普通会话默认压缩。清单/测试必须区分这三种路径。

**单会话契约的最小事实矩阵（固定上游 SHA）：**

| 机制 | 最新 Codex 源码 | 工单边界 |
| --- | --- | --- |
| 历史输入 | `instructions` + 活跃 `input` + 工具目录；只增量写 world-state diff 到历史，**并非**每个 HTTP 请求只发送差异 | DSH 的 system/user 拼装需验证等价性，而非仅复制差异文本 |
| 容量 | `resolved_context_window`、可用窗口百分比、auto-compact limit、服务端 usage+本地未采样项估算都分别核算；`Total` / `BodyAfterPrefix` 另有不同计数 | 不把单一 80%→90% 配置修改当作全方案 |
| 压缩 | pre-turn/mid-turn/可选 post-turn/manual；按 TokenBudget / provider V2 / local 分流；旧 remote V1 已删 | portable local 与能力协商 remote 必须分别排期；保留失败后本轮输入/历史的完整性 |
| 续传/恢复 | 本地持久化历史/快照为真相；缓存和 transport continuation 只优化传输 | DSH 存储与 Responses adapter 的边界必须跑恢复/模型切换测试 |

依据固定 SHA 的代码链/特殊情形见对应[研究笔记](../research/2026-09-23-codex-single-session-context.md) §§2–6。`token_budget` feature 默认关并不排除模型声明默认值自动启用；不能把“实验路径”与“不可触发”画等号。

## 迁移目标与边界（待确认）

目标（已纠正）：在同一个 `codex` DSH session 中复现用户所选的**剩余预算可见 → 模型自主写 Notes → 进入新上下文窗口 → 可按需回读先前会话历史**闭环，并保持已有工具、技能、目标、子代理与 `/compact` 可用。另建独立 session 不在当前工单批准范围；如果同 session 验证失败，停止并另问用户。**不默认声称可以无损复刻 Codex 服务端的私有能力**；平台差异必须有明确降级语义和验证。

选定的能力层次：

1. **TokenBudget 信号**：DSH routed-model 容量、token meter 与实际 usage 分别计量；模型可调用剩余预算工具，临界时收到提示。容量未知时走原生压缩，不伪造数字；本轮保留 Note 写入/应急摘要所需的空间。
2. **Notes / 自主切窗**：模型写并确认持久化 Note，安全 step 边界在同一 durable session 中替换活跃模型历史、重注入当前必要上下文；旧日志保留，Notes 与窗口映射在重启/恢复后仍可用。不要求普通 Codex local summary 作为常态模式。
3. **历史回读与人类可见性**：模型仅分页读取自己已记录的模型可见历史，旧历史不能提升权限；会话所有者可在 Web 面板看到 Notes/窗口/预算/应急兜底。Notes 私有 Codex 后端、服务端 opaque V2、WS continuation 和完整默认 world-state 复刻**不是首期目标**。

**更新后的建议交付顺序（尚非批准范围）：**P0 核实上游 Notes/预算/历史读取的真实契约和 DSH session-log 读取能力，做同一任务流 rollover→Notes→历史回读的端到端最小原型；P1 在已选窗口/会话语义内实现和验证整个闭环与重启恢复；P2 再视产品决定增强普通本地摘要或 provider V2。旧的“先做 local summary、把 Notes 留在 P3”分期**已废弃**。P0 要先指出哪些需求无法由预设/插件表达，不能为了让 P1 看起来完成而悄然把它们替换成 prompt-only 模拟。

**建议的本地映射（不是已实现承诺）：**预算模型用 DSH token meter + 真实路由的 contextWindow，暴露模型可主动调用的 `get_context_remaining` 工具和临界阈值提醒（不逐步重发数字；估算值带余量）；用插件专有的**一份**持久化 Note 文件（带写入版本/确认）；在安全 step 边界、Note 持久化成功后，用 session surface replace 重置活跃模型历史但**不删除原始 V3 日志**；新窗口只给出窗口 ID/Note 可读提示，模型主动读 Note，**不注入 Note 正文**；用受 session lineage 约束的分页历史读取工具读取旧窗口的原始已记录事件，不依赖 Web profile 默认关闭的 SQLite FTS。上游 native 的加密参数/私有服务器存储不得冒充本地等价物。注意 session log 查询 API 不验证“模型是否有权读其他 session ID”，插件必须做 ACL；恢复快照和原始日志是两套视图（参见专项核查 §3–4）。

**Note 缺失时应急 Compact 的已选行为与静态可行性：**现有 DSH `BasicCompactionEngine` 可以被子类化，并在唯一的 `ctx.compaction` owner 中选择 Notes-reset 或 `super.compactIfNeeded` 摘要；**不能**在活动 turn 内直接调用只允许 idle 的 `/compact` 命令，亦不能和现有 compaction-basic 叠挂两个 engine。此兜底**偏离上游 Codex 的 TokenBudget 路径**：上游无 Note 时仍 reset、从不自动换本地摘要（[turn.rs:1443-1466](https://github.com/openai/codex/blob/30fc6864cc1318121eca1843c217fe00ce1212f1/codex-rs/core/src/session/turn.rs#L1443-L1466)）。摘要本身需要 token headroom；真正 provider overflow 后重试可能再次溢出，必须在临界阈值前预留摘要余量、保持工具结果 pruner/可选大窗口摘要模型，并给出失败时可见错误。旧事件日志会留存，但不能承诺失败时 surface/工具输出和 checkpoint 锁完全不变（本机 `dsh-compaction-basic/lib/index.js:798-845,886-919`）。

**GUI 首期交付**：仅新机制的 `codex` session 中只读查看一份 Note 内容/版本、归属窗口、切窗时间线、剩余预算及**本窗口 Note 是否已读**；**同一聊天滚动区保留全部人类可见历史**，不把旧聊天搬入右栏。正常 Note-reset 和应急摘要分别追加可折叠的上下文窗口分隔标记，不遮蔽消息；**时间线节点可点开并跳回 Chat 对应标记**（`sessions.binding(id).session.loadThrough(seq)` 加 Chat 锚点，需要真实浏览器契约测试；不依赖不存在的 URL 深链）。须遵循 Web 客户端插件/会话 API 权限、状态刷新和安全渲染。已定方案：现有单一 `plugins/client.js` bundle 内注册**右侧栏「上下文」session tab + 会话标题区 opener**（需 `agentPreset === codex` **及新机制启用标记**同时成立，不能只检测 preset）；保留 composer 既有 token 圆环，宿主插件提供 `codexNotes`/`codexWindows` session projections，现有 `contextPressure` 等投影提供 UI 压力估算，另明确展示模型工具所见剩余额，两者不能混标。全量 Note 内容不进入每次 projection push，需按需授权读取。**已核实现有 Chat 视图展示 append-origin 历史，不随模型 surface replace 隐藏旧消息**；模型/人类请求快照和人类 UI 滚动行为仍须用新 Note-reset 路径实测。

## 初步实施清单（研究及 grill 后冻结）

- [ ] 固定模型/路由容量与 tokenMeter 实测矩阵：区分可用窗口、剩余预算、输出/Note/摘要预留及未知容量；添加临界提醒与 `get_context_remaining` 工具。
- [ ] P0 路由/step 一致性试验：在 context assembly 与真实请求间切换到更小窗口模型，断言实际路由、容量上限、world state、工具 schema 来自同一 captured step；若 DSH 现有 hook 无法做到，明确限制热切换或先提 upstream seam，不把“隔离”冒充一致性。
- [ ] 在 `codex` 预设隔离域里替换现有 compaction-basic row，挂载**唯一** `ctx.compaction` owner；同一 owner 根据持久化会话模式标记为老 session 委托原生摘要路线、新 session 启用 Note-reset，未知容量也委托原生路线；不能为旧/新会话同时挂两个引擎。安全 step 边界 reset，失败能解释、不会悄悄丢弃任务或静默换摘要。验证与旧 `54d5627^` compactor 的不同，禁止照搬过时实现。
- [ ] **未知容量优先级最高：**自动 Note-reset、模型主动 `new_context` 与手动 `/compact` 均不得走 Note-reset；前两者明确告知不可用，手动 `/compact` 保持现有普通摘要。即便本窗口碰巧有 Note，也不能反推未知容量可安全 reset。
- [ ] 定义唯一 Note 文件的写入/追加/读取、持久化 ack、**当前窗口新写入才算有效**的版本/重启恢复与用户面板 API；写入失败或仅有上窗口旧 Note 视为本窗口无 Note，预算迫近时在硬上限前显式降级为自动普通摘要 Compact，保留 pruner 与重试/失败分类，不做第二个并发压缩 owner。
- [ ] 给模型在同一会话旧窗口上提供只读、授权的历史列表/搜索/分页读取；过滤原始日志中的内部事件和未曾模型可见的内容，按窗口与事件序号限定阅读边界；已截断或丢失的内容明确标注，不能重新授权旧文本。给人类保留**原聊天滚动区**的历史连续性，无须新增第二套历史 UI。
- [ ] 切窗后检查系统提示/AGENTS/技能/目标/权限/当前任务的实际重注入，保留 UI transcript 与旧日志；测试 pending input、未完成工具配对、模型切换、断电重启、fork 权限与旧会话继续。
- [ ] fork 时拷贝可验证的 Note 版本和模式标记；子会话此后仅操作自己私有的 Note/历史，不读写父、兄弟会话；从旧模式 fork 仍是旧模式。GUI 时间线节点通过 `loadThrough(seq)` 在 Chat 同一 session 内跳转，测试消息分页与锚点加载。
- [ ] 摘要兜底后**逻辑删除**活跃 Note 并阻止旧文件再被读取用于切窗；事件/面板明确注明 `tool/call.arguments` 中的已记录旧版本、日志导出/备份不会因此被擦除；不宣称硬删除。
- [ ] 实现 `codex` 专用的 Notes/预算/窗口 Web 面板：`plugins/client.js` **现有唯一 client bundle** 添加 opener+tab；Host 插件提供会话投影（schema 使用 zod）与必要时的按需读取 API。可用性、安全渲染、键盘/窄屏、延迟与刷新测试纳入首期；人类无法从面板编辑 Note。
- [ ] 更新 `agent-presets/codex/check-rows.mjs`、`scripts/verify-presets.mjs`、插件导出/打包清单和**真实 Web profile 安装验证**；本包现有 `plugins/client.js` 为可直接服务的 JS bundle，不需为了它重建 Web shell，但源码并非运行中 Web profile 的安装副本：需打包/重装插件、重启所需运行时并刷新现有 `http://127.0.0.1:3080` 核验，不另起服务器。无法插件化的 seam 单列 DSH upstream 请求，不直接改官方 npm 包。

## 验收门槛

- 固定多窗口长会话 fixture 验证：工具查询预算→模型写 Note→持久化确认→安全切窗→用只读历史工具定位/分页读取旧窗口**已记录的模型可见内容**；切窗后模型请求中不隐含全量旧历史；可在面板验证窗口 ID/Note/预算/兜底事件。
- 确定性请求/事件断言：切窗成功只提交一次 checkpoint；断电重启/继续对话后 Notes、旧日志与当前输入投影一致；摘要兜底走固定 stub，保留区间没有孤立工具调用/结果；Note 存储失败、摘要失败、取消、旧会话、未知容量都走所声明路径。不能靠最终回答或 `check-rows.mjs` 的字符串 mount 测试充当验收。
- 面板仅对会话所有者可见，Notes 可审阅；未经授权跨 session/子代理请求要拒绝。旧的历史文本仅作为历史数据；原有工具、目标、技能、子代理和手动 `/compact` 不失效。
- 进入新窗口后有明确的 Note 读取指引；读前状态显示“未读取”，首次成功读取后状态更新。不拦截模型的其他工具调用。聊天连续展示原消息，并在重置位置显示正确类型的上下文分隔标记。
- 旧 `codex` 会话与其他预设不受影响；回退后既有 DSH-native 压缩可用；`npm test`、预设发布/安装验证及 GUI 刷新端到端用例通过。

## 待 grill 的决策树（不会暗自决定）

1. **目标语义和首期范围：已决定**。优先 TokenBudget/Notes/新窗口/旧窗口历史按需回读；普通 local summary 与 remote V2 非首期目标。
2. **权责边界：已定方向**。同一个 owner 负责 Note-reset 和无 Note 的提前摘要应急，不叠加 DSH-native 自动 engine；未知容量与旧会话维持既有行为，切换/回滚仍需测试。
3. **迁移政策：已决定**。只对新建会话默认生效，旧会话保持原策略；服务端私有 Notes/V2 不作为首期依赖。
4. **交付位置：已决定**。仅保留本仓库 Markdown 工单，不创建 GitHub issue。

| 决策 | 当前状态 | 解锁后续问题 |
| --- | --- | --- |
| 语义目标与首期范围 | 已选 TokenBudget / Notes / 历史回读；机制待专项核查 | 历史访问、预算展示、模型门槛与降级 |
| 目标预设 | 已选仅 `codex` | 不修改 `codex-creative` |
| 发布工单的位置 | 已选本地 Markdown | 不发布 GitHub issue |
| 新窗口 vs 新 session | 已选同一 session 内新窗口、人类聊天连续 | 做不到则阻塞该方案并重新向用户确认，**不是**自动另建 session |
| 包内实现位置 | 已允许 plugins 由 codex 专用挂载 | 不修改官方 DSH、不影响其他预设 |
| Notes / 历史范围 | 已选模型可见的已记录历史，默认只读自己的 | 截断/附件/页面限额验收；旧历史不升级授权 |
| Notes GUI | 已选右侧栏上下文 tab、会话标题区入口；保留原圆环 | projection/按需 API/状态刷新/可访问性待实现 |
| Note 结构/人类编辑 | 已选单份持久化文件；模型可写，人类在 GUI 只读 | 窗口版本/并发/审计待实现 |
| Note 切窗有效性 | 已选本窗口持久化写入；仅有旧 Note 不够 | 显式 new_context/自动切窗及回滚测试 |
| 应急摘要后的 Note | 已选逻辑删除活跃 Note，旧日志/导出不硬擦除 | 注明历史副本、验证清除时机与失败 |
| 新窗口 Note 交接 | 已选官方风格：给读取提示，模型主动读，不自动注入正文 | 不硬拦工具；面板记录“未读/已读”状态 |
| 聊天分隔标记 | 已选 Note-reset / 摘要兜底各自标明 | 不隐藏旧聊天、回放/重启后位置正确 |
| 人类会话历史 | 已选原聊天区同 session 可向上滚动/分页加载全部旧内容 | 现有 Chat 已支持，需测试自定义 Note-reset 保持此行为 |
| fork 模式/Note | 已选旧→旧，新模式→私有 Note 快照且后续不共享 | 子会话继承 revision/窗口元数据和 ACL 用例 |
| 时间线跳转 | 已选面板节点点选加载并滚动至原 Chat 分隔标记 | `loadThrough(seq)`/锚点集成与无 URL 深链的测试 |
| Note 写入失败 | 已选尽早摘要兜底，失败则明确报错不切窗 | 持久化确认和双失败测试 |
| 分页历史回读 | 已选单次限量、完整可遍历 | 游标、附件/截断说明、ACL 测试 |
| 无 Note 且超预算 | 已选提前自动普通 Compact 应急兜底，需显式标记 | 预留量/失败模拟、单 owner 验证 |
| 策略切换与旧会话 | 已选新建 codex 会话默认、旧会话保持原行为 | 新/旧会话判别、重启/回滚一致性 |
| 未知模型容量 | 已选不猜测、不自动切窗、原生压缩继续 | 保证只启用一个 compaction owner |
| 预算阈值/数值 | 已选估算值与保守余量、按模型安全默认、高级可调 | 提醒/Note 预留/自动摘要区间的实测与配置验证 |
| 手动 `/compact` | 已选新会话有本窗 Note 则 reset，无 Note 则普通摘要兜底（偏离官方）；旧会话原义 | 成功/失败/用户可见标记测试 |
| 验收指标 | 产品行为在上文已逐项选定 | 数值阈值、性能/延迟预算、事务/ACL 与真实浏览器 E2E 属工程验证，不能用文档测试替代 |

> 2026-09-23 用户已明确确认上述整棵设计树达成共同理解。本工单仍**不授予实施或部署授权**：当前请求仅为更新仓库、研究、写本地工单和 grill。
