# dsh-codex-mode：基于 DSH 扩展面的模型对齐设计

创建：2026-10-14；职责复核与收敛：2026-10-15。状态：实现已落地；验证与边界见 implementation-status.md。

**本修订替代上一版“SessionPolicy + ContextKernel + 请求准入层”的架构。** 上一版虽写了复用 DSH，但仍把若干 DSH 已有职责重新分配给插件，并把更强的请求保证、独立状态层和安装器重构串成整体前置条件。这里撤回这些过度设计，按实际宿主扩展面划分工作。

实际核验发现根目录依赖为 DSH `0.1.5-rc.1`，plugins 目录另有链接指向本机 `0.2.0-rc.2`。完整回归使用统一的 0.1.5 依赖树；新增模型协议和 Notes 路径同时验证插件实际解析到的 0.2。Codex 对照仍为 `d63a9b8344cfe58bc78bbe319b560378fc8756ef`（2026-10-06），不代表 10 月 15 日最新上游。

## 1. DSH 是实际 harness，codex-mode 是模型适配与预设

DSH 不只是终端和工具执行容器。它已经负责 agent 创建/恢复、模型—工具循环、输入排队与取消、作用域与权限、工具呈现、指令组装、动态上下文、会话日志与模型历史、计量、压缩和客户端投影。

`dsh-codex-mode` 的任务是让 Codex 模型在这个 harness 中准确理解环境、正确调用工具，并在协议转换时不丢信息。Notes 是新增的一种上下文交接策略，应作为 DSH 的领域扩展接入，而不是再做一个上下文运行时。

默认设计原则：**宿主有领域能力就贡献数据或实现其后端；只有 Codex 特有的行为才由本包管理。** 工具名称无需完全一致，DSH 原生 agent、任务、提问、计划、终端与权限语义无需改成 Codex 的内部结构。

## 2. 实际职责分工

| 领域 | DSH 已有能力 | 本包需要承担的增量 |
| --- | --- | --- |
| agent 与调度 | `ctx.agents`、inbox、工具批次、取消、恢复、空闲维护 | typed agent 的角色说明与参数适配；不写 scheduler |
| system prompt | `ctx.systemPrompt.section/context`、scoped assembly、工具 schemas | persona、Notes 使用规则、少量不正确指引的修正 |
| 动态上下文 | runtime-context 完整快照、变化比较、来源、历史恢复 | 贡献 window/Note 状态；不另建 world-state 引擎 |
| 工具与 Code Mode | scoped registry、执行鉴权、native/PTC/hybrid、SDK、deferred context | 对齐现有工具 schema/描述/结果；按需补目录规则 |
| token 与容量 | `ctx.tokenMeter.measure`、压力/构成投影；adapter 的 `resolveModelInfo` | 模型查询工具、预警策略、修正本包虚构的容量默认值 |
| 压缩 | `CompactionEngine` 扩展面、Basic 后端、pruner、`/compact`、配对检查 | 一个 Notes-aware 后端；普通摘要继续使用已有实现 |
| 会话与历史 | append-only log、surface、`deriveMessages`、`foldSurface`、来源关联、fork cut | Note 修订、窗口关联、受权分页回读；不再复制消息模型 |
| 持久化 | session writer、flush 屏障、单写者、物理恢复 | 本包 Note 存储的确认与跨存储协调；不自建 session WAL |
| 状态与 UI | `sessionProjections`、stateVersion、快照、变更通知、冷读缓存 | 注册 Notes 投影与一个只读面板；不建第二套订阅系统 |
| 协议历史 | canonical messages、`ReplayEnvelope`、assistant source | Responses/Chat 的正确编码、图片、phase 与 opaque replay |

以上是扩展位置，不是“全部已接好”的声明。具体实现仍须验证本 preset 的 scoped composition：Web 关闭的一些全局工具需要 preset 自己挂载，不能仅因宿主包存在就认为模型能用。

## 3. 插件结构：保留现有形状，减少协调层

```text
codex preset
  ├─ DSH 原生工具、skills、goals、权限与执行
  ├─ persona / 少量 scoped prompt 修正
  ├─ Notes 工具与窗口 context 贡献
  └─ 一个 Notes-aware CompactionEngine
       ├─ DSH tokenMeter / pairing / session surface / flush
       ├─ DSH Basic 摘要兜底
       └─ 本包 Note revisions 与窗口关系

全局已有安装包
  ├─ Responses / Chat adapters 的内容保真修复
  └─ 现有 client + Notes session projection / 按需内容读取
```

继续使用 `plugins/context/`、`plugins/harness/codex-context-compaction.js`、两个 LLM Adapter 与现有 client。可以有私有共享函数/模块统一 Note 判定和恢复，但不要求新建 `SessionPolicy`、万能三入口 Kernel、通用 ContextJournal 或 `PreparedStepLease` 公共体系。

一个装配入口是否值得增加，由实际重复配置决定；“只暴露一个入口”本身不是目标。一个 compaction owner 则必须成立，避免两个后端同时响应压力或 `/compact`。

## 4. 模型输入对齐：只修实际差异

### 4.1 指令与原生工具

- 保留 DSH harness 身份与权限规则，persona 只补编码工作风格。原生工具描述已经正确时直接采用，避免 persona 再写一套会过期的操作手册。
- 修正 command job 与 subagent 等待指引混用；根据真实返回的 ID、可用操作说明行为。`send_message` 不冒充通用等待。
- fresh agent 要自包含任务；fork 使用 DSH 继承的已完成历史前缀，明确当前在途信息需要补充。角色类型只是 DSH 原生创建流程的适配，不是第二套 agent 管理。
- 工具隐藏后不应留下要求调用它的静态指引。先用现有 scoped `ctx.tools.get(name, scope)` 判断贡献文本，无需建立新的能力目录引擎。
- AGENTS 保留 DSH 原生 loader：同目录 baseline/local 都加载，局部冲突由 override 约束处理。原生实现会读取所有候选文件，不能只改候选顺序就声称实现了 Codex 的整文件替换；本插件不为这项差异重写指令加载器。persona 明确要求编辑前检查目标目录指令。
- apply_patch 和任意 shell 编辑前由模型检查目标目录指令；本次不另造文件指令发现系统，也不把执行后的指令刷新冒充执行前保护。
- skills 的发现、加载、来源、监视与恢复继续使用 DSH。只在最终 catalog 确有超长/截断问题时补总预算；不另造技能系统。

### 4.2 协议内容

这些是本包现有 Adapter 的责任，可独立修复，不依赖 Notes：

1. 两个 Adapter 保留 `tool-result.content` 内的图片；按实际协议支持选择原生结果或带 callId 来源的附件投影，和 PTC deferred context 去重。不能只留下“Image loaded”。
2. Responses 用 DSH 已有 `finish.replayState → assistant.source.replayState` 保存兼容的 encrypted reasoning/phase。遵守 per-block 裁剪，不恢复已丢弃的 tool call，不跨 endpoint/model 兼容域发送 opaque 内容。
3. 容量与 reasoning effort 归实际 adapter/model 元数据。未知模型不虚构 400k，也不全局硬套同一 effort 枚举。
4. 流内失败透传 DSH 支持的错误分类与 retry-after 信息，重试由宿主统一负责。

不为保持 Codex 内部字段而改变 DSH 的通用消息类型。普通工具输出、Note、历史材料不能提升为 system/developer 指令。

## 5. Notes 是 DSH 压缩策略扩展

### 5.1 产品行为保持

- 仅新建 `codex` 默认采用 Notes；旧会话、旧模式 fork 与 `codex-creative` 不自动迁移。
- 同一 durable session 内切换模型历史窗口，人类 Chat 历史继续保留。
- 一份逻辑 Note，模型可写/追加/分页读，人类只读。
- 本窗口成功持久化的新 Note 才能授权正常 reset；旧 Note 不能重复充当 fresh Note。
- `new_context` 无有效 Note 时拒绝。自动压力或 `/compact` 无有效 Note 时采用明确标记的普通摘要兜底。
- 新窗口只得到 Note 定位与读取提示，正文不自动注入，也不硬性禁止其他工具。
- 摘要兜底成功后撤销活跃 Note，历史副本仍保留。
- fork 按 DSH 精确继承 cut 取得当时 Note，父子不共享可写 Note。

这部分沿用[既有产品决策](../issues/2026-09-23-codex-single-session-context-migration.md)，不因简化架构而默默降低数据保留或主动读取要求。

### 5.2 接入现有压缩服务

以 DSH `CompactionEngine` 的 `compactIfNeeded / compactNow / compactRegion` 为外部约定，Notes 后端只增加“用 Note 交接还是普通摘要”的策略。复用配对 helper、compaction 标记、单次 surface replacement 与错误分类。

`new_context` 只记录待切窗意图，先让 DSH 正常完成当前工具调用及结果，再在后续步骤的压缩处理点执行；不能在工具执行中清空含未闭合调用的 surface。返回 requested，只有实际 replacement 提交后才显示新窗口。

被替换范围不得越过 Note 对应请求已见的历史。Note 之后的兄弟工具结果、用户补充和通知保留在尾部。不能使用工具执行时的最新 seq 作为“模型全部看过”的证明。先从 DSH 请求记录和 surface 重建所需范围；仅在确有证据缺口时添加最小的本包关联信息。

正常 checkpoint 是 Note 定位与交接指导，不塞 Note 正文。沿用宿主支持的一条 checkpoint 与未替换尾部，不默认要求宿主支持任意多消息原子替换。

上一版额外提出“每次重插任务起始消息及所有当前 turn 原消息”，这不是已确认的 Notes 产品要求，还会把压缩变成复杂的多节点重排。本版撤回该强制规则：保留未覆盖输入；已覆盖任务通过 Note 和历史回读恢复，验证跨轮纠正没有被语义遗漏。若某具体任务确需额外保留锚点，作为保留策略单独评估，不能当作全插件前置条件。

### 5.3 预算直接用 DSH

`get_context_remaining` 包装 `ctx.tokenMeter.measure(session, requestHeader?)` 与实际模型容量，附 route/window/估算来源和时间。不自建 token 估计、provider usage 校准或压力投影。

DSH 的 `totalTokens`、`surfaceTokens`、`contextPressure`、`contextBreakdown` 含义不同，不能再把 system/tools 数重复加进总数。输出余量、预警、Note 维护余量属于 Notes 策略；必须先对照 meter 和已有 compaction 的语义，再决定是否添加配置。

撤回上一版未测量就指定的 75%/85%、额外 5% 等默认预算体系。先沿用 DSH 现有按模型策略，增加有需要的提前写 Note 提醒。未知容量明确 unknown；“支持切窗”和“当前 Note 合格”分开返回。

### 5.4 持久性与状态只补 Notes 的部分

保留 revision、digest、幂等操作 ID 和 fork cut 等必要事实。Note 写入必须有持久确认，切窗 checkpoint 引用确切 revision。可以用不可变 Note revision 避免双可变文件的不一致，但不把本包做成另一个会话存储系统。

窗口事实优先依据原生 compaction checkpoint 与其来源关联重建。`state.json`/窗口列表是可恢复投影，不因为投影没更新就永久卡住。摘要成功才撤销 active Note；写入或摘要失败不暗中丢失旧 surface。

DSH 已承诺持久化后端的 flush 屏障、单写者与物理恢复，不需重设计这些能力。本包仍需测试 Note 文件与 session checkpoint 之间的跨存储故障，这是插件新引入的责任。

**外部事件限制必须尊重：**类型层的 `SessionEventMap` 可扩展，不代表已安装的 persistence codec 会接受任意 required 事件。当前 known-event catalog 明确外部事件通过 `ignorable` 兼容；会影响恢复正确性的 Note/window 事实不能假装是可忽略信息。优先用既有支持的消息/来源/compaction 表达，必要信息留在本包版本化 Note 状态；若确实无法满足恢复，才提出具体的宿主扩展，不先要求整个新事件体系。

### 5.5 历史与 UI

历史回读先复用 DSH 的 log-prefix、`foldSurface`、`deriveEventMessage` 和 request header 关联。这些公开能力已经用于重建请求的规范消息。不要直接筛 raw log 的所有 user/tool 事件，也无需默认增加另一套完整 request-frame ledger。缺失的内容或无法定位的尝试明确说明，不能声称恢复逐字 wire/服务端隐私内容。

注册一个 Notes session projection，由 DSH 驱动状态、stateVersion、fork 初始化、快照与变更订阅。面板读这个投影；Note 大正文按需分页，不塞进每次状态通知。只有现有受权读取接口不满足内容读取时才补小型端点，不新建状态广播协议。

保留右侧只读面板、标题入口、同 Chat 分隔标记和跳转。composer 圆环继续使用宿主语义。已读取状态可先表达明确的读取范围；不为推断“模型理解了 Note”新增阅读追踪系统。

## 6. 真正需要核实的限制，不与插件范围混为一谈

| 问题 | 本次判断 |
| --- | --- |
| DSH 能否同 session 改模型历史并保留人类历史？ | 能，surface 与 append-origin transcript 本来就分开；不是新增宿主能力 |
| 能否替换压缩策略？ | 能，CompactionEngine 就是此扩展面；Notes 策略不应另造协调框架 |
| 是否已有计量、状态投影、上下文去重、replay？ | 有，应直接消费 |
| pre-step 是否拿到下一次最终 prepared route？ | 没有；仍是先 pre-step，后 agent/request 与 prepareCall |
| 所以 Notes 是否必然完全无法通过插件做？ | 不能推出。DSH 自带压力策略也使用最新持久路由；要分别验证 Notes 行为与额外的路由冻结要求 |
| 是否已有任意插件 required event 的持久解码？ | 不能这样假设；需遵守 known-event/ignorable 约定 |

**对上一版结论的修正：**“所有对齐工作、乃至 Notes 最小策略都必须先改 DSH”说得过重。严格要求“同一次最终 prepared route 上决策、改历史、再发送”时，现有公开 hook 的确不足；但它是一项明确的额外保证，不是 DSH 缺少上下文管理，也不能据此引入一整套 admission lease。

2026-10-15 用户已明确选择沿用 DSH 原生语义，撤销下一次最终路由严格冻结要求。预算使用最近持久路由并明确标为估算；后续换模型由原生 overflow recovery 处理。没有私有 route-freeze 字段或额外宿主 hook。

另一个真实时序问题：runtime context 在 pre-step 前已经组装，切窗后不能把旧 window hint 送给模型。先验证通过 checkpoint 与现有 context/decision 机制消除旧提示的办法；若仍无法表达，提出这一具体更新需求。不要为了这个问题重复实现整个 world-state。

## 7. 范围取舍与验证

### 本包现在值得做

1. 修协议信息损失：嵌套图片、replay/phase、模型能力声明与流内错误。
2. 修最终 prompt 中与实际 DSH 工具不一致的部分；验证 AGENTS 候选与 scoped composition。
3. 沿现有 Notes 原型完善 Note 存取、原生 compaction 后端、tokenMeter 包装、历史分页和 session projection。
4. 验证新/旧会话、fork、同批工具、steering、取消、重启与跨存储失败，最后验证安装后的真实 Chat 使用路径。

### 从这轮主设计移除

- 独立请求准入框架、统一模型上下文运行时、另一套动态状态/权限/工具目录机制。
- 新 token 计量器、usage 校准、完整请求历史账本、客户端订阅系统。
- 终端/JS 执行器、agent scheduler、私有 Codex 后端或远程压缩协议的复刻。
- 无关的 publisher 整体重构、任意存储抽象和泛化迁移平台。新增路径的 exports/发布映射及安装验证仍然必须做。
- 为“最近 Codex 有了”而无条件添加 tool_search、as_settled 等表面。优先检查 DSH 已有 PTC/发现/并发能力，确有模型使用收益再补。

### 验证只跨真正发生变化的路径

- Adapter：真实工具 renderer → DSH message → 最终 wire；replay 的存储、恢复与裁剪。
- Prompt：实际 preset/scoped assembly，不只测试 persona 字符串。
- Notes：真实 DSH loop/compaction/session，完整写 Note → 请求切窗 → 结果闭合 → 下一窗口 → 主动读 Note；外部模型可 mock，但不 stub 掉 reset 主路径。
- 持久化：只重点注入本包新增的 Note/窗口协调失败，不重新认证整个 DSH 存储引擎。
- UI：原 session Chat 保留历史、fork 准确、投影更新和分页；不只验证源码目录可加载。

实现已完成 Notes 预设挂载、协议保真、分页与客户端投影。真实 DSH loop、JSONL 恢复及原生摘要兜底已验证；未部署到运行中的用户服务。

## 8. 依据

- [现有 codex preset](../../agent-presets/codex/agent.cordis.yml)：原生工具、skills/goals 与 compaction 的实际装配。
- [DSH loop 公开约定](../../node_modules/@deepseek-ai/dsh-agent-loop/README.zh.md)：输入、步骤、路由、系统消息和恢复。
- [system prompt](../../node_modules/@deepseek-ai/dsh-system-prompt/README.zh.md)：sections、contexts、scope 与工具指导归属。
- [token meter](../../node_modules/@deepseek-ai/dsh-token-meter/README.zh.md)：测量、provider anchor 与 UI 投影。
- [compaction Interface](../../node_modules/@deepseek-ai/dsh-compaction/lib/types/index.d.ts) 与 [Basic 后端](../../node_modules/@deepseek-ai/dsh-compaction-basic/README.zh.md)：已有扩展位置及路由策略。
- [surface 公共类型](../../node_modules/@deepseek-ai/dsh-session/lib/types/surface.d.ts)：模型消息重建与人类 transcript 分离。
- [session projection](../../node_modules/@deepseek-ai/dsh-session-projection/README.zh.md)：状态贡献、fork cut、订阅及缓存。
- [session persistence](../../node_modules/@deepseek-ai/dsh-session-persistence/README.zh.md) 与 [外部事件兼容约定](../../node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js)：flush 保证与事件限制。
- [模型可见对齐审计](../research/2026-10-06-model-facing-alignment.md)、[既有 Notes 决策](../issues/2026-09-23-codex-single-session-context-migration.md)：保留已证实的问题与产品约束；架构以本修订为准。
