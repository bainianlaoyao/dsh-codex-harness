# 模型可见上下文与工具契约对齐复查

日期：2026-10-06。原生参考：Codex `d63a9b8344cfe58bc78bbe319b560378fc8756ef`；本地对象：dsh-codex-mode 0.3.5 工作树及其当前 node_modules 中的 DSH 模块。

## 本轮口径

按用户澄清，本轮比较的是模型实际获得的 system prompt、动态上下文、工具 schema/描述/结果和历史保真。DSH 原生 agent、提问、计划、终端和权限后端是既定基础。工具不必同名、实现不必一致；只有引发误解、丢失信息或无效行动的差异才算负面对齐。

本报告取代前一份 [广义 harness 检查](2026-10-06-codex-harness-alignment-audit.md) 的迁移优先级。PTY、重写调度器、引入完整 Codex runtime 不属于当前重点。没有修改业务代码或用户既有未提交代码。

## 真实的输入组成

不能把 preset 的几段 persona 当作全部 system prompt。当前链路为：

1. DSH SystemPrompt 注册全局 sections、动态 contexts、工具 schemas。
2. preset persona 只遮蔽同名 persona section；默认 `complete:false`，不清除其他模块贡献。
3. 挂载的 jobs、subagent、skills、plan mode 等模块继续贡献自己的指引。typed-subagents 再通过 assemble middleware 补类型目录与 agent_type enum。
4. agent-loop 每 step 组装；稳定 system sections 与 runtime-context 使用不同投影，动态上下文有去重和恢复逻辑。
5. OpenAI adapter 将这些 DSH 消息转换为最终协议。这个边界仍可能丢失信息，即使上游工具结果正确。

依据：`node_modules/@deepseek-ai/dsh-persona/lib/index.js:24–49`、`dsh-system-prompt/lib/index.js:300–367`、`plugins/typed-subagents.js:108–125`。宿主上下文细节见 [指令与技能专项报告](2026-10-06-model-context-instructions.md)。

原生参考也不能只读旧的 `models-manager/prompt.md`：当前 catalog 中 gpt-6 等模型有各自 `model_messages.instructions_template`，skills usage 指引也可能已包含在该模板中，而不是通过旧的通用片段重复注入。[当前模型目录](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/models-manager/models.json#L4-L76)。

## A. 明确的上下文损失：应先修

### A1. 工具返回图片在 Responses 普通调用路径被丢弃

这是本轮最明确的功能性问题。

- `plugins/tools/view-image.js:68–77` 的 render 正确输出 text + image attachment。
- DSH `dsh-agent-loop/lib/index.js:697–703` 通过 `createToolResultMessage` 包装结果；`dsh-llm/lib/index.js:94` 将图片放在 `tool-result.content` 内。
- `plugins/llm-responses.js:235–260` 只识别消息顶层 image，处理 tool-result 时调用 flattenText。因此直接调用 view_image 的这张图片不会序列化为 input_image。
- 同目录 `llm-openai.js:158–193` 也对 tool result flattenText，静态上有同类问题；本次动态探针针对 Responses。

原生 view_image 返回带图片的 FunctionCallOutputBody，而不是只留下“已加载”文字。[原生结果](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/tools/handlers/view_image.rs#L230-L250)。

**复现**：用真实 view_image renderer + 真实 DSH 消息构造函数 + 当前 ResponsesAdapter，mock 网络，图片 attachment 没被读取，wire 不含 input_image，却包含 Image loaded。把同一图片作为顶层 user image 输入时成功读取并发出，正对照通过。

范围：这是支持图片模型下的普通/native 工具调用路径。DSH PTC 的 image-bearing 子工具另有 deferContext 路径（`dsh-tools/lib/index.js:1295`），不能把上述结论扩大为所有模式都看不到图；也未验证当前生产 profile 使用哪条路径。

建议：在 adapter 层保留工具结果中的多模态内容与 call ID 关联；对不接受原生多模态 tool output 的路线，采用明确的相邻图片消息投影。工具宣称的 detail 也应与实际传输一致，当前顶层图片固定发 high。验收必须检查最终 wire，不只检查工具 renderer 或 base64 的存在。

### A2. Reasoning item / phase 丢失仍属于本轮范围

它不是终端或运行时复刻问题，而是模型历史的保真问题。前轮离线探针已确认：adapter 不回传历史 reasoning item，也丢弃响应中的 encrypted reasoning 和 message phase。参见 [原报告第 1 项](2026-10-06-codex-harness-alignment-audit.md)。

建议按 provider 能力保存原始 opaque item 和 phase，贯通持久化、恢复、压缩和下一次请求；不将它们改写成普通自然语言摘要，也不跨 provider 混用。用户可见 reasoning summary 不等于可回传 reasoning state。

## B. 确定存在的提示组合问题：保留 DSH 后端，修包装

### B1. AGENTS.override 的替换语义变成了叠加

preset 将 AGENTS.md 放进 instructionFileCandidates，将 AGENTS.override.md 放进 localInstructionFileCandidates。当前 DSH loader 会叠加 baseline 与 local 文件；原生同目录优先选 override，仅载入一份候选文件。

损失不在文件命名不同，而在原本用于替换的旧规则重新进入模型上下文，增加相互矛盾的指令和 token。已由专项研究调用真实 loader 复现。迁移应只调整这个兼容策略，不丢掉 DSH 已有作用域和来源说明；详细证据及路径见 [专项报告](2026-10-06-model-context-instructions.md)。

### B2. 工具隐藏后，相关 system 指导没有同步隐藏

`plugins/tools/restrict.js:23` 只隐藏 bash。宿主 `dsh-tool-bash/lib/index.js` 注册的 `tool:bash` section 不检查工具是否仍可见，内容仍指导检查 bash 的 `[exit code: N]` marker。

已使用实际 Cordis + SystemPrompt + ToolRuntime 做隔离组合测试：host 挂 bash，session scope 应用当前 restrict 后，assembly.tools 无 bash，但 assembly.sections 仍有 tool:bash。当前 exec_command 的结果格式也不是该 marker。

这是条件明确的组合问题：host 确实挂 bash 时触发，不代表所有 profile 都如此。建议提示贡献与最终可见工具集合联动；保持“检查命令退出状态”的通用规则，但引用实际工具和格式。不要为了消除残留而设 `complete:true`，那会连其它有用的宿主指令一起去掉。

### B3. fork 的原生描述与统一包装指导不一致

DSH `dsh-tool-subagent/lib/index.js:343–351` 明确区分：fresh child 要完整独立 prompt；fork child 已继承已完成轮次，只需说明新增任务，而且不包含当前进行中的 turn。

`plugins/typed-subagents.js:119–120` 先承认 fork 使用已完成历史，随后又对两种工具统一要求 prompt 是 complete startup instruction、必须 self-contained。这是保守但重复的指导，不是数据丢失：容易诱导把继承历史再总结/粘贴一遍，甚至把“类型不提供角色指令”误解为“fork 不继承约束”。

建议：保留类型只选 route/preset、不给额外权限的设计；fresh prompt 自包含，fork prompt 只补新任务、当前 turn 尚未继承的信息和关键约束。不要改成 Codex 的 spawn_agent 后端，也不要求两个工具合并。

### B4. 创造模式混用 job/终端会话/子代理的等待指引

`agent-presets/codex-creative/agent.cordis.yml:28` 将 command、job、subagent、workflow 全部归到“保持 turn，通过 job_output/write_stdin 轮询”。

但 typed adapter 使用 continuable 子代理（`plugins/typed-subagents.js:99–100`），原生返回 `started subagent <subagentId>`，不是 background job ID（`dsh-tool-subagent/lib/index.js:486,520`）。原生 guidance 说明完成后发通知、send_message 可继续/steer（同文件 `:579`）。list_agents 可查询生命周期状态，但 idle/ready 不应直接当作工作已完成。

损失：模型可能把 subagentId 给 job_output，或反复 send_message 询问完成而意外触发新轮。这里指出的是提示没有提供按对象区分的闭环，**不要求重写 DSH 调度器**。

建议在一个位置清楚说明：exec ID 用 write_stdin；job ID 用 job_output；continuable subagent ID 用原生通知/协作工具；send_message 是发工作或 steering，不是只读等待。只在对应模式和确有 pending work 时加入等待指导。不能把“do not busy-poll”与阻塞等待简单认定为逻辑矛盾，真正问题是对象类别与接口不匹配。

### B5. 更换文件工具后，子目录 AGENTS 自动发现的触发条件不再覆盖

宿主确实支持增量 AGENTS 发现和更新，但 `dsh-agent-instructions/lib/index.js:1086,1289` 的触达识别只检查 read/write/edit 的 file_path，并在工具结果后处理。当前 preset 主推 exec_command/apply_patch，不符合该入口；persona 也没有明确要求编辑新子目录前先查适用的 AGENTS。

这不是要求换回 DSH 文件工具，而是适配层换了工具表面后，原先提供上下文的 hook 没一起适配。建议先补简短的编辑前发现指导，再通过可靠的文件路径访问接口接入宿主；不应尝试从任意 shell 文本猜完整文件访问集合。具体部署可能还有额外注入机制，本次未声称全局排除；现有这条自动路径的覆盖缺口是确定的。详见专项报告第 3 节。

## C. 值得从原生吸收的行为提示

当前 short persona 已有“直接工作、持续到实现与验证”“只问用户拥有的决策”，DSH 工具自身也有背景委派、计划更新和技能加载指引；这些不需要重新复制。

当前 gpt-6 catalog 中可移植且更精确的内容是：

| 提示模块 | 建议保留的行为语义 | DSH 表达方式 |
|---|---|---|
| 用户意图与持续执行 | “能否帮我做”通常是执行请求；已有授权和偏好跨轮保留；中途纠正更新当前任务 | 薄 persona/policy section，不改 loop |
| 提问与审批 | 先检查可查事实；只问真实缺失的选择；不要因为 skill 含糊措辞自动增加确认 | 使用 ask_user_question；保留真正 approval seam，不混为同一机制 |
| 工作进度 | 多步骤工具工作前短说明，长任务中报告新发现；不要只说计划就结束 | 普通 assistant 消息，适配当前前端展示 |
| 验证与完成 | 报告做了什么、验证了什么、还有哪些未验证；不要把静态格式测试当语义验收 | 保留 DSH todo 与工具结果，不强制原生 update_plan |
| 技能适用与优先级 | 显式指定就读；可选技能按实际帮助判断，避免仅因关键词强制；用户指令优先；skill 导致停工时解释具体来源 | 保留 DSH skill loader，仅改使用指导，补与 AGENTS/用户输入的优先级说明 |
| 上下文结束/恢复 | 摘要是历史；保留原任务与新纠正；恢复后继续剩余工作，别重新执行已完成步骤 | 在现有 compaction/resume 指引中补充，配合历史/工具对保真 |

这是建议的行为契约，不能凭“原生有一句、本地少一句”断言质量下降。应先捕获目标 profile 的完整请求，查宿主是否已覆盖，再用具体任务评估。本轮未读取生产聊天日志，也未运行真实模型 A/B。

不建议整份拷贝 Codex 模板。模板含特定工具/API/前端与身份约定；本地已有 DSH 规则，直接复制会制造第二套工具名、审批承诺和技能加载方式。尤其旧 fallback prompt 里的 apply_patch 示例不等于当前 freeform wire 契约。

## D. 上下文预算与稳定性

- DSH 已有确定性工具排序、scope shadow、动态 context 去重；不需要从零移植原生 world-state 系统。优先比较最终请求中哪些片段变化、是否重复、是否遮蔽旧指令。
- 技能目录应按模型预算限制总量，同时避免无提示地裁掉触发描述；原生已有目录总预算与省略提示。专项报告给出当前 DSH 每项截断与总量差异。
- typed agent catalog 被追加进 system sections，配置可热更新；这会改变 system prefix，不必一概视作 bug。应测实际变更频率/规模，限制目录总量，而非为缓存永不更新目录。
- 未知模型被适配器视作 400k 的问题仍与本轮相关：它会让任何目录/压缩预算都建立在错误假设上。应保留 unknown 或明确配置来源，见前轮报告。
- 现有 Notes 工程仍未挂入 preset；不能为了上下文对齐直接启用。先定义活跃任务、指令、可见工具和路由容量在切窗后的输入契约。
- 当前 DSH tools 已存在 native/PTC/hybrid 及 run_code/SDK 指引（`dsh-tools/lib/index.js:887,1593,2652–2735`）。下一步应检查目标 profile 选用的模式与模型输入，不应把“原生有 Code Mode”直接转成“DSH 需要新造 JavaScript runtime”。

## E. Notes 上下文压缩：独立的核心实现主线

用户补充明确：Notes 上下文压缩功能的实现也在重点范围，不能仅作为末尾的预算优化。本节核对现有代码与待完成闭环；不是声称已经实现交付。

目标：**同一 DSH session 内，模型看预算→写本窗口 Note→确认持久化→安全切窗→收到 Note 读取指引→主动读取 Note/按需回读旧历史→继续原任务**。人类聊天记录连续保留。沿用 DSH session/compaction 服务，不依赖 Codex 私有 Notes 后端。

### 已有实现

- `plugins/context/context-state.js`：会话私有 Note 文件、写入版本与当前窗口确认；新旧会话模式区分；fork 私有复制及旧边界拒绝；窗口记录；摘要后撤销活跃 Note。
- `plugins/context/context-tools.js`：预算估算，Note 读/写/追加，窗口列表与自己会话历史分页；没有任意 sessionId 输入。
- `plugins/context/context-mode.js`：窗口标识与 Note 读取提示，不自动注入 Note 正文。
- `plugins/harness/codex-context-compaction.js`：继承一个 BasicCompactionEngine，手动 Note reset 的检查/持久 checkpoint 和普通摘要兜底；失败状态检查。
- `plugins/context/context-web.js` 与 `plugins/client.js`：上下文面板/API 草稿，属于已有未提交工程，仍需实际挂载与 UI 验收。

### 当前阻碍闭环的地方

1. **未挂载**：codex preset 仍使用 compaction-basic，相关模式/工具/面板服务未组成可运行链路；导出和 smoke 通过不是功能上线。
2. **模型不能主动切窗**：提示集合提到 new_context，工具注册里没有它。resetNote 目前要求 closed turn；模型发出 new_context 时通常仍在 turn 内，不能直接将工具 execute 绑定到 compactNow 冒充实现。需要请求式切窗，在安全边界处理并正确保存本次工具调用/结果。
3. **自动路径未完成**：compactIfNeeded 明确委托普通摘要；Note 存在也不会自动选择 reset。缺少完整的预算预警→写 Note 余量→安全 reset/无 Note 提前摘要策略。
4. **真实请求路由未冻结**：手动 reset 依赖 codexCapturedRoute；当前生产路径没有建立这份授权快照的代码。budgetFor 只凭容量就宣告 noteResetAvailable，与实际执行前提不一致；adapter 的未知模型 400k 默认值进一步使预算可信度不足。
5. **切窗后的输入还需验收**：resetNote 保留首个 system 节点、替换其余活跃历史，checkpoint 显式保留最后一条真实用户文本；原任务、较早约束及用户后续纠正还依赖 Note 与宿主重新注入。不能把“最后一条消息”自动等同“完整任务”，也不能仅以摘要标记存在证明 AGENTS/技能/权限/工具目录已正确恢复。
6. **读取预算不闭合**：Note 允许 1 MB 且整份返回；历史每页最多 50×4000 字符。需要读 Note/历史的总输出预算与分页，否则恢复本身会耗尽新窗口。
7. **恢复与事务只做了部分防护**：session checkpoint 与外部 Note metadata 是两处持久状态，现有实现发现不一致时拒绝继续。需要故障注入验证持久化中断后的恢复/明确修复路径，不能把拒绝继续视作已经完成恢复能力。

### 完成定义与实施顺序

1. 先落实真实 step 的 provider/model/capacity 与工具目录快照，以及安全切窗的宿主边界；若现有插件 hook 不够，把缺少的 seam 单列，不取消现有检查绕过去。
2. 接入单一 compaction owner；旧会话继续原策略，新 codex 会话启用 Notes。新增 new_context 请求与自动阈值处理；未知容量禁止 Note reset；无本窗口有效 Note 时提前走明确标记的普通摘要。
3. 定义 Note 建议内容：当前目标、用户约束/纠正、已完成及验证、未完成事项、关键文件/决策、待处理协作。保持模型自由写作，但切窗不能只依靠“请记住重要内容”一句话。新窗口只注入读取指引，Note 正文按需读。
4. 完成切窗后实际请求快照、原会话聊天连续性、面板状态及历史回读验收；覆盖模型切换、取消、写 Note 失败、摘要失败、重启与 fork。

当前 `codex-context-compaction.smoke.js:30–45` 把 nativeManualCompact/manualCompact 替换为 stub，主要验证分流和不安全 reset 的阻断；它不执行真正的 resetNote 成功链。因此现有测试通过不能证明上述端到端闭环。交付必须至少有一个实际 session surface→reset→下一次模型请求的集成用例。

既有详细需求保留在 [Notes 工单](../issues/2026-09-23-codex-single-session-context-migration.md)，继续在这份工程上补齐，不另造第二套 Note 系统。

## 推荐执行顺序与验收

Notes 作为与下面内容并列的核心实现主线，按 E 节推进；其预算和输入保真前置条件与第 1、4 项共用，不降为可选尾项。

1. **模型内容保真**：先修 tool-result 图片，再补 reasoning/phase round-trip。测 tool renderer→DSH durable message→最终 wire 的整条链，含恢复和 text-only 降级。
2. **提示组合去冲突**：AGENTS override 与子目录发现、隐藏工具残留提示、fork 和等待指导。捕获两个 preset 的 native 及已支持 PTC 配置；验证工具名/ID 类型/结果格式能互相对应。
3. **薄行为策略**：只补完整请求中确实缺少的持续执行、提问、技能优先级、进度与验证规则。使用 DSH 工具名，不拷原生身份/工具实现。
4. **预算与恢复**：技能/类型目录总预算、真实模型容量、压缩后的任务/指令/工具保留；用长目录和跨窗口 fixture 验收。

请求快照验收场景：普通编码、新 fresh child、fork child、目标模式等待、Plan 模式、AGENTS/override 共存、显式 skill、长 skill 目录、图片工具结果、压缩后恢复。比逐字比较 Codex prompt 更有用的断言是：可见工具的使用指导正确，禁止/隐藏工具不再被建议；关键约束仍在；工具结果没有失真；同一信息没有无意义重复。

## 本轮验证

- `.tmp/codex-model-content-audit.mjs`：真实图片 renderer、真实 DSH 工具结果构造、当前 ResponsesAdapter；图片丢失复现及顶层图片正对照通过。无真实 API 请求。
- `.tmp/codex-prompt-surface-audit.mjs`：真实 Cordis/SystemPrompt/ToolRuntime，最小 host bash + scoped restrict；隐藏 schema 后残留指导复现。未执行命令。
- AGENTS 共存由专项研究调用真实 loader + 内存 FS 验证；见专项报告。
- 没有重跑无关完整测试，没有更改插件实现、已安装 profile 或生产配置。上述是隔离组件/组装证据，不声称已抓取生产会话的完整请求。
