# dsh-codex

DSH 的 codex 对齐模式实现（规范源：`D:\Data\DEV\dsh\codex` openai/codex HEAD `5bc8da6d78`，需求文档：`D:\Data\DEV\dsh\codex-mode-requirements.md`）。

## 模块

| 文件 | 作用 | 平面 | 状态 |
|------|------|------|------|
| `llm-openai.js` | OpenAI 适配器：`openai-official` route，chat-completions + SSE 流，reasoning effort 映射，GPT 模型目录；**视觉通道**（ImageBlock → `image_url` 内容部件，经附件存储取字节装配 data URL） | host（profile 补丁层 `llm-openai` 行） | ✅ M0+M3 冒烟 PASS |
| `llm-responses.js` | OpenAI **Responses API** 适配器：`openai-responses` route（codex 自身 wire）。`apply_patch` 声明为 `custom` freeform 工具（codex 逐字描述 + lark 语法，模型输出裸 patch 文本、无 JSON）；历史按 `custom_tool_call(_output)`/`function_call(_output)` 条目回传；SSE 事件 → StreamChunk 全映射（output_text.delta、custom_tool_call_input.delta、output_item.done、completed/failed/incomplete） | host（profile 补丁层 `llm-responses` 行） | ✅ 冒烟 PASS |
| `tools/exec-command.js` | `exec_command` + `write_stdin`：git bash PTY 会话（D1），yield→session_id，退出码标记，64 会话上限；**内置 codex 审批闸**（exec-policy 分类 → DSH 审批缝；会话级 never 覆盖；`require_escalated` 升级路径；unrestricted 沙箱按 codex Skip）。`backendType` 可单独配置所用外壳（默认 `shell` = git bash）；模型侧 `shell` 参数校验（bash/shell/git-bash） | agent（codex preset 行） | ✅ M1+M2 冒烟 PASS |
| `tools/apply-patch.js` | `apply_patch`：codex patch 语法（Add/Update/Delete/Move，@@-hunk 查找）；描述为 codex **逐字**字符串；Responses 路由上为真 freeform（见 llm-responses.js） | agent | ✅ M1 冒烟 PASS |
| `tools/update-plan.js` | `update_plan`：plan 状态 + 会话投影 | agent | ✅ M1 冒烟 PASS |
| `tools/view-image.js` | `view_image`：魔数校验 + data URL；**M3 视觉通道**：经附件存储保存并产出真实图片块（render=[text, image block]），wire 侧由 llm-openai/llm-responses 装配 | agent | ✅ M1+M3 冒烟 PASS |
| `tools/request-user-input.js` | `request_user_input`：1-3 问，走 DSH 提问缝 | agent | ✅ M1 冒烟 PASS |
| `tools/multi-agent.js` | codex Collab V1：`spawn_agent`/`send_input`/`resume_agent`/`wait_agent`/`close_agent` 映射 DSH subagent 缝 | agent | ✅ 冒烟 PASS |
| `tools/restrict.js` | 工具面限制：隐藏 host 全局 `bash`（否则与 exec_command 并存且绕过 codex 审批闸） | agent | ✅ 冒烟 PASS |
| `tools/prompt-align.js` | 提示面对齐（2026-08-15）：scoped 空文本 shadow 移除 DSH 平台段落泄漏（`app:web-surface`/`tool:bash`/`tool:web_search`/`tool:web_fetch`/`ui:deliverable-file-references`）；新增 codex world-state 片段 `<environment_context>`（legacy-single 形状）与 `<current_time_reminder>`（逐字标记），经 runtime-context 快照 diff 注入 | agent（codex preset 行） | ✅ 冒烟 PASS |
| `policy/exec-policy.js` | 审批策略纯逻辑：安全/危险名单、git 规则、Windows 形式、命令规范化、四策略分类 | 库（M2 循环使用） | ✅ 冒烟 PASS |
| `harness/compact.js` | codex 压缩策略：90% 触发、20K token 用户消息保留、摘要组装 | 库（M2 循环使用） | ✅ 冒烟 PASS |
| `harness/approvals.js` | 审批编排：决策词汇、动态决策集、会话缓存、沙箱拒绝升级矩阵 | 库（M2 循环使用） | ✅ 冒烟 PASS |
| `harness/codex-compactor.js` | codex 压缩引擎（`ctx.compaction`）：90% 触发、20K 用户消息保留、SUMMARIZATION_PROMPT 摘要、compaction/* 事件协议 | agent（codex preset compaction 组） | ✅ 冒烟 PASS |

预设本体：`C:\Users\30280\.dsh\.agent-presets\codex\`（`preset.yml` + `agent.cordis.yml` + `BASE_INSTRUCTIONS.md` 系统提示源稿 + `check-rows.mjs` 行解析校验）。

## 冒烟测试

在 `C:\Users\30280\.dsh\profiles\web` 下：

```bash
node dsh-codex/llm-openai.smoke.js
node dsh-codex/llm-responses.smoke.js
node dsh-codex/tools/exec-command.smoke.js
node dsh-codex/tools/apply-patch.smoke.js
node dsh-codex/tools/update-plan.smoke.js
node dsh-codex/tools/view-image.smoke.js
node dsh-codex/tools/request-user-input.smoke.js
node dsh-codex/tools/multi-agent.smoke.js
node dsh-codex/tools/restrict.smoke.js
node dsh-codex/tools/prompt-align.smoke.js
node dsh-codex/policy/exec-policy.smoke.js
node dsh-codex/harness/compact.smoke.js
node dsh-codex/harness/approvals.smoke.js
node dsh-codex/harness/codex-compactor.smoke.js
```

预设行解析校验：在 `C:\Users\30280\.dsh\.agent-presets\codex` 下 `node check-rows.mjs`。

## 与 codex 官方 HEAD 的对照测试（2026-08-15 新增）

fixture 提取自官方 HEAD 测试（每 case 标注来源测试函数），在 `C:\Users\30280\.dsh\profiles\web` 下：

```bash
node dsh-codex/alignment/exec-policy.alignment.smoke.js    # 172 safe + 44 dangerous 决策对 × linux/win32
node dsh-codex/alignment/exec-command.alignment.smoke.js   # exec_command 结果文本字节形状（6 用例）
node dsh-codex/alignment/apply-patch.alignment.smoke.js    # patch → 文件效果/输出/失败消息（9 用例）
node dsh-codex/alignment/tool-schema.alignment.smoke.js    # exec_command/write_stdin schema 结构（2 工具）
```

fixture：`dsh-codex/alignment/fixtures/*.json`。codex 上游升级后重新提取 fixture 即可回归；首跑修复记录见 `codex-mode-requirements.md` §B.4。

## 激活（需要重启 dsh）

1. **提供 OpenAI key**：环境变量 `OPENAI_API_KEY`，或在网页 Models 页为 `openai-official` / `openai-responses` 路由存凭据。
2. **重启 dsh**（profile 补丁层与预设发现都在启动时生效）。
3. 新建会话时选择 **codex 模式**；在模型选择里把 provider 切到 **`openai-responses`**（如 `gpt-5.1-codex`）——这是 codex 自身 wire，`apply_patch` 为真 freeform（裸 patch 文本 + lark 语法约束）。`openai-official`（chat-completions）仍可用，但该 wire 无 custom-tool 类型，`apply_patch` 退化为 JSON 函数调用。
4. 首次使用建议沙箱/审批组合：本机 git bash 需要 `danger-full-access`（profile 注释所述 cygwin 运行时限制）；M2 的 codex 策略层会在此基础上做命令级审批。

## 已知差异（M1+M2+M3 口径）

- `apply_patch`：`openai-responses` 路由上为**真 freeform**（custom 工具 + lark 语法，codex 逐字描述）；`openai-official`（chat-completions）路由上仍是 JSON-function（该 wire 无 custom-tool 类型）——**codex 模式请用 Responses 路由**。
- hosted `web_search` 由 DSH 本地 `web_search` 替代（schema 不同）。
- `exec_command` 的 `login`/`tty` 参数为 schema 兼容占位；`shell` 参数校验 bash/shell/git-bash 三个取值并映射到配置的 git-bash 后端（`backendType` 可单独配置）。
- `tool_search` 延迟加载体系未复刻（DSH 模型路由无 `supports_search_tool` 元数据；MCP 工具在 DSH 为直接注册，模型可见性不受影响）。
- 子代理工具为扁平命名（DSH 无命名空间）；`resume_agent` 为续跑近似。
