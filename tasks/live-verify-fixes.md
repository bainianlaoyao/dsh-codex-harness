# Live 验证任务：dsh-codex-mode 工具面修复（2026-08-16）

> ⚠️ **历史任务，已不适用于当前契约**：本文档验证的旧实现对应当时挂载的
> Codex 审批闸 / `require_escalated` 升级窗口 / `prompt-align.js` 上下文注入
> （`<environment_context>`、`<current_time_reminder>`、`codex:sandbox-escalation`
> 提示段）。这些实现已随轻量改造删除——预设只替换工具面，agent loop 回归
> DSH 原生（审批/沙箱/压缩由宿主处理）；codex 形状的 `update_plan`/
> `request_user_input`/`spawn_agent` 工具也已改用 DSH 原生 `todo_write`/
> `ask_user_question`/`subagent`，见根目录 `README.md` 与
> `plugins/ACTIVATION.md`。本文件仅保留为当时线上失败与修复的记录。

针对三次线上失败（10:20 `exec_command` justification 回声、10:21 `spawn_agent`
全 stub items 回声、18:37 `spawn_agent` 空数组 `items:[]` 回声）以及自适应
升级窗口 / fork_context / echo-noise 布局的**人工走查任务**。在真实 dsh GUI
的 codex 会话中执行，逐条对照下面的 pass/fail 清单取证。

## 前置条件

1. dsh 服务已重启，或至少**新建** codex 会话（模块缓存键：
   `exec-command.js?v=7`、`multi-agent.js?v=4`、`prompt-align.js?v=2`、
   `echo-noise.js?v=2`；旧进程内模块仍是修复前的，必须新建会话）。
2. 会话工作目录：本目录下的 `ws/verify-repo`（tiny demo repo，见下）。
3. 会话审批/沙箱按当前 web profile 默认（full access + approval never →
   escalation 窗口 = INERT）即可；若想同时验证 LIVE 窗口，把会话切到
   workspace-write + ask 再跑一遍第 1-2 步观察点。

## 直接粘贴的提示词（第二轮：覆盖 18:37 items:[] 修复）

> 状态说明：第一轮验证（2026-08-16 18:36-18:38）已产出 `src/event-sourcing.ts`
>（事件信封/聚合版本/乐观并发/outbox 草图），并在 spawn 评审时复现了
> `items:[]` 回声失败（18:37，已修复，multi-agent ?v=4）。第二轮在工作区
> 现有内容之上重跑：`src/event-sourcing.ts` 已存在，任务改为**修订**它。
> 若想从零开始，先清掉 `src/event-sourcing.ts` 与 `REVIEW.md` 再粘贴。

```
在这个 workspace 里完成以下任务，不要向我提问，全程自主执行：

1. 先用 exec_command 侦察仓库结构（pwd、rg --files、必要时 cat 关键文件），
   然后对我说清楚：这是什么、表结构长什么样、事件流目前怎么做的、
   src/event-sourcing.ts 现在提供了什么。
2. 用 update_plan 建一个 4-6 步的计划并逐步推进（侦察 → 评审设计 → 修订 → 子代理评审 → 定稿）。
3. 用 apply_patch 修订 src/event-sourcing.ts（若缺失则新增）：补强最小事件溯源核心
   ——事件信封、聚合版本与乐观并发、outbox 草图、与现有 Drizzle 表的映射注释，
   保持 TypeScript 类型正确。不要改其他文件。
4. spawn 一个子代理：用 spawn_agent（message 方式）让它独立评审
   src/event-sourcing.ts 与现有仓库模式的兼容性，并把具体发现与建议
   （含是否需要修改）写入工作区根目录 REVIEW.md。
5. 用 wait_agent 等它结束，读回 REVIEW.md，然后按评审意见用 apply_patch 修订
   src/event-sourcing.ts 到定稿（除非评审明确说无需修改）。
6. 结束时汇报：每个工具的调用次数、子代理的 agent_id、最终文件清单。

规则：终端命令一律走 exec_command（不要用 bash 工具）；优先 rg 而非 grep。
```

## 预期观测点（全部命中才算 PASS）

| # | 观测点 | 判定方法 |
|---|--------|----------|
| 1 | 每次 `exec_command` 都返回真实输出（exit_code + Output），**零**参数校验失败 | 会话里无红色 Error 块；`pwd && rg --files ...` 等回声形态（`justification:""` + `use_default`）正常执行 |
| 2 | 会话审批为 never + full access 时，模型若带 `require_escalated`/`justification` 也不触发弹窗、不抛 `justification requires an explicit sandbox_permissions` | 全程无审批弹窗；提示词区出现 `codex:sandbox-escalation` INERT 说明 |
| 3 | `spawn_agent` 返回 `agent_id`，即使模型回声了全空 stub `items`（`[{audio_url:"",…}]`）**或空数组 `items:[]`** + 真实 message | 无 `Provide either message or items, but not both`；子代理实际产出 REVIEW.md |
| 4 | `fork_context:true` 时子代理有父会话历史（fork provider） | 子代理评审能引用父代理先前的侦察结论（如具体表名） |
| 5 | `wait_agent`/`send_input` 正常返回状态/投递确认 | 第 5 步完成，最终修订落地 |
| 6 | `apply_patch` 自由格式补丁成功（Responses wire），且修订是对既有文件的 Update 而非新增覆盖 | 修订内容正确；第 3 步的 Update hunk 成功应用 |

## 取证（跑完后）

```bash
# 会话日志解压后 grep 两个历史错误串，必须为 0 行：
zstd -d -f "<session>.jsonl.zstd" -o s.jsonl
rg -c "justification requires an explicit|Provide either message or items" s.jsonl   # 期望 0
# 全部 exec_command 调用都应非失败：
rg '"name":"exec_command"' s.jsonl | wc -l
```

## 反向用例（可选，验证 codex 错误串仍保留）

在会话里直接要求模型做非法输入不可控，因此反向由冒烟测试兜底
（`plugins/tools/exec-command.smoke.js`、`multi-agent.smoke.js` 断言：
live 窗口内非空 justification 无 require_escalated 仍拒绝、`items:[]` 仍报
`Items can't be empty`、真实 message+items 并存仍报 both）。LIVE 窗口的人工
验证：把会话切到 workspace-write + ask，让模型执行 `rm -rf <dir>`（危险命令）
应弹审批；审批后同 prefix 命令免弹窗。

## 工作区

`ws/verify-repo/`：12 行的 Drizzle schema + 一条事件录放逻辑 + 一个测试文件，
足以支撑侦察/设计/评审/修订闭环，且不依赖外部服务。