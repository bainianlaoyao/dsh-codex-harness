# 模型输入、AGENTS 与技能指导对齐研究

日期：2026-10-06。范围按用户澄清限定为模型实际收到的提示、上下文及工具契约；DSH 原生 agent、协作工具与运行时是预期后端，不以复刻 Codex runtime、PTY 或私有传输协议为目标。

## 结论

**不能把短 preset persona 当成完整 system prompt。** 本地宿主已经有 system sections 拼装、动态 runtime context、AGENTS 层级与变更提示、技能目录与加载指导、目录去重及压缩后可见性检查。真正值得迁移的是明确的提示语义和少量信息组织策略，而不是再造整套注入器。

优先项：

1. 修正 `AGENTS.override.md` 被当成叠加文件的语义：当前真实宿主加载结果与 Codex 同目录覆盖规则不同，已复现。
2. 补充适配 DSH 的指令优先级与技能使用边界：用户指令优先、不能因技能的非强制内容额外索要确认、阻塞时说明具体依据。保留 DSH 的 `skill` 工具，不换成不存在的 `skills.read`。
3. 给技能目录增加总预算与可解释的裁剪策略，避免每条 500 字符截断既损失关键限定词，又无法控制目录整体大小。
4. 为首次进入子目录补明确 AGENTS 发现指导；当前宿主的自动增量发现只认识原生 read/write/edit，不能由此假定 exec_command/apply_patch 也会触发。

## 证据版本

Codex 引用固定到 `d63a9b8344cfe58bc78bbe319b560378fc8756ef`。DSH 使用实际挂载的 `node_modules/@deepseek-ai/*/lib/index.js`，本次所读包均为 `0.1.5-rc.1`。这里的 node_modules 是 npm-cache junction，未修改其中内容；不能凭 npm 版本号假定其字节等于任意远端仓库 HEAD，因此附本地 SHA-256：

| 包 | `lib/index.js` SHA-256 |
| --- | --- |
| dsh-persona | `1E9DD7F0DFD87CBFF6486B7CA043D2E1B863A2A56B99106A4BF74831591266D5` |
| dsh-system-prompt | `C55121DD92E88783ADC37A5F92E6C410304BAE39796D1E67218B5FAB8712BAFC` |
| dsh-agent-loop | `257EB83C00A05EE068E9F4BA80CA71AB94E3A1275D24B7A0CF5038FF23DD0FD8` |
| dsh-agent-instructions | `340F9A8836414F76E0F0F3B09C81DFDAE76FFE67C41A10B5E9C0737F20991C20` |
| dsh-tool-skill | `124B7475BDF80D842263CB2836426011CF083849371761478B2AF6D2EEE5DEFC` |
| dsh-skill | `41137835AD018BF1974EF781C14D2A7974DB4C502F484FC88D0B0608A26DE88E` |
| dsh-skill-filesystem | `1AEA87781BA5B4D44C7CFD6184D933A1C171A3FD2791456B65EBFC8B255F1221` |

以下 DSH 链接为本机实读源码的绝对路径与行号；它们对应上表的固定字节版本。

## 1. 实际 prompt 拼装：已有能力，不应重复迁移

Preset 注册 `persona.prefix`，但没有设 `complete: true` 或 `includeRuntimeContext: false`。宿主 persona 的默认值分别是 false、true；它只替换同名 persona prefix/suffix section，而非覆盖所有 system sections。[preset](D:/Data/DEV/dsh/dsh-codex-mode/agent-presets/codex/agent.cordis.yml:14)、[persona 默认值与注册](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-persona/lib/index.js:21)。

宿主 `SystemPrompt.assemble()` 合并 global 与 scoped sections/contexts、收集工具 schema、做稳定排序，再执行组装 waterfall；只有显式 complete section 才保留单个 section。[组装源码](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:307)。因此工具贡献的说明、运行时权限等上下文不因短 persona 自动消失；具体部署还有哪些额外 section 取决于实际注册组合，本研究不假定所有可安装包都已挂载。

`dsh-agent-loop` 每个 step 先组装并生成 runtime context，system 文本再按 prepared route 的 `systemPromptUpdate` 以及新 request series 决定原位替换还是历史内追加；工具变化或 surface replacement 也会开启新的序列。[pre-step](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:885)、[system projection](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:266)、[request 前提交](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:1008)。runtime snapshot 仅在变化或旧快照不再保留时重发，内容清空时有明确失效提示。[runtime projection](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:299)。

本地 Responses adapter 将 system 消息汇总进 `instructions`，普通上下文仍在 input 中。[序列化](D:/Data/DEV/dsh/dsh-codex-mode/plugins/llm-responses.js:201)。这是一种有效的请求组织方式，不能仅因与 Codex world-state 内部结构不同就判为差。是否能降低实际供应商缓存命中率，需要捕获连续请求和 cached token 数据，源码结构不足以量化。

## 2. 确认的不良差异：AGENTS.override 叠加而非替代

Codex 从项目根到 cwd 按层级收集，同目录候选依次为 `AGENTS.override.md`、`AGENTS.md`、配置的 fallback，遇到第一个存在的文件就返回，该目录只加载一个。[发现与优先级](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/agents_md.rs#L240-L303)。

当前 preset 配置 `instructionFileCandidates: ['AGENTS.md']`、`localInstructionFileCandidates: ['AGENTS.override.md']`；DSH 的 local 候选是 overlay，它遍历两组候选并加载所有存在文件，仅对同目录内容相同者去重。[配置](D:/Data/DEV/dsh/dsh-codex-mode/agent-presets/codex/agent.cordis.yml:23)、[发现循环](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js:531)、[去重含义](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js:624)。

**已复现**：直接调用实际包导出的 `loadBaselineInstructions()`，用内存文件系统提供同目录不同内容的两个文件；最终 prompt 同时包含 `Instructions from: AGENTS.md / BASE_ONLY` 和 `Instructions from: AGENTS.override.md / OVERRIDE_ONLY`。没有创建测试文件、调用模型或修改宿主。相同目录的额外规则也不会被 “more specific wins” 这一层级说明明确排除；用户原本希望完全替换的基础约束可能仍被执行。

建议 P1：在现有 DSH seam 增加“同目录 first-existing candidate”模式或 preset 专属选择策略，不能仅交换两个数组顺序；验收 override 存在、消失、修改、恢复、内容为空，以及父目录/子目录同时有文件的组合。保持 DSH 原生上下文和持久事件。

合理差异：DSH 用户级目录为 `$DSH_HOME/AGENTS.md`，不是 `$CODEX_HOME`；这属于产品命名与隔离，不是自动缺陷。两边项目根查找默认都依据 `.git`，没有根 marker 时限于 cwd；DSH 现有渲染也明确更具体目录优先、system/developer/直接用户指令优先，不缺这一基本层级说明。[DSH 说明](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js:113)、[根查找](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js:480)。

## 3. 子目录 AGENTS：迁移明确的编辑前发现指导

DSH 已有按触达路径增量发现子目录指令，不应笼统称为“只启动时读一次”：它保存可见 baseline、每 step reconcile 文件变化，并能发出替换/删除提示。[变更渲染](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js:212)、[reconcile](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js:906)、[pre-step](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js:1270)。

但是自动触达入口只接受工具名 `read`、`write`、`edit` 和 `file_path` 参数；在 `tools/result` 后排队，而不是在变更发生前注入。[触达识别](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js:1086)、[结果 hook](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js:1289)。Codex preset 推荐的 `exec_command` 与 `apply_patch` 不符合此识别合约；其 prompt 仅说 inspect existing code，没有明确“进入新子目录/仓库外路径前检查适用 AGENTS”。这是这条自动发现路径的确定覆盖缺口；是否还有部署方额外扫描，本研究未作全局排除。

建议 P1/P2：先加与实际能力一致的简短编辑指导，要求开始修改新目录前查适用 AGENTS、遵守文件范围与更深目录优先级；如要自动补齐，应通过宿主文件访问合约提供路径，而不是把 shell 任意字符串当成可信目标路径。Codex 仓库内的基础提示提供了上述明确指导，但当前模型模板可以不同，不能声称每个 Codex 模型都逐字使用该文件。[基础提示中的规则](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/protocol/src/prompts/base_instructions/default.md#L17-L27)。

## 4. 技能面：已经存在的指导与真正值得补的边界

当前已具备：模型可见名称/描述清单；用户显式 `/name` 注入；模型通过 `skill` 读取完整正文；加载前不可根据摘要编造技能内容；已注入技能无需再次加载；目录只展示当前模型能调用的技能。[目录与加载指导](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js:238)、[工具执行校验](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js:138)。加载结果还有资源 base directory/base URL，指示相对路径基于技能来源、引用资源按需加载。[资源指导](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-skill/lib/index.js:57)。因此“缺少技能发现”“不会给相对资源路径”“只有短 persona 所以技能没提示”均不成立。

Codex 不只有一份技能提示。catalog fallback 指导包含完整阅读、最少相关技能集、告知使用、缺失后回退、资源按来源读取；但当前 `gpt-6-astra`、`gpt-6.1-sol` catalog 配置 `include_skills_usage_instructions=false`，其 base model template 已包含自己的技能指导。[可选 catalog 指导](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/ext/skills/src/catalog_prompt.rs#L7-L47)、[条件注入](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/ext/skills/src/fragments.rs#L17-L33)、[当前模型元数据与模板](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/models-manager/models.json#L76)。

针对当前模板，值得提炼为 DSH 自己措辞的原则是：

- 用户明确要求优先于技能中的一般指导；不得因为技能没有明确要求的审批而额外停工。
- 使用技能时简短告知；如果技能让任务暂停、要求确认或留下未完成项，给出具体规则及来源，并区分原文要求与自己的解释。
- 未明确点名时依据实际收益选用技能，不仅凭关键词或表面相关性；把技能加载视作减少不确定性的步骤，而非机械匹配所有摘要。
- 阅读已选技能和必要引用时完整理解；保留 DSH `skill` 的完整正文加载方式与 resourceBase，不复制 Codex 的专有工具名。

DSH 当前目录要求“任务明确匹配描述即必须调用、加载所有适用技能”，未在该目录指导中提供上述用户优先/阻塞归因规则。[本地触发句](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js:250)。这与当前 Codex 模板的判断式触发不同，可能导致过度加载或无谓确认；这是提示质量改进建议，不能仅凭静态文本证明模型已发生该行为，也不能排除部署方其他 section 另有这些规则。

## 5. 技能目录预算：确定的组织差异，收益需按规模评估

DSH 当前默认每条描述最多 500 字符（JavaScript 字符串长度），归一化空白后尾部截断加 `...`；将全部 model-invocable 条目列出，此插件没有目录总 token budget。[默认值与目录投影](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js:40)、[裁剪](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js:359)。这既可能截掉描述尾部的 “do not use for...” 等负向限定，又不能在大量技能时限制目录总开销。

Codex 描述上限为 1024 Unicode chars，同时有目录整体预算：显式配置优先、否则模型 context window 的 2%，窗口未知时回退 8000 字符；裁剪/描述移除还有提示。这些是目标源码策略，不表示每个私有宿主都使用同一配置。[常量](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/ext/skills/src/render.rs#L19-L27)、[预算选择](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/ext/skills/src/render.rs#L126-L152)。

建议 P2：先测实际目录占用，优先保留路由必要语义和负向限定；加入总预算与明确 omission 提示，目录版本 digest 应基于实际展示条目。不要简单把 500 改成 1024 后宣称“对齐完毕”，也不要不加区分复制百分比；本地 provider 的窗口元数据必须先可靠。

已有目录缓存机制应保留：快照不完整时暂不替换；digest 与保留历史相同时不重发；目录变化发布完整替代目录；旧目录被压缩移出 surface 后重新发布。[更新与去重](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js:203)、[可见性恢复](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js:331)。文件系统 provider 也有默认开启的 watcher，不是每轮盲目重扫、也不是永久静态清单。[watch 配置](D:/Data/DEV/dsh/dsh-codex-mode/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js:26)。

## 6. 角色和原生措辞：合理差异与验证边界

Codex AGENTS fragment 的实际 role 为 user，技能目录为 developer；DSH 两者均通过 user message 的 source 标记注入，部分文本用 `<system-reminder>` 包裹。标签不会提升消息的真实 role，但这种差异不应直接等价成“全部技能失效”。应明确哪些是宿主行为指导、哪些是用户/项目来源内容，再用真实请求测试优先级；不能把所有用户可编辑文件盲目提升为 system。[Codex AGENTS role](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/context/user_instructions.rs#L10-L20)、[技能目录 role](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/ext/skills/src/fragments.rs#L39-L42)。

Codex base instructions 从配置/恢复历史/模型 metadata 中选择，当前模型模板不一定等于仓库某个旧版 `*_prompt.md`。[选择顺序](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/session/mod.rs#L764-L768)、[模型模板读取](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/prompts/src/model_instructions.rs#L7-L17)。因此迁移应形成一份与 DSH 现有工具名和审批能力一致的行为合约，不能整段粘贴含 `functions.exec`、`request_user_input_async` 或专用 app 操作的 Codex 模板。

本研究未运行完整生产会话抓包，也未对提示效果做模型 A/B。确定证据是源码拼装与 override 复现；“更少误触发”“更好遵守目录规则”“缓存更好”属于后续需要验证的效果。未修改任何用户代码或既有未提交上下文工作，只新增此报告。
