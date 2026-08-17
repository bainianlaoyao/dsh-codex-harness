# Live 验证任务：dsh-codex-mode 工具面修复（2026-08-16）

针对两次线上失败（10:20 `exec_command` justification 回声、10:21 `spawn_agent`
message/items 回声）以及自适应升级窗口 / fork_context / echo-noise 布局的
**人工走查任务**。在真实 dsh GUI 的 codex 会话中执行，逐条对照下面的
pass/fail 清单取证。

## 前置条件

1. dsh 服务已重启，或至少**新建** codex 会话（模块缓存键：
   `exec-command.js?v=7`、`multi-agent.js?v=3`、`prompt-align.js?v=2`、
   `echo-noise.js?v=2`；旧进程内模块仍是修复前的，必须新建会话）。
2. 会话工作目录：本目录下的 `ws/verify-repo`（tiny demo repo，见下）。
3. 会话审批/沙箱按当前 web profile 默认（full access + approval never →
   escalation 窗口 = INERT）即可；若想同时验证 LIVE 窗口，把会话切到
   workspace-write + ask 再跑一遍第 1-2 步观察点。

## 直接粘贴的提示词

```
在这个 workspace 里完成以下任务，不要向我提问，全程自主执行：

1. 先用 exec_command 侦察仓库结构（pwd、rg --files、必要时 cat 关键文件），
   然后对我说清楚：这是什么、表结构长什么样、事件流目前怎么做的。
2. 用 update_plan 建一个 4-6 步的计划并逐步推进（侦察 → 设计 → 落地 → 评审 → 定稿）。
3. 用 apply_patch 新增 src/event-sourcing.ts：设计一个最小事件溯源核心
   （事件信封、聚合版本、outbox 草图），并给出与现有 Drizzle 表的映射注释。
   不要改其他文件。
4. spawn 一个子代理：用 spawn_agent（message 方式）让它独立评审
   src/event-sourcing.ts 与现有模式的兼容性，并把意见写到 REVIEW.md。
5. 用 wait_agent 等它结束，读回 REVIEW.md，然后按评审意见用 apply_patch 修订
   src/event-sourcing.ts 到定稿。
6. 结束时汇报：每个工具的调用次数、子代理的 agent_id、最终文件清单。

规则：终端命令一律走 exec_command（不要用 bash 工具）；优先 rg 而非 grep。
```

## 预期观测点（全部命中才算 PASS）

| # | 观测点 | 判定方法 |
|---|--------|----------|
| 1 | 每次 `exec_command` 都返回真实输出（exit_code + Output），**零**参数校验失败 | 会话里无红色 Error 块；`pwd && rg --files ...` 等回声形态（`justification:""` + `use_default`）正常执行 |
| 2 | 会话审批为 never + full access 时，模型若带 `require_escalated`/`justification` 也不触发弹窗、不抛 `justification requires an explicit sandbox_permissions` | 全程无审批弹窗；提示词区出现 `codex:sandbox-escalation` INERT 说明 |
| 3 | `spawn_agent` 返回 `agent_id`，即使模型回声了全空 stub `items`（`[{audio_url:"",…}]`）+ 真实 message | 无 `Provide either message or items, but not both`；子代理实际产出 REVIEW.md |
| 4 | `fork_context:true` 时子代理有父会话历史（fork provider） | 子代理评审能引用父代理先前的侦察结论（如具体表名） |
| 5 | `wait_agent`/`send_input` 正常返回状态/投递确认 | 第 5 步完成，最终修订落地 |
| 6 | `apply_patch` 自由格式补丁成功（Responses wire） | 新增/修订文件内容正确 |

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