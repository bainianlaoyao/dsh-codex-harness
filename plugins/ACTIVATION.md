# dsh-codex 激活手册

需求与验收：`D:\Data\DEV\dsh\codex-mode-requirements.md`（含附录 B 静态对齐对照表）。
模块清单与冒烟：同目录 `README.md`。

## 0. 前置事实

- 全部代码已就绪并经 13 项冒烟 + 预设行解析校验（ALL PASS）。
- 未完成项（不影响激活）：`tool_search` 延迟加载体系未复刻（模型元数据不可得，已知差异）。
- 激活需要重启 dsh（profile 补丁层与预设发现在启动时生效）。

## 1. 提供 OpenAI 凭据（二选一）

1. 环境变量：启动 dsh 前 `set OPENAI_API_KEY=sk-...`。
2. 网页 Models 设置页：为 `openai-official` / `openai-responses` 路由存储凭据（写入 DSH 凭据存储，重启后仍有效）。

## 2. 重启 dsh

```
dsh web
```

重启后验证：
- profile 组合树含 `llm-openai` 与 `llm-responses` 行：`dsh --profile web --dump-config | grep -E "llm-openai|llm-responses"`
- 预设被发现：网页新建会话的预设选择里出现 **codex 模式**（order 5）。
- 若预设报错：查看启动日志中 `codex` 预设的挂载错误；常见原因与对策见 §5。

## 3. 新建 codex 会话并配置模型路由

1. 新建会话，预设选 **codex 模式**。
2. 模型选择：provider 切到 **`openai-responses`**（推荐，codex 自身 wire，`apply_patch` 为真 freeform——裸 patch 文本 + lark 语法约束，无 JSON），模型选 `gpt-5.1-codex`（或 `gpt-5.5`/`gpt-5.1`/`gpt-5`/`gpt-4.1`），reasoning effort 默认 high。`openai-official`（chat-completions）仍可用，但该 wire 无 custom-tool 类型，`apply_patch` 退化为 JSON 函数调用。
3. 会话 cwd 选一个 git 仓库目录（AGENTS.md 发现以 `.git` 为根）。

## 4. 首跑测试用例（按序）

| # | 输入 | 期望 |
|---|------|------|
| 1 | `run: echo hello` | `exec_command` 卡片；输出 `Process exited with code 0` + `hello`；无审批弹窗（echo 在安全白名单） |
| 2 | `run: git status` | 同 #1（git 只读子命令免批） |
| 3 | `用 apply_patch 在仓库根加一个 hello.txt，内容是 "hi"` | `apply_patch` 卡片 `A hello.txt`；文件真实落盘；无弹窗；Responses 路由上模型输出的是**裸 patch 文本**（工具卡片 rawInput 无 JSON 花括号） |
| 4 | `rm -rf some_dir`（选一个可牺牲的目录） | **审批卡片**（危险命令）：批准后执行；拒绝则 `command rejected by the user` |
| 5 | `ls 一张 png 图并描述它`（仓库里有图时） | `view_image` 产出图片块，模型能描述内容（视觉通道） |
| 6 | `run: sleep 20 && echo done`（yield_time_ms 1000） | 返回 `Process running with session ID N`；随后 `write_stdin` 空轮询最终拿到 `Process exited with code 0` |
| 7 | `spawn 一个子代理让它数到三` | `spawn_agent` → agent_id；`wait_agent` 返回 idle |
| 8 | `update_plan 分三步完成 X` | plan 卡片渲染；`plan/write` 事件入会话日志 |
| 9 | 长对话压到接近上下文窗口 | codex 压缩引擎触发（90% 阈值 + SUMMARIZATION_PROMPT 摘要） |

## 5. 故障排查

| 症状 | 原因 | 对策 |
|------|------|------|
| 模型列表没有 `openai-official` / `openai-responses` | profile 补丁层未生效（未重启） | 重启 dsh；`--dump-config` 验证行存在 |
| 会话报 `no API key for provider route "..."` | 凭据未提供 | §1 |
| 预设挂载失败：`Cannot find package` 于 `../../profiles/...` | 路径基准变化 | 行内路径以预设目录为基准（`new URL(name, baseUrl)`）；确认 `C:\Users\30280\.dsh\profiles\web\dsh-codex\tools\` 下文件存在 |
| exec_command 报 backend 不存在 | `dsh-terminal-bash` 未注册 `shell` 类型 | 预设 `exec-terminals` 组应含 pty+terminal-bash 两行；检查启动日志 |
| exec_command 报 NO_BACKEND / 挂起 | git bash 不可用 | 确认 PATH 有 `bash`（git bash）；本机 DSH 全局配置就是 git bash |
| exec_command 报 `unsupported shell "..."` | 模型传了 bash/shell/git-bash 以外的 shell 值 | 该部署只有 git bash；让模型用这三个取值之一 |
| 审批卡片永不出现 | 会话策略 never（本 profile 默认 danger-full-access+never） | codex 语义下 never=危险命令直接 Forbidden 不弹窗；要弹窗请把会话审批策略切到 ask |
| apply_patch 报 parent directory | 父目录为普通文件 | codex 同行为：父路径非目录才报错（目录缺失会自动创建） |
| 图片模型报不声明 image input | 所选模型 inputModalities 无 image | 换 gpt-5/gpt-4.1 系模型 |

## 6. 已知差异（运行时可见）

- `apply_patch`：`openai-responses` 路由上为真 freeform（custom 工具 + lark 语法）；`openai-official`（chat-completions）路由上退化为 JSON 函数——codex 模式请用 Responses 路由。
- `web_search` 是 DSH 本地实现（query/sources），非 codex hosted schema。
- 子代理工具名为扁平 `spawn_agent` 等（DSH 无命名空间）；`resume_agent` 为续跑近似。
- `login`/`tty`/`environment_id` 为 schema 兼容占位；`shell` 参数校验 bash/shell/git-bash 并映射到配置的 git-bash 后端。
