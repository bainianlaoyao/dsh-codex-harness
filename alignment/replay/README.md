# dsh-codex-mode — 轨迹重放对照（part 3）

10 条 **mock 轨迹**（只 mock 模型输出，真实执行工具）在两条 harness 上各重放一次，比较两条上下文的差异：

- **官方 harness**：codex exec --json（专用 CODEX_HOME + mock model_providers，审批 never、沙箱 danger-full-access、apply_patch_freeform/unified_exec/plan_tool/view_image_tool 特性开启；win32 默认 shell 为 pwsh）
- **自实现 harness**：DSH headless-codex 预设（$DSH_HOME/profiles/headless-codex，llm-responses 路由指向同一 mock，codex 预设 + replay-runner 挂载）

## 结构

```
mock-server.mjs       # Responses-API mock：按脚本步骤应答，$SESSION_ID 占位符替换
trajectories.mjs      # 10 条轨迹定义（步骤 = 文本 + 工具调用；最后一步必须是纯文本）
run-codex.mjs         # 官方 codex CLI 重放 + 上下文抽取（请求日志 + 事件流）
run-dsh.mjs           # DSH 重放（安装 profile、同步 replay-codex 预设、spawn dsh）
compare-contexts.mjs  # 规范化（CRLF/墙钟/Chunk ID/会话 id/时间戳/token 数）+ LCS 差异
replay-all.mjs        # 编排：逐轨迹 起 mock → codex → 重启 mock → dsh → 比较
profile/              # headless-codex profile（package.json + cordis.patch.yml）
out/report.md         # 结果报告（表格 + 逐条差异）
```

## 运行

```bash
node replay-all.mjs              # 全部 10 条
node replay-all.mjs --only T4-apply-patch-add-update   # 单条
```

前置：scripts/install.ps1 已建 junction；codex CLI 在 PATH（或 CODEX_BIN）；本机为 win32 + git bash。每条轨迹约 1 分钟（codex/DSH 各一次完整启动 + T7 的 10 秒 yield）。

## 上下文规范化与分类

- 行类型：user / assistant / tool-call（name+arguments）/ tool-result（output）
- 归一化：CRLF→LF、Wall time → <wall>、Chunk ID → <chunk>、session ID → <sid>、时间戳 → <ts>、Original token count → <tokens>
- apply_patch 工具调用参数解包（DSH 内部 {"patch": ...} → 裸 patch 文本）
- DSH 工具错误前缀 "Error: " 剥离
- harness 注入消息（codex 的 <environment_context> user 消息；DSH 的运行时上下文快照与 skills reminder）从严格 diff 中排除，单独计数

## 已知差异类别（报告中的 diff 成因）

1. **shell 环境**（用户范围外）：pwsh CRLF vs git bash LF → 截断边界与 token 数不同
2. **shell 错误输出格式**：pwsh cmdlet 错误（Get-Content: ...）vs bash stderr
3. **OS 错误本地化**：Rust io::Error 用系统语言（中文 Windows 报"系统找不到指定的文件"）
4. **harness 约定**：DSH 工具错误带 Error: 前缀；apply_patch 内部 JSON 传输