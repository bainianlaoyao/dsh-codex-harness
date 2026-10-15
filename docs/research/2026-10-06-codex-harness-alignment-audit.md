# Codex 更新与 dsh-codex-mode harness 对齐检查

> 范围修订：用户随后明确重点是模型输入上下文和工具契约，保留 DSH 原生执行后端。本报告的广义 runtime 迁移顺序已由 [模型可见对齐复查](2026-10-06-model-facing-alignment.md) 取代，终端交互不再列为优先迁移项。新复查还验证了直接工具结果中的图片在 adapter 边界丢失；本文件“图片 attachment 通路已有实现”不应解读为端到端图片对齐已通过。

日期：2026-10-06（Asia/Shanghai）。目标：更新参考源码、找可迁移能力、识别会损害行为的差异；本次没有实施迁移。

## 基线与结论

- `../codex` 已由 `30fc6864cc1318121eca1843c217fe00ce1212f1`（2026-09-23）fast-forward 到 `d63a9b8344cfe58bc78bbe319b560378fc8756ef`（2026-10-06），增加 630 commits。HEAD 与本次 fetch 的 origin/main 一致，工作树干净。更新的是参考源码，不是桌面应用或全局 CLI 二进制。
- Windows Schannel 拉取失败后，本次命令单独指定 OpenSSL 成功；没有修改全局 Git 配置，也没有关闭 TLS 验证。
- 被检查对象是本地 `dsh-codex-mode` 0.3.5 **工作树**，包含既有未提交的 `plugins/context/*`、compactor、client 和 package.json 改动。未覆盖这些改动。并未核验当前已安装生产 profile 与工作树完全一致。
- 首要价值在于补齐 **模型协议中的状态保真、真实模型容量、真实终端交互**；再做上下文切窗、工具目录预算和运行中 steering。复制更多工具名字不能修复这些问题。
- 官方将 harness 定位为对话状态、执行流、工具交互、沙箱/审批和跨轮继续运行的整体。下面以固定源码为具体依据，不把产品宣传或私有后端能力当成默认可移植实现。[官方说明](https://developers.openai.com/blog/codex-as-a-platform)

优先级：P1 为建议优先修复的行为损失；P2 为后续增强或需宿主接口配合的能力。这里不是安全漏洞评级，也没有 benchmark 证明具体质量增益。

## 已确认的负面对齐差异

### 1. P1：Responses 推理状态与消息阶段在转换中丢失

`plugins/llm-responses.js:201–265` 只把 assistant 文本和 tool-call 序列化回输入；reasoning block 没有对应分支。`buildRequest:293–311` 使用 `store:false`，却不请求 `reasoning.encrypted_content`，也不发送历史 reasoning item。`translate:498–507` 遇到完成的 reasoning/message 只关闭文本 block，没有保存 opaque reasoning、原始 item ID 或 message phase。

原生使用带 `encrypted_content` 的 Reasoning item，以及可选的 `phase`（commentary/final_answer）；请求显式包含 `reasoning.encrypted_content`。[协议](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/protocol/src/models.rs#L1021-L1059)，[请求构建](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/client.rs#L961-L1008)。

损失：适配器不能保真回传工具调用前后的推理状态；进度消息与最终消息的阶段信息也消失。可见 reasoning summary 文本不能替代 opaque reasoning。此处不声称丢失 phase 必然提前结束任务，具体调度影响还取决于 DSH loop。

迁移：给 session/LLM seam 加 provider-owned opaque item 保留能力，覆盖流事件→持久化→下次请求→恢复/压缩全过程；按 provider/model 隔离，不能跨路由盲目回传。phase 应保留，无该字段的模型继续使用现有行为。不要只加一个 `include` 参数就声称完成。

验证：本次离线 mock 返回 encrypted reasoning 和 final_answer phase，adapter 输出均未保留；传入 reasoning 历史也未出现在下次 input。未消耗真实模型额度。

### 2. P1：模型能力被统一默认值替代，压缩预算可能失真

`plugins/llm-responses.js:623–635` 对任何未配置模型都返回 `contextWindow:400000`、默认输出 32000 和同一组 reasoning efforts；`:70` 的白名单只有 minimal/low/medium/high/xhigh，`:284–291` 对其它值本地拒绝。Chat Completions route 也使用类似的静态能力约束（`plugins/llm-openai.js:55–56,196–202`）。

原生将 context window、有效窗口比例、reasoning 与工具等能力交给模型元数据；当前协议还可表达 max/ultra/custom，但这**不代表每个公共 API 模型都支持它们**。[模型协议](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/protocol/src/openai_models.rs#L57-L88)，[窗口核算](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/session/context_window.rs#L75-L100)。

损失：实际较小的窗口会延迟压缩直至 overflow，较大的窗口又可能过早压缩；新模型支持的强度可能被本地阻断。新 Notes 代码声明“未知容量不切窗”，但 adapter 把未知值变成 400k，会削弱这个前提。

迁移：按 provider+model 维护可验证的能力；允许用户明确配置并标明来源。未知容量保持 unknown，避免假精确；reasoning 选项按具体路由能力生成，不是一律放行 ultra/max。保留适当输出/摘要余量，并使用实际请求路由的容量。

验证：离线探针对任意未配置 ID 得到 400000，ultra 在发请求之前被拒绝。

### 3. P1：tty/login 是空承诺，交互式终端无法闭环

`plugins/tools/exec-command.js:637,653` 宣告 tty/login；`:714` 调用 startShell 只传 command/cwd；`:884–893` 发给 shell 的请求仅有 command/workdir/dshEnv。`:819–826` 对一切非空且非 Ctrl-C 输入都返回“请以 tty=true 重跑”，并没有 tty 分支。

原生在 PTY 下真正写入 stdin，只有非 PTY 才拒绝普通输入。[原生分支](https://github.com/openai/codex/blob/d63a9b8344cfe58bc78bbe319b560378fc8756ef/codex-rs/core/src/unified_exec/process_manager.rs#L976-L1000)。

损失：REPL、交互安装器和需要输入的命令不能使用；模型遵照错误提示重跑仍会失败。login 参数无法控制 shell 启动行为。

迁移：接入 DSH 的真实 PTY/输入能力并传递启动选项；若宿主暂不支持，先删除无法兑现的参数承诺与错误重试建议。保留 Git Bash 作为已明确的部署选择本身不算坏差异。

### 4. P1：Notes/预算/新窗口目前是未接入且受阻的开发代码

两个 `agent-presets/*/agent.cordis.yml` 都仍挂原生 compaction-basic；`cordis.patch.yml` 没有 context-mode/tools/web 行。package.json 有导出和发布清单，不等于运行时已经启用。

`plugins/harness/codex-context-compaction.js:142` 附近明确禁用自动 Note reset，交给 Basic engine；手动路径要求 `agent.codexCapturedRoute`，否则走普通摘要。`plugins/context/context-tools.js` 没注册 `new_context`，但 context-mode 的提示/工具集合提到它。budgetFor 仅依据容量就返回 `noteResetAvailable:true`，没有验证这些执行前提。

损失：用户无法实际完成“写 Note→模型主动切窗→读 Note/旧历史”的闭环。即便直接挂载，预算工具的 available 标志也可能与执行能力不一致。**当前默认路径未挂载，所以这些 draft 问题不能描述为线上已发生故障。**

迁移：先拿到与下一次请求一致的冻结路由/容量接口，再接入唯一 compaction owner 与工具；做恢复、取消、切换模型、工具调用配对和旧会话测试。不能为追求可用而移除现有保守阻断。原生新增世界状态快照和完整 compaction replacement context 很值得复用其契约，详见配套上游报告。

另一个接入前需解决的问题：Note 上限 1,000,000 bytes，read_context_note 直接整份输出；history 每页最多 50×4000 字符，再套 JSON。持久化上限不应等于每次模型可见输出上限（`context-state.js:11,93`、`context-tools.js:8–17,55–80,88–101`）。应分页且按最终请求预算统一截断，避免回读本身挤爆新窗口。

### 5. P2：SSE 失败事件的重试建议丢失

HTTP 非 2xx 的 Retry-After 已处理，不能说“没有退避支持”。但 `response.failed` 只把 error 交给 `failedFailure`，后者仅返回 message/code（`plugins/llm-responses.js:522–527,546–554`）。上游此次明确补齐 failed-event 服务端重试建议、跨 retry/fallback 的截止时间，适合先迁移这个窄修复。

迁移与验收：把服务端建议保留为宿主能理解的 retry metadata，区分可重试/配额/无效请求；mock 429、SSE overload、取消与 fallback，确保没有忽略等待建议或重复执行已完成工具。还需区分当前 adapter 的 server_overloaded 和上游 server_is_overloaded 错误码。上游证据见配套报告第 1 项。

### 6. P2：等待后台作业依靠 persona，调度器状态没有对应保障

预设 persona 要求不要结束 turn 去等工作，README 也记录了等待消耗 goal 轮数的问题。当前安装的 `@deepseek-ai/dsh-goal-round-driver/lib/index.js` 的 readyToDrive 仍用 agent idle 和 competingQueued 等条件，没有查询 pending jobs。

这属于 DSH 宿主调度问题，**不是把原生 Codex 某个函数拷进插件即可修复，也不是本次对真实会话重新复现的结果**。改善方向是明确 waiting-for-work 状态，让作业完成事件唤醒；仅约束 prompt 无法保证模型不消耗空转轮次。相关既有调查：`docs/upstream/2026-09-21-goal-round-driver-pending-jobs.md`。

## 值得迁移的能力与顺序

| 顺序 | 内容 | 落点 | 完成判据 |
|---|---|---|---|
| 1 | Responses opaque reasoning、phase、模型能力保真 | adapter + DSH LLM/session seam | 跨工具调用/恢复后 wire round-trip；未知容量明确；能力按路由验证 |
| 2 | 真实 tty/stdin/login；SSE retry metadata | terminal adapter / LLM adapter | 交互进程收得到输入；取消正常；服务端 retry delay 被尊重 |
| 3 | 世界状态快照、切窗后完整上下文；完成现有 Notes 工程 | DSH request/compaction/session + 本插件 | 模型切换后同一步容量一致，任务/权限/技能/工具不丢，重启可恢复 |
| 4 | 全局工具输出预算、按需发现/排序、稳定工具目录前缀 | tool registry + context assembler | 大目录/大结果不挤爆请求，截断保留 call ID/状态等元数据 |
| 5 | 运行中用户 steering、子代理动态工具继承 | DSH loop/controller | 新输入不丢/不重复，安全边界可中断，子代理拿到正确作用域工具 |
| 6 | Code Mode（程序化工具编排） | 新执行运行时 + 安全边界 | exec/wait/yield/cancel/session 生命周期与工具权限一致 |

新增能力、commit 与固定源码链接见 [上游迁移候选报告](2026-10-06-codex-upstream-features.md)。Code Mode、ranked discovery、instant_interrupt、V2 dynamic tools 在当前上游并非全部默认开启；应先小范围试验。先做普通工具目录/输出预算，并不要求先完成整套 Code Mode。

更大的替代路线是让 DSH 作为 Codex app-server 客户端，由原生拥有 loop/context/approvals，DSH 提供产品界面与业务工具。这样能减少追赶行为差异，但会改变当前“DSH 拥有 harness”的架构和 provider 兼容性，不是本插件的小版本迁移。建议当前先完成上表 1–3，除非产品明确要转向完整原生 runtime。

## 不应当认定为坏差异的部分

- DSH-native todo/ask-user/subagent/skill/goal 的名称或配置格式不同，本身不是能力损失；需要比较行为、持久化与权限边界。当前已有 typed child preset 恢复，不应重新造一套无宿主生命周期支持的假子代理。
- DSH 负责 sandbox/approval 是既定架构；不能根据插件没有 `sandbox_permissions` 参数就推断“命令无沙箱”。本次未做宿主权限系统审计。
- apply_patch freeform、输出截断、长命令会话和图片 attachment 通路已有实现；不是所有功能都停留在工具外观层。
- 原生 provider 专属 compact/Notes 服务、Responses Lite 和私有元数据不能作为所有第三方兼容端点的默认要求。要 capability-gate，给出明确降级。
- 普通摘要与 Notes reset 是不同策略；不是把压缩触发比例从 80% 改到另一个数字就完成原生对齐。

## 验证结果与限制

- 源码更新：fast-forward 成功，HEAD=origin/main，codex 工作树干净；未编译 Rust/未更新桌面二进制。
- npm test：预设行、context state/history、authenticated routes、context compaction、publisher、发布布局、scanRoot、exec/apply_patch/view_image/restrict/share-cordis 已通过，之后在 `win32-atomic-write-fallback.smoke.js:149` 的硬编码 `E:\texus\src\poker_parser` 写探针因工作区权限失败。首次 npm cache 权限问题已通过把缓存置于 `.tmp` 解决；未扩大文件系统权限。
- 单独执行后续 wire/format 用例：llm-openai、llm-responses、exec-command alignment（7 cases）、apply-patch alignment（29 cases）全部通过。
- test:agents：在启动时失败：当前 `@deepseek-ai/dsh-settings` 不导出测试引用的 SettingsProvider。此结果只能证明当前依赖/测试契约不兼容，不能据此断言生产子代理一定坏了。尚未跑到该组后续测试。
- 新增离线探针位于工作区 `.tmp/codex-mode-wire-audit.mjs`，确认 reasoning/phase 丢失、未知容量 400k 和 ultra 本地拒绝。它用于本次诊断，不是完成修复后的回归测试。
- 没有真实 API 质量/成本 benchmark，没有 GUI/真实 PTY/生产会话验收；未改业务实现、未发布包。已有格式测试通过不等于 harness 语义已经对齐。
