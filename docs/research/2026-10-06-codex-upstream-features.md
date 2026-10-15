# Codex 新增 harness 能力迁移评估（2026-10-06）

## 范围与结论

研究范围为本地 `codex` 源码从 `30fc6864cc1318121eca1843c217fe00ce1212f1` 到 `d63a9b8344cfe58bc78bbe319b560378fc8756ef` 的提交差异，并回读目标 SHA 的实际实现。以下引用均固定到目标 SHA；提交链接用于说明变更来源。优先级是针对 dsh-codex-mode 的工程判断，不是上游发布承诺。

最值得先迁移的是 **Responses 错误中的重试建议保真**、**压缩后的完整上下文 checkpoint**、**结构化 world-state 快照与有序更新**。Code Mode 搜索、流式并发结果和抢占值得设计，但需要运行时支持，不能仅把工具名称和提示词复制进 preset。

本次只写研究文件；没有修改用户已有的未提交 `plugins/context/`、`plugins/harness/codex-context-compaction.js` 等上下文工作。该工作已实现 Notes 与手动 reset 的防护，不能按 README 的历史定位假定整个仓库“完全没有上下文能力”。

| 候选 | 优先级 | 上游适用边界 | 迁移落点 |
| --- | --- | --- | --- |
| 流内错误的 Retry-After 与错误分类 | P1，先做 | 公共 Responses 路径；不同服务未必返回该字段 | `plugins/llm-responses.js` 与宿主 retry 合约 |
| 压缩替换历史同时安装完整上下文 | P1 | 本地压缩也适用；远端压缩需服务端支持 | 已有 context/compaction 工作 |
| world-state 快照与有序差异更新 | P1，渐进做 | 核心状态设计可本地迁移 | 上下文组装、恢复、fork |
| 用户新输入抢占与继续运行 | P2 | `instant_interrupt` 默认关闭 | DSH 调度器与工具生命周期 |
| Code Mode 中的工具排序搜索 | P2，先验证需求 | `code_mode`、`code_mode_tool_search` 默认关闭 | 工具注册表和受限执行运行时 |
| Promise 完成顺序流式结果 | P2，依赖运行时 | Code Mode 内能力 | 批处理输出/后台任务观察 |
| 输出元数据大小预算和迟到结果归因 | P2 | 内部 wire 字段不能直接发给自定义 provider | 本地记录器、传输适配层 |
| Fresh 子代理继承动态工具 | P2，先补合约测试 | V2 + 默认关闭的独立开关 | 原生子代理 seam |

## 1. 重试：保留流内失败事件的服务端建议

新增修复：[`6ba4bf9e64`](https://github.com/openai/codex/commit/6ba4bf9e647cf8bc17eb9005af5ca9498bd7e654)、[`44dd77b71e`](https://github.com/openai/codex/commit/44dd77b71e88c78295736bffd3dc3b684c13be6d)。上游从 `response.failed.response.error.headers` 提取 Retry-After，对 overload/rate-limit 等传递建议；quota、policy、invalid prompt 等保持独立分类。共享重试器保留预算，切换 WebSocket → HTTP 也不能抢在服务端 deadline 之前发请求。[失败解析源码](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/codex-api/src/sse/responses_error.rs#L26-L103)、[共享重试源码](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/responses_retry.rs#L90-L146)。

本地已有 HTTP 非 2xx 的 Retry-After 处理，见 [llm-responses.js](../../plugins/llm-responses.js#L660-L676)。不足在流内失败路径：`failedFailure()` 返回的只有 message/code，事件中的 headers 未进入宿主失败对象；分类也未显式覆盖上游的 `server_is_overloaded`，见 [流内错误映射](../../plugins/llm-responses.js#L523-L554)。这不是“没有重试”，而是重试信息在适配边界丢失。

建议：先核对 DSH failure 的 `providerRetryAfterMs` 接口，再透传流内重试建议，补 quota/policy 终止优先级测试及 abort 测试；保持单一重试所有者。不要在 adapter 和宿主同时增加循环。当前本地是 HTTP SSE，因此无需为了对齐而新增 WebSocket fallback；未来增加时再迁移 deadline 约束。

## 2. 压缩：完整上下文与摘要一起成为持久 checkpoint

新增修复：[`8571b9eaa4`](https://github.com/openai/codex/commit/8571b9eaa46e42c8f75e0842ac6f2b02f550c9f7)。替换历史现在立即组装当前完整上下文，在最后真实用户消息或摘要前插入，保留摘要的尾部位置；同时写入匹配的 turn-context 与 world-state baseline，而不是等下一轮再补指令。[构造源码](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/compact.rs#L80-L110)、[checkpoint 写入](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/compact.rs#L394-L414)、[插入顺序](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/compact.rs#L615-L670)。

对本地最有价值的是这个一致性条件：**压缩成功后立即恢复或 fork，看到的模型指令、工具/技能目录、当前用户任务与状态基线应相互匹配**。它比只保留一段摘要更接近可恢复的 harness。现有 [compaction 插件](../../plugins/harness/codex-context-compaction.js#L1) 已防守跨 store 失败并保留用户任务，应沿着现有代码扩展，而非另起压缩器。

建议 P1 验收：压缩前改变技能/工具/开发者指令；压缩完成后不继续普通轮次而直接重启、恢复、fork；验证目录刷新、用户任务、摘要顺序及新模型 token 估算。远端压缩协议不是任意 OpenAI-compatible 服务的必备能力；本地完整 checkpoint 设计不依赖该后端。

## 3. world-state：快照和模型可见更新由同一个 transition 生成

新增演进：[`b44ca872b1`](https://github.com/openai/codex/commit/b44ca872b1059c65f0eb6a7534e9e8ae55df54a8)、[`08a7031b6a`](https://github.com/openai/codex/commit/08a7031b6acb4a8e00372be0e83e21cbab0db49d)、[`0df76892b1`](https://github.com/openai/codex/commit/0df76892b13277eca943a6507c7964e4b0f99a5b)。每个 section 用稳定 ID 和可序列化比较状态，返回 `(optional snapshot, ordered updates)`；没有新 snapshot 表示保留旧比较状态。更新支持 Fragment 或明确 ResponseItem，并有 Prefix/Standalone/Mergeable 放置策略。[更新类型](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/context/world_state/mod.rs#L63-L135)、[section 合约](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/context/world_state/mod.rs#L301-L353)、[恢复和渲染](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/context/world_state/mod.rs#L488-L536)。

可迁移的是状态机制：工具集、技能集、权限、cwd、模型等只在需要时说明变化，并能在丢失历史片段时重新注入。它不等于人为给每段历史加 XML 标签。DSH 的 Notes store 是跨窗口任务记忆，不自动等同于该结构化状态基线；当前 [context-state.js](../../plugins/context/context-state.js#L36-L83) 管的是 Note revision/window/fork 状态。

建议 P1 从“当前工具目录/权限/模型”三个 section 开始，先保证 snapshot 与消息同一 checkpoint、恢复后无重复注入、实际变化可见，再扩展技能等 section。保持 DSH 原生角色及事件协议，避免把 Codex ResponseItem 私有字段直接塞进 Chat Completions 请求。

## 4. Steering：新输入能唤醒模型，但运行中的任务有可继续观察的身份

新增：[`1bf73324ca`](https://github.com/openai/codex/commit/1bf73324cadc72a53ed467edc7d3fd2b145a6166)、[`f92655d07f`](https://github.com/openai/codex/commit/f92655d07f40c9999915cd9244291ad3acfc2dca)，随后被 [`12de0e395d`](https://github.com/openai/codex/commit/12de0e395d3313bc564190d983cb4f5acf0be713) 调整。新用户输入可让 Code Mode exec/wait 提早交回正在运行的 cell ID；早期模型流抢占方案重置连接，最新实现对可 interrupt 的流正常 drain 后复用连接/历史，其中 Responses Lite 才发送该 interrupt 信号。[目标版本处理](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/session/turn.rs#L2630-L2663)。

边界：`instant_interrupt` 是 UnderDevelopment 且默认 false。[开关源码](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/features/src/lib.rs#L1147-L1151)。不要把 Responses Lite 的服务端协作当成普通 SSE 的通用保证。

建议 P2：在 DSH 调度层明确区分“抢占观察等待”和“取消真实工具任务”，保留已完成工具结果、已展示消息及新输入顺序。先验收长命令中途补充用户约束、retry backoff 中新输入、压缩中输入排队，再考虑通信协议优化。仅改 prompt 要求模型频繁轮询，不能达到这项能力。

## 5. Code Mode：工具排序搜索与按当前 step 授权过滤

新增：[`4d15794336`](https://github.com/openai/codex/commit/4d15794336668d6098c0e36eb8e96cbbbfdb1d2d)。支持 `tools.tool_search({query, limit})`，搜索结果提供可调用名字和含类型声明的说明；最重要的实现细节是先按当前 step 的 nested-tool policy 过滤，再计入结果 limit，避免不可调用工具占满前几名。[搜索实现](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/tools/handlers/tool_search.rs#L282-L330)。

边界：`code_mode` 和 `code_mode_tool_search` 均 UnderDevelopment、默认 false；`code_mode_host` 默认 true 不代表前两者开启。[开关](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/features/src/lib.rs#L1111-L1133)。提交也明确需要模型支持 tool search，不能推定任意 DSH 模型可原样工作。

建议 P2：先测当前工具目录占用与选错工具率；目录很小则收益有限。若要做，先实现冻结到请求 step 的工具快照、权限一致的搜索、稳定 callable name、schema 大小预算和执行端重复鉴权，再引入脚本批量调用。不存在 JS 隔离、cell 生命周期和恢复协议时，不建议只添加一个能执行任意 JavaScript 的 `exec` 工具。

## 6. Code Mode 输出：按 Promise 完成顺序逐项交付

新增：[`28a264fbc7`](https://github.com/openai/codex/commit/28a264fbc766a59f2b550b8318f88e4a4b8dffe1)。`as_settled()` 每个输入只注册一次回调，结果按 settlement 顺序排队；消费者处理慢时不会丢结果。支持数组等 iterable 和 Map 键；`stream_settled()` 等待每次 emit，形成背压，并传播 callback 错误。[完整短实现](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/code-mode-runtime/src/runtime/settled.js#L1-L67)。

这是一项运行时内能力，不需额外私有后端，但以 Code Mode 运行时存在为前提。建议 P2 与第 5 项一起设计；只在当前 DSH 架构下借鉴的话，可以给并行子任务结果加“完成即通知 + index/status/value/reason”，不必为两个 helper 独立造 V8 host。验收消费者慢、结果拒绝、提前退出及终止后的状态释放。

## 7. 输出记录：大小预算与迟到元数据不能破坏调用归因

新增修复：[`dbb875d23c`](https://github.com/openai/codex/commit/dbb875d23cfd1a327cf6b51d7b50dad4b4601268)、[`63eb71c9da`](https://github.com/openai/codex/commit/63eb71c9da95a6e4deaf34ee9340c88a7cac9a65)。上游按序列化后的整个 outgoing message 计算 15 MiB 软预算，仅裁剪可选工具观察元数据的 wire copy，保留实际普通结果和 continuation 历史；即使普通内容自身仍超限，也不伪装已经修复。[预算源码](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/client_tool_metadata.rs#L1-L43)。

嵌套调用的参数被裁剪后，晚到的结果元数据仍通过校验过的绑定回填原始输出；若重复 ID 或冲突使归属模糊，应失效绑定，而非猜测。不能将被裁掉调用的 inventory 继续声称为 complete。[迟到结果绑定源码](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/tools/executed_tool_calls/request_metadata.rs#L104-L189)。

建议 P2：把“普通输出截断”“请求总字节预算”“审计元数据完整性”拆成不同合约。迁移本地 ledger 和大小计算即可，不要硬拷 15 MiB 为所有服务限制；该值是上游策略。上游对非 OpenAI provider 清理内部 passthrough 元数据，DSH 自定义 provider 也不应默认发送私有 observations 字段。[provider 边界](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/client.rs#L942-L952)。

## 8. 子代理：工具能力继承不必捆绑父历史继承

新增：[`e4e33a56b0`](https://github.com/openai/codex/commit/e4e33a56b073b5d9a550aaf513798480f88e4a38)。fresh V2 child 在明确开启 `multi_agent_v2_dynamic_tools` 时，从父 session 获得动态工具定义，创建子 session 时携带这些定义；无需 fork 父历史。[创建实现](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/agent/control/spawn.rs#L773-L805)。

边界：V2 本身默认 false；动态工具继承又有 UnderDevelopment、默认 false 的独立开关。[特性表](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/features/src/lib.rs#L1409-L1425)。这是可选能力，不能把 DSH 没有同名特性直接判成质量缺陷。

本地已经支持独立子代理 preset，且恢复时保留已选 preset，[现有桥接](../../plugins/typed-subagent-presets.js#L27-L44)。建议 P2 先写能力矩阵与合约测试：fresh/fork × 继承/独立 preset × 动态工具 × 恢复。默认继承父 preset 时应确认任务依赖工具确实可用；显式独立 preset 时应尊重其工具限制，不能为了“对齐”自动补回父工具。工具定义、工具实际路由和权限需要一起可用。

## 实施顺序与研究限制

先补第 1 项的适配层信息丢失；结合用户已有工作落实第 2、3 项 checkpoint 与恢复测试。随后验证 DSH 当前调度能力，再决定第 4 项是否需要宿主改动。第 5—7 项应作为一次 Code Mode 可行性工作设计，第 8 项先用矩阵验证现状。

这份研究以源码与提交差异为证据，没有执行 Codex 全量测试，也没有验证当前登录桌面应用的远端灰度开关。默认值只代表目标源码的静态 feature 表；网站、桌面宿主、实验模型或私有 backend 可以施加不同配置。报告中的建议不构成“当前开源 CLI 默认都有这些能力”的断言。
