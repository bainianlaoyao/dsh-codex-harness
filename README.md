# dsh-codex-mode

Codex 对齐模式(agent preset + 模型路由 + 工具面 + 审批/沙箱策略层)for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

规范源:`openai/codex` 本地 checkout HEAD `5bc8da6d78`(只读参考,不在本仓库)。完整需求与验收证据:`docs/codex-mode-requirements.md`。

## 仓库结构

```
├── package.json            # dsh.bundle manifest(marketplace 分发入口)
├── cordis.patch.yml        # bundle patch:注册 OpenAI 模型路由(host 平面)
├── plugins/                # 实现(原 profiles/web/dsh-codex)
│   ├── llm-openai.js       #   openai-official 路由(chat-completions)
│   ├── llm-responses.js    #   openai-responses 路由(Responses API,codex 自身 wire)
│   ├── tools/              #   exec_command/write_stdin/apply_patch/update_plan/
│   │                       #   view_image/request_user_input/multi_agent/restrict/prompt-align
│   ├── policy/             #   exec-policy(命令分类/审批策略)
│   ├── harness/            #   compact/approvals/codex-compactor
│   └── alignment/          #   与 codex 官方 HEAD 的对照测试(fixtures/ 提取自官方测试)
├── agent-presets/codex/    # codex agent 预设(preset.yml + agent.cordis.yml +
│                           #   BASE_INSTRUCTIONS.md + check-rows.mjs)
├── docs/
│   ├── codex-mode-requirements.md
│   └── research/           # 调研文档(is_safe_command 决策矩阵、上下文组装、审批沙箱证据链)
└── scripts/install.ps1     # 本地部署:junction 挂载(不复制代码)
```

## 安装(本地)

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

创建三个 junction:`$DSH_HOME\plugins → 仓库\plugins`、`$DSH_HOME\.agent-presets\codex → 仓库\agent-presets\codex`、`仓库\plugins\node_modules → $DSH_HOME\profiles\node_modules`(开发依赖)。预设行引用 `../../plugins/...`,经 junction 对解析到 `$DSH_HOME\plugins`。模型路由两行(`llm-openai`/`llm-responses`)从 profile 补丁层安装 bundle 或保留手工行。重启 dsh 后新建会话选择 **codex** 预设。

卸载:`scripts/install.ps1 -Uninstall`。

## 测试

```bash
node agent-presets/codex/check-rows.mjs        # 预设行契约(从预设目录)
cd plugins
node tools/*.smoke.js                          # 工具冒烟(全部)
node policy/exec-policy.smoke.js               # 审批策略冒烟
node harness/*.smoke.js                        # 压缩/审批编排冒烟
node llm-openai.smoke.js && node llm-responses.smoke.js
node alignment/*.alignment.smoke.js            # 与 codex 官方 HEAD 的对照(见下)
```

对照测试 fixture 提取自官方 HEAD(`is_safe_command.rs`/`is_dangerous_command.rs`/`apply_patch_cli.rs`/`context.rs`/`shell_spec.rs`),每 case 标注来源;官方升级后重新提取 fixture 即可回归。首跑发现并修复的不一致记录在 `docs/codex-mode-requirements.md` §B.4。

## Marketplace 收录(进行中)

- **形态**:npm 组合包(`dsh.bundle` manifest → `cordis.patch.yml`),GitHub 仓库分发,`dsh plugin --profile web add github:<owner>/dsh-codex-mode` 安装。
- **收录通道**:向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR(README.md + README.en.md 对应分类各加一行);要求 `dsh.bundle` manifest + `dsh-plugin` topic;网站 CI 每日同步 → dshmarket(Settings → Plugin Market)可搜到。
- **待办**:推 GitHub → 打 `dsh-plugin` topic → 可选发 npm(安装更快、防 squatting)→ PR 收录。
- **已知边界**:bundle 只分发组合行;agent preset 无 marketplace 分发通道,收录后在 README/描述中说明预设安装方式(scripts/install.ps1 或复制 `agent-presets/codex`)。

## 相关

- 需求文档:`docs/codex-mode-requirements.md`(决策点、验收、B.1-B.4 对照表)
- 激活手册:`plugins/ACTIVATION.md`
- 调研:`docs/research/`
