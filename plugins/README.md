# 插件模块

Codex 形状工具只保留 `exec_command`/`write_stdin`/`apply_patch`/`view_image`；
计划、提问与子代理全部走 DSH 原生工具（`todo_write`/`ask_user_question`/
`subagent` 系列），无需本目录模块。

| 模块 | 用途 |
| --- | --- |
| `llm-openai.js` | OpenAI Chat Completions 路由 |
| `llm-responses.js` | OpenAI Responses API 路由与 `apply_patch` custom tool 支持 |
| `tools/exec-command.js` | Codex 风格命令执行和轮询，运行在 DSH shell seam 上 |
| `tools/apply-patch.js` | 自由格式补丁编辑 |
| `tools/view-image.js` | 本地图片查看 |
| `tools/restrict.js` | 隐藏与 `exec_command` 重复的宿主 shell 工具 |
| `win32-atomic-write-fallback.js` | Windows 上 `SetFileSecurityW`/`ReplaceFileW` 无 WRITE_DAC（ReFS 常见）时回退到 `rename`，避免 apply_patch 假验证失败 |

不再包含 Codex 审批策略、沙箱升级、环境上下文注入、Codex 专用压缩器，以及
codex 形状的计划/提问/多代理工具。相关职责由宿主 DSH 处理。
