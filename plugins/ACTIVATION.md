# dsh-codex 激活手册

`dsh-codex-mode` 是一个轻量编码预设：**只把模型可见的工具面替换成 Codex 原生
工具**（`exec_command`/`write_stdin`/`apply_patch`/`view_image`）。**agent loop
完全使用 DSH 原生机制**——运行时上下文快照、审批、沙箱、压缩均由宿主处理；
计划（`todo_write`）、提问（`ask_user_question`）、子代理（`subagent`/
`subagent_fork`/`send_message`）也全部是 DSH 原生工具。预设不再注入任何
Codex 上下文片段（`<environment_context>`、`<current_time_reminder>` 等），
也不再挂载 Codex 审批策略层或 Codex 压缩器。

需求与当前契约：根目录 `README.md`、`agent-presets/codex/agent.cordis.yml`
与 `tests`（`npm test`）。历史对齐研究保留在 `docs/`。

## 0. 前置事实

- 模块冒烟 + 预设行解析校验全部通过（`npm test`）。
- 激活需要重启 dsh（profile 补丁层与预设发现在启动时生效）。`dsh plugin add`
  会挂上 `codex-preset-publisher`，启动时自动把 `codex` 与 `codex-creative`
  预设写进 `$DSH_HOME/.agent-presets/`。

## 1. 提供 OpenAI 凭据（二选一）

1. 环境变量：启动 dsh 前 `set OPENAI_API_KEY=sk-...`。
2. 网页 Models 设置页：为 `openai-official` / `openai-responses` 路由存储凭据（写入 DSH 凭据存储，重启后仍有效）。

## 2. 重启 dsh

```
dsh web
```

重启后验证：
- profile 组合树含 `llm-openai` 与 `llm-responses` 行：`dsh --profile web --dump-config | grep -E "llm-openai|llm-responses"`
- 预设被发现：网页新建会话的预设选择里出现 **codex 工具模式**（order 5）
  和 **codex 创造模式**（order 6）。
- 若预设报错：查看启动日志中 `codex` 预设的挂载错误；常见原因与对策见 §5。

## 3. 新建 codex 会话并配置模型路由

1. 新建会话，预设选 **codex 工具模式**（编码）或 **codex 创造模式**
   （编码 + 官方创造模式：动态插件、preset 创作、计划模式、工作流）。
2. 模型选择：provider 切到 **`openai-responses`**（推荐，codex 自身 wire，`apply_patch` 为真 freeform——裸 patch 文本 + lark 语法约束，无 JSON），模型选 `gpt-5.1-codex`（或 `gpt-5.5`/`gpt-5.1`/`gpt-5`/`gpt-4.1`），reasoning effort 默认 high。`openai-official`（chat-completions）仍可用，但该 wire 无 custom-tool 类型，`apply_patch` 退化为 JSON 函数调用。
3. 会话 cwd 选一个 git 仓库目录（AGENTS.md 发现以 `.git` 为根）。

## 4. 首跑测试用例（按序）

| # | 输入 | 期望 |
|---|------|------|
| 1 | `run: echo hello` | `exec_command` 卡片；输出 `Process exited with code 0` + `hello`；无审批弹窗（本 profile 默认审批策略 never） |
| 2 | `run: git status` | 同 #1（git 只读子命令） |
| 3 | `用 apply_patch 在仓库根加一个 hello.txt，内容是 "hi"` | `apply_patch` 卡片 `A hello.txt`；文件真实落盘；Responses 路由上模型输出的是**裸 patch 文本**（工具卡片 rawInput 无 JSON 花括号） |
| 4 | `rm -rf some_dir`（选一个可牺牲的目录） | 审批行为由 **DSH 原生审批**决定：本 profile 默认 danger-full-access + never → 直接执行不弹窗；把会话审批策略切到 ask → 弹 DSH 审批卡片，批准执行、拒绝则不执行 |
| 5 | `ls 一张 png 图并描述它`（仓库里有图时） | `view_image` 产出图片块，模型能描述内容（视觉通道） |
| 6 | `run: sleep 20 && echo done`（yield_time_ms 1000） | 返回 `Process running with session ID N`；随后 `write_stdin` 空轮询最终拿到 `Process exited with code 0` |
| 7 | `spawn 一个子代理让它数到三` | `subagent` 卡片 → 子代理 id；子代理运行结束收到通知；`list_agents` 可查状态、`send_message` 可续跑（`subagent_fork` 则继承本会话历史） |
| 8 | `todo_write 分三步完成 X` | todo 卡片渲染；`todo/write` 事件入会话日志 |
| 9 | 长对话压到接近上下文窗口 | **DSH 原生压缩**接管（宿主上下文管理与 `/compact`）；预设不加载任何 Codex 压缩器 |
| 10 | 在 **codex 创造模式** 会话里：`列出当前会话可见的 cordis 工具` | 模型看到 `cordis_inspect_*` / `cordis_define` / `cordis_run`；技能目录含 `editing-cordis-compositions` 与 `cordis-plugin-development` |

## 5. 故障排查

| 症状 | 原因 | 对策 |
|------|------|------|
| 预设列表里看不到 **codex 工具模式**，只剩 **codex 模式（replay 历史快照）** | ① 只装了旧版插件、没有 publisher 行；② `scanRoot` 跳过 junction | `dsh plugin add` 后重启；确认 `$DSH_HOME\.agent-presets\codex` 是真实目录且含 `.dsh-codex-mode-published` |
| `/compact` 不可用 / 长对话不压缩 | web 表面禁用 host 压缩行，旧 `replay-codex` 副本又没带 preset 内 compaction 组 | 日常会话选 **codex 工具模式**（真实目录副本含 compaction 组）；不要用 replay 快照编码 |
| 模型列表没有 `openai-official` / `openai-responses` | profile 补丁层未生效（未重启） | 重启 dsh；`--dump-config` 验证行存在 |
| 会话报 `no API key for provider route "..."` | 凭据未提供 | §1 |
| 预设挂载失败：`Cannot find package` 于 `dsh-codex-mode/plugins/...` | 源仓库里的包导出名还没被 publisher 改写成 `file:` URL | 重启 dsh 让 `codex-preset-publisher` 跑一次；live 副本的工具行应是 `file:///.../plugins/tools/*.js` |
| 无法切换到 **codex 创造模式**：`Host Cordis inspect provider "Service" is already registered` | 官方 `cordis` 预设已经把 Service/Event/Builtin/Tool inspect provider 注册进全局 `cordisInspect`；第二份 `tool-cordis` 再注册会撞车 | 确认 profile 补丁含 `share-cordis-inspect` 行后重启 dsh；该行把重复的 Host inspect provider 注册做成幂等 |
| exec_command 报 backend 不存在 | `dsh-terminal-bash` 未注册 `shell` 类型 | 预设 `exec-terminals` 组应含 pty+terminal-bash 两行；检查启动日志 |
| exec_command 报 NO_BACKEND / 挂起 | git bash 不可用 | 确认 PATH 有 `bash`（git bash）；本机 DSH 全局配置就是 git bash |
| exec_command 报 `unsupported shell "..."` | 模型传了 bash/shell/git-bash 以外的 shell 值 | 该部署只有 git bash；`/bin/sh`、`/bin/bash` 已作为别名接受，其余值需让模型用 bash/shell/git-bash |
| exec_command 报 `spawn bash ENOENT` | 模型把 `workdir` 传成了 POSIX/git-bash 路径（`/d/...`）或不存在目录——Windows 上无效 cwd 的 spawn 失败就是这个报错 | 已修复（exec-command.js?v=10）：`/d/...` 自动归一化为 `D:\...`、相对路径按会话 cwd 解析、目录不存在时返回明确错误（`workdir is not an existing directory: ...`）而不是裸 ENOENT；需重启/新建会话加载新模块 |
| 审批卡片永不出现 | 会话策略 never（本 profile 默认 danger-full-access+never） | DSH 语义下 never 不弹窗；要弹窗请把会话审批策略切到 ask |
| 长对话不触发压缩 | 未接近上下文窗口 | DSH 原生压缩按宿主阈值触发；超长会话可用 `/compact` 手动压缩 |
| apply_patch 报 `SetFileSecurityW EACCES (Win32 5): ...\\.*.tmpdir\\*.tmp` | 不是 patch 解析失败。`dsh-fs-local` 在 Windows 上先把原文件 DACL 拷到 staging 再 `ReplaceFileW`；ReFS（以及继承 ACL 只有 `Authenticated Users:(M)` 的 NTFS）没有 WRITE_DAC，拷贝直接被拒。`apply_patch` 把这次**写入**失败也包成 `verification failed` | 确认 profile 补丁含 `win32-atomic-write-fallback` 后**重启 dsh**。该行在 `ctx.fs.internals` 上吞掉 WRITE_DAC 拒绝并改用同卷 `rename`。NTFS 上仍走官方 `ReplaceFileW` |
| apply_patch 报 parent directory | 父目录为普通文件 | codex 同行为：父路径非目录才报错（目录缺失会自动创建） |
| 图片模型报不声明 image input | 所选模型 inputModalities 无 image | 换 gpt-5/gpt-4.1 系模型 |

## 6. 已知差异（运行时可见）

- **agent loop 为 DSH 原生**：无 Codex `<environment_context>` / `<current_time_reminder>` 注入，无 `codex:sandbox-escalation` 提示段；审批（含弹窗）、沙箱、上下文快照与压缩全部是宿主 DSH 行为。
- **计划/提问/子代理为 DSH 原生**：`todo_write`、`ask_user_question`、`subagent`/`subagent_fork` + `send_message`/`interrupt_agent`/`list_agents`（无 codex 形状的 `update_plan`/`request_user_input`/`spawn_agent`/`wait_agent`）。
- `apply_patch`：`openai-responses` 路由上为真 freeform（custom 工具 + lark 语法）；`openai-official`（chat-completions）路由上退化为 JSON 函数——codex 模式请用 Responses 路由。
- `web_search` 是 DSH 本地实现（query/sources），非 codex hosted schema。
- `login`/`tty`/`environment_id` 为 schema 兼容占位；`shell` 参数校验 bash/shell/git-bash（并接受 `/bin/sh`、`/bin/bash` 别名）并映射到配置的 git-bash 后端。
- `workdir` 为 Windows 语义：`/d/...`（git-bash 形式）自动归一化为 `D:\...`，相对路径按会话 cwd 解析；目录不存在时报明确错误。