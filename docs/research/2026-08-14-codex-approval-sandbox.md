---
date: 2026-08-14
topic: codex command approval policy + sandbox + execution environment (for DSH replication)
status: completed
mode: context-gathering
sources: 60+
---

# Context Report: Codex 审批策略 + 沙箱 + 执行环境完整机制

### Why This Was Gathered
作为在另一个 agent harness（DSH，Windows、有网页审批 UI）中复刻 codex 审批/沙箱行为的需求依据。仓库：`D:\Data\DEV\dsh\codex`（openai/codex，HEAD `5bc8da6d78`）。只读调研，未修改仓库。

### Summary
Codex 把「命令分类（exec policy）→ 审批（approval_policy + hooks + 可选 LLM auto-review）→ 沙箱执行（permission profile → 平台沙箱 wrapper）→ 失败后按策略升级（escalation/重试）」做成一条流水线，全部集中在 `codex-rs/core/src/tools/orchestrator.rs`。审批不是平台沙箱的替代品：restricted 沙箱下普通命令默认不弹窗，弹窗只发生在 (a) 策略规则要求、(b) 模型显式请求升级（`require_escalated`/`with_additional_permissions`/`request_permissions`）、(c) 网络被代理拦截、(d) `untrusted` 策略下不匹配安全名单。Windows 上 codex 有原生沙箱（restricted token + ACL + WFP），但默认关闭；关闭时 workspace-write 会被降级为 read-only。

### Key Findings

---

## 1. 审批策略（approval_policy）

### 1.1 枚举与语义 — `codex-rs/protocol/src/protocol.rs:914-938`
```rust
pub enum AskForApproval {
    UnlessTrusted,   // serde "untrusted"  (protocol.rs:918-920)
    OnRequest,       // serde "on-request"，alias "on-failure"；#[default]  (protocol.rs:922-925)
    Granular(GranularApprovalConfig),  // "granular"  (protocol.rs:927-933)
    Never,           // 永不询问  (protocol.rs:935-937)
}
```
- **untrusted**：只有 `is_safe_command()` 判定为「只读安全命令」才自动批准，其余全部弹窗（doc: protocol.rs:915-917）。
- **on-request**（默认；`on-failure` 是历史别名，protocol.rs:923）：模型自己决定何时要求审批；受限沙箱下不匹配策略的普通命令「直接跑」，让沙箱兜底（见 1.4）。
- **granular**：细粒度开关，逐项决定哪些审批流允许/自动拒绝（protocol.rs:940-955）：
  `sandbox_approval`（shell 命令升级请求）、`rules`（execpolicy prompt 规则触发的弹窗）、`skill_approval`、`request_permissions`、`mcp_elicitations`。检查方法 `allows_sandbox_approval()/allows_rules_approval()/...`（protocol.rs:957-977）。
- **never**：永不弹窗；需要弹窗的命令直接 `Forbidden`（core/src/exec_policy.rs:47-48, 221；错误串 "approval required by policy, but AskForApproval is set to Never"）。

### 1.2 规则决策三元组 — `codex-rs/execpolicy/src/decision.rs:9-16`
`Decision = Allow | Prompt | Forbidden`。策略评估取匹配规则的**最大值**（Forbidden > Prompt > Allow，`Ord` 派生 + `Evaluation::from_matches`，policy.rs:365-374）。

### 1.3 命令分类规则（"consequential" 判定）
判定由三层组成，`core/src/exec_policy.rs:312-437`（`create_exec_approval_requirement_for_command`）：

1. **显式规则（.rules 文件，Starlark）**：`prefix_rule(...)`、`network_rule(...)`、`host_executable(...)` 三个内建函数（`codex-rs/execpolicy/src/parser.rs:347-472`）。前缀匹配：首 token 精确、后续 token 可为单串或候选列表（`rule.rs:39-60`）。规则可带 `justification`（展示给用户/模型的理由）和 `match`/`not_match` 示例校验（parser.rs:349-408；rule.rs:246-306）。规则文件按 config layer 低→高优先级叠加（core/src/exec_policy.rs:637-691），最后与 requirements.toml 里的强制规则 `merge_overlay`（exec_policy.rs:686-690）。
2. **未匹配时的启发式**（`render_decision_for_unmatched_command`，core/src/exec_policy.rs:727-828）：
   - `dangerous_command_match`：危险命令黑名单 → 非 never 一律 Prompt、never 则 Forbidden（exec_policy.rs:772-780）。
   - `is_known_safe_command`：安全名单 → 仅 `untrusted` 下自动 Allow（exec_policy.rs:758-764）。
   - on-request/granular + Restricted 沙箱：无升级请求时 Allow（让沙箱兜底），有 `requests_sandbox_override()` 时 Prompt（exec_policy.rs:793-826）。
   - never：Allow（靠沙箱保护）或 Forbidden（危险命令）（exec_policy.rs:782-787）。
3. **shell 降级解析**（`commands_for_exec_policy`，exec_policy.rs:844-882）：`bash -lc "…"` → 拆成内部子命令逐条评估（`parse_shell_lc_plain_commands`）；PowerShell `-Command` 同理；复杂解析失败才把整条当一条命令。

**命令规范化（approval 缓存键）**：`core/src/command_canonicalization.rs:14-38` — `bash -lc` 包装被剥离成单命令；复杂脚本规范化为 `["__codex_shell_script__", shell_mode, script]`，使 `/bin/bash -lc x` 与 `bash -lc x` 的审批缓存一致。

**危险命令判定**（`shell-command/src/command_safety/is_dangerous_command.rs:19-53`）：`rm` 带 force 选项（`-f`/`--force`，含 `sudo rm`、`env FOO=1 rm`、`trap 'rm -rf …'`、for 循环内等，递归 wrapper 深度≤8，is_dangerous_command.rs:16-53, 169-246）；Windows 另有 PowerShell/CMD 危险判定（见 1.5）。

**安全名单（known-safe）**：`shell-command/src/command_safety/is_safe_command.rs:67-173`，完整名单：
`cat cd cut echo expr false grep head id ls nl paste pwd rev seq stat tail tr true uname uniq wc which whoami`（is_safe_command.rs:76-102）；Linux 另加 `numfmt tac`（:73）；`base64`（无 `-o/--output`，:104-112）；`find`（禁 `-exec -execdir -ok -okdir -delete -fls -fprint -fprint0 -fprintf`，:114-131）；`rg`（禁 `--pre --hostname-bin --search-zip -z`，:134-154）；`git`（只允许子命令 `status log diff show branch`，且 branch 仅只读旗标，全局选项禁 `-C -c -p --config-env --exec-path --git-dir --namespace --paginate --super-prefix --work-tree`，:175-295）；`sed -n {N|M,N}p` 特殊形式（:160-168）。`zsh` 归一化为 `bash`（:16-22）。`bash -lc` 整条脚本仅当其所有子命令都安全且只用 `&& || ; |` 连接时安全（:41-48）。

### 1.4 on-failure / on-request 的「事后审批」现状（重要）
**历史行为（"on-failure"）：沙箱拒绝后弹窗问"是否无沙箱重跑"。当前 HEAD 已改变**：
- 在 `untrusted`/`granular(sandbox_approval=true)` 下：首次沙箱执行被拒（`SandboxErr::Denied`）→ 带 `retry_reason` 重新弹一次审批 → 批准后**无沙箱重跑**（`core/src/tools/orchestrator.rs:299-497`；`wants_no_sandbox_approval` 见 `tools/sandboxing.rs:330-337`）。
- 在 `never`/`on-request` 下：**不重试、不弹窗**，直接把沙箱拒绝结果返回模型（orchestrator.rs:349-370，"Under `Never` or `OnRequest`, do not retry without sandbox"）。唯一例外：on-request + Restricted 沙箱 + 网络被策略拦截时允许弹窗（orchestrator.rs:350-359）。
- 现在 on-request 下要升级只有一条路：模型显式传 `sandbox_permissions: "require_escalated"`（带 justification）或 `with_additional_permissions`（工具 schema：`core/src/tools/handlers/shell_spec.rs:298-344`）。审批通过后命令在无沙箱/额外权限下执行（`sandbox_override_for_first_attempt`，tools/sandboxing.rs:238-267）。非 on-request 策略下显式请求升级会被模型侧拒绝（`tools/handlers/shell.rs:130-143`）。
- 拒绝原因串固定为 "command failed; retry without sandbox?"（orchestrator.rs:527-531）。
- 若策略含 deny-read 条目，升级不能丢沙箱（会丢失唯一执行 deny-read 的机制）：`unsandboxed_execution_allowed` 返回 false（tools/sandboxing.rs:275-279），重试仍带沙箱。

### 1.5 Windows 命令分类差异
- 安全名单：仅接受 PowerShell 调用（`pwsh/powershell`），且只读 cmdlet 白名单：`echo write-output write-host / dir ls get-childitem gci / cat type gc get-content / select-string sls findstr / measure-object / get-location pwd / test-path / resolve-path / select-object / get-item / git / rg`；明确禁 `set-content add-content out-file new-item remove-item move-item copy-item rename-item start-process stop-process`、重定向、`&` 调用符、`$var` 动态参数、`-EncodedCommand/-File` 等（`windows_safe_commands.rs:8-17, 145-207`）。
- 危险命令：PowerShell/CMD 内 URL 触发 GUI 启动（`Start-Process URL`、`Invoke-Item`、`ShellExecute`、`rundll32 url.dll`、`mshta`、浏览器 exe、`explorer URL`）、force 删除（`Remove-Item -Force`、`del /f`、`rd /s /q`）等（`windows_dangerous_commands.rs:8-21, 40-90, 92-157, 159-188`）。

### 1.6 审批展示给用户的信息（DSH 网页审批 UI 可对照）
审批事件 `ExecApprovalRequestEvent`（`codex-rs/protocol/src/approvals.rs:226-291`）字段：`call_id`、`turn_id`、`environment_id`、`started_at_ms`、**`command: Vec<String>`（完整 argv）**、**`cwd`**、**`reason`（如 "command failed; retry without sandbox?" 或策略 justification）**、`network_approval_context {host, protocol}`、`proposed_execpolicy_amendment`（勾选后写入 default.rules 的 allow 前缀）、`proposed_network_policy_amendments`（allow/deny 该 host）、`additional_permissions`、**`available_decisions`（UI 可提供的决策按钮）**、`parsed_cmd`。事件经 `EventMsg::ExecApprovalRequest` 发给客户端（`core/src/session/mod.rs:2401-2419`）。

`default_available_decisions`（approvals.rs:314-347）：普通命令 = `[Approved, (ApprovedExecpolicyAmendment), Abort]`；带 additional_permissions = `[Approved, Abort]`；网络 = `[Approved, ApprovedForSession, NetworkPolicyAmendment(allow), Abort]`。

`ReviewDecision` 全集（`protocol.rs:3852-3887`）：`Approved / ApprovedExecpolicyAmendment / ApprovedForSession / ApprovedMcpPolicyAmendment / NetworkPolicyAmendment / Denied{rejection} / TimedOut / Abort`。

审批路由（`core/src/tools/approvals.rs:451-514`）：**优先级 = hooks(可决定 allow/deny) → 若 auto-review 或 StrictAutoReview 则 Guardian(LLM 自动审批子代理) → 否则用户 UI**。会话级缓存：`ApprovedForSession` 按规范化命令键缓存（`tools/sandboxing.rs:70-116`，键见 `approvals.rs:144-150, 195-245`）。

Guardian（auto-reviewer）：独立 LLM 子代理，输入为「动作 JSON + 紧凑转录」，按风险框架决策（`core/src/guardian/prompt.rs:90-140`，`guardian/review.rs`）；`approvals_reviewer` 配置取值 `user | auto_review | guardian_subagent`（`config/src/config_types.rs:180-182`）。

---

## 2. 沙箱模式（sandbox_mode / permission profile）

### 2.1 语义
配置值 `SandboxMode`：`read-only | workspace-write | danger-full-access`（`protocol/src/config_types.rs:81-96`）。映射到 `PermissionProfile`（`config/src/config_toml.rs:769-793`）：
- **read-only** → `PermissionProfile::read_only()`：全盘只读（`:root = read`，`protocol/src/permissions.rs:394-401, 410-412`）。
- **workspace-write** → `PermissionProfile::workspace_write[_with]`（protocol.rs:1024-1048 文档；permissions.rs:582-636 实现）：`:root = read` + `:workspace_roots = write`（即 cwd/项目根）+ `:slash_tmp = write`（可 `exclude_slash_tmp`）+ `:tmpdir = write`（可 `exclude_tmpdir_env_var`）+ 额外 `writable_roots`；默认把可写根下的 `.git`、`.agents`、`.codex` 设为只读（permissions.rs:623-625），可写根下的 `.git`/`.agents`/`.codex` 元数据保护（`PROTECTED_METADATA_PATH_NAMES`，permissions.rs:22-31；`default_read_only_subpaths_for_writable_root`，permissions.rs:1607-1644，含 git worktree 指针解析）。`WritableRoot` 还带 `protected_metadata_names`（protocol.rs:1051-1103）。
- **danger-full-access** → `PermissionProfile::Disabled`：无限制（协议文档 protocol.rs:1001-1004）。CLI `--dangerously-bypass-approvals-and-sandbox` 等价于 DangerFullAccess（exec/src/lib.rs:292-296）。
- **external-sandbox**：声明已在外部沙箱内，全盘访问但尊重网络设置（protocol.rs:1015-1022）。

`FileSystemSandboxKind = Restricted | Unrestricted | ExternalSandbox`（permissions.rs:210-220）；访问模式 `read | write | deny`（`FileSystemAccessMode`，permissions.rs:90-118，同路径冲突优先级 deny > write > read）。特殊路径 token：`:root :minimal :workspace_roots :tmpdir :slash_tmp`（permissions.rs:133-158；配置解析 core/src/config/permissions.rs:778-790）。

### 2.2 默认 deny 路径
- **Windows 沙箱的默认用户目录排除（deny-read）**：`windows-sandbox-rs/src/setup.rs:55-68` `USERPROFILE_ROOT_EXCLUSIONS`：**`.ssh .tsh .brev .gnupg .aws .azure .kube .docker .config .npm .pki .terraform.d`**（按用户根目录下这些子目录排除读取）。
- Windows 平台默认只读根：`C:\Windows, C:\Program Files, C:\Program Files (x86), C:\ProgramData`（setup.rs:69-74）。
- macOS/Linux 没有内置的 ~/.ssh 类 deny 名单（只读模式本身全盘只读；workspace-write 下全盘可读，除上述元数据路径——即现代 codex 不再在 workspace-write 中默认 deny ~/.ssh，历史 deny 名单已移除）。deny 需由用户/托管方显式配置（`permissions.<profile>.filesystem."<path>" = "deny"`，或 requirements.toml `permissions.filesystem.deny_read`）。
- deny-read 的运行时强制：精确路径 + glob 模式，matcher 失败时 fail-closed（permissions.rs:250-350；glob 扫描深度 `glob_scan_max_depth`）。

### 2.3 网络访问限制
- 网络策略独立于文件系统：`NetworkSandboxPolicy = Restricted | Enabled`（permissions.rs:73-88）；workspace-write/read-only 默认 `network_access=false`（protocol.rs:1009-1012, 1033-1036）。
- 网络受限时给子进程注入 `CODEX_SANDBOX_NETWORK_DISABLED=1`（core/src/sandboxing/mod.rs:134-140）。
- 受管网络（managed network）：本地 MITM 代理（`codex_network_proxy`），按 `allowed_domains`/`denied_domains` 域名规则决策；未命中 allowlist 时**同步阻塞请求并进入网络审批流**（见 §5）。

### 2.4 danger-full-access 行为
`PermissionProfile::Disabled` → `should_sandbox` 为 false（`should_require_platform_sandbox`，sandboxing/src/policy_transforms.rs），`SandboxType::None`；命令直接宿主执行，无 wrapper。网络仍受 profile 中 network 设置影响（Disabled 无网络限制）。`default_exec_approval_requirement` 在 unrestricted 下返回 Skip（tools/sandboxing.rs:198-230）。

---

## 3. 沙箱技术栈（平台实现）

### 3.1 平台选择 — `sandboxing/src/manager.rs:36-76`
```rust
enum SandboxType { None, MacosSeatbelt, LinuxSeccomp, WindowsRestrictedToken }
get_platform_sandbox: macOS→Seatbelt; Linux→LinuxSeccomp; Windows→仅当 windows sandbox 启用时 WindowsRestrictedToken，否则 None
```
`select_initial`/`should_sandbox`（manager.rs:285-321）：`SandboxablePreference::Auto` 时按 permission profile 是否需要平台沙箱决定。

### 3.2 macOS — Seatbelt（sandbox-exec）
- `/usr/bin/sandbox-exec` 包装（`seatbelt.rs:39`，硬编码防 PATH 注入）；base 策略 `seatbelt_base_policy.sbpl`（`(deny default)` + 进程/sysctl/PTY 等最小放行，seatbelt.rs:21-26），网络策略单独文件，read-only 平台默认另有一份；`/Applications` 只读（seatbelt.rs:23-27）。seatbelt 只适合 macOS（manager.rs:76-78 `SeatbeltUnavailable`）。子进程环境注入 `CODEX_SANDBOX=seatbelt`（core/src/sandboxing/mod.rs:141-144）。

### 3.3 Linux — landlock + seccomp + bubblewrap
- 统一经 `codex-linux-sandbox` 辅助可执行文件（self-invoke arg0，landlock.rs:4-6），CLI 参数：`--sandbox-policy-cwd --command-cwd --permission-profile <json> [--use-legacy-landlock] [--allow-network-for-proxy] -- <cmd>`（landlock.rs:23-60）。
- 默认 **bubblewrap**（user namespace）+ seccomp；legacy 模式用 landlock（landlock.rs:50-53）。受管网络需要 `--allow-network-for-proxy` → bubblewrap 隔离网络命名空间（landlock.rs:8-13, 50-56）。
- bwrap 探测与降级警告（bwrap.rs:15-38, 40-72）：系统 bwrap 缺失时用内置 bwrap；WSL1 不支持（`WSL1_BWRAP_WARNING`，manager.rs:680-694 在 WSL1 且需要 bwrap 时报错）。

### 3.4 Windows — 有原生沙箱，但默认关闭
- 两个后端（`WindowsSandboxLevel = Disabled | RestrictedToken | Elevated`，protocol/src/config_types.rs:274-284；`windows_sandbox_uses_elevated_backend`，sandboxing/src/windows.rs:32-34）：
  - **RestrictedToken（非提权）**：受限令牌 + 工作区 ACL + deny-read/deny-write ACL（`windows-sandbox-rs` crate：`identity`（受限用户 `CodexSandboxOffline`/`CodexSandboxOnline`，setup.rs:49-50）、`token`、`acl`/`deny_read_acl`、`workspace_acl`、`wfp`（网络）、`conpty`（PTY）、`unified_exec`、`wrapper`（自启动包装）、`desktop`（私有桌面，`windows.sandbox_private_desktop`，types.rs:163-170））。
  - **Elevated**：`codex-windows-sandbox-setup.exe`（管理员 setup，SETUP_VERSION=5，setup.rs:48, 54）做更强限制；受管网络（managed network）**要求** Elevated 后端（manager.rs:424-430）。
  - 启动入口：`core/src/exec.rs:596-769`（`exec_windows_sandbox`），包装器参数构造 `windows-sandbox-rs/src/wrapper.rs`。
- **无沙箱的降级行为**：Windows 上沙箱关闭（`windows.sandbox = none`）时：
  - `get_platform_sandbox` 返回 None（manager.rs:67-72）；
  - 显式 `sandbox_mode = "workspace-write"` **被强制降级为 read-only**（config/src/config_toml.rs:759-767）；
  - 受信任目录的默认 profile 也从 workspace 降为 read-only（config_toml.rs:749-753；core/src/config/permissions.rs:48-59）；
  - 审批侧：Windows 无沙箱后端 + Managed 受限 profile 时，未匹配命令一律要求审批/禁止（`windows_managed_fs_restrictions_without_sandbox_backend`，core/src/exec_policy.rs:754-756, 758-780）——即「策略形状在、但无强制机制时保持保守」。
  - 结论：**codex 在 Windows 上不是"无沙箱"而是"默认关沙箱"**；关闭时用 read-only + 更严审批补偿。

### 3.5 shell-escalation（workspace-write 里「无沙箱执行」的交互机制）
`codex-rs/shell-escalation` 仅 Unix（lib.rs:1-38）。机制：交互式 shell（zsh fork 后端）通过 `EXEC_WRAPPER`/`CODEX_ESCALATE_SOCKET` 环境变量挂 execve 拦截包装器（escalate_protocol.rs:11-14）；沙箱内每次 exec 都向宿主进程请求决策（`EscalateRequest{file,argv,workdir,env}`，escalate_protocol.rs:17-28）。决策 `EscalationDecision = Run | Escalate(Unsandboxed|TurnDefault|Permissions) | Deny`（escalate_protocol.rs:37-52）。
宿主侧策略（`core/src/tools/runtimes/shell/unix_escalation.rs:585-663`）：对拦截到的程序跑 exec policy → 命中 allow 前缀规则 → 直接**无沙箱重放**（`EscalationExecution::Unsandboxed`，:630）；未匹配 → 沙箱内运行；Prompt/Forbidden → 走审批（:497-577）。`needs_escalation` 判定 :616-622。默认关闭 shell-wrapper 解析（:583 `ENABLE_INTERCEPTED_EXEC_POLICY_SHELL_WRAPPER_PARSING=false`），以 execve 拦截为权威。

### 3.6 沙箱拒绝判定（denial heuristic）
`is_likely_sandbox_denied`（sandboxing/src/denial.rs:13-42）：非零退出 + 退出码不在 {2,126,127}；Linux seccomp 下 SIGSYS(31)→128+31；或输出含关键词 `operation not permitted / permission denied / read-only file system / seccomp / sandbox / landlock / failed to write file`（denial.rs:45-72）。拒绝后统一转 `CodexErr::Sandbox(SandboxErr::Denied)`（core/src/exec.rs:815-821）。

---

## 4. 后台命令与 shell 交互（exec / unified_exec）

### 4.1 执行引擎 `core/src/exec.rs`
- 超时：`DEFAULT_EXEC_COMMAND_TIMEOUT_MS = 10_000`（exec.rs:58）；超时退出码 124（exec.rs:65）；`ExecExpiration = Timeout | DefaultTimeout | Cancellation | TimeoutOrCancellation`（exec.rs:141-249）。
- 超时/取消/ctrl-c：杀整个进程组（exec.rs:1011-1066）；取消先 TERM 等 50ms 再 KILL（exec.rs:66, 1026-1057）。
- 输出：增量回调 `ExecCommandOutputDeltaEvent{call_id, stream, chunk}`（exec.rs:1131-1139），每调用最多 10_000 条 delta（exec.rs:80）；字节上限 `EXEC_OUTPUT_MAX_BYTES`（exec.rs:76）；IO 排空超时 2s（exec.rs:89）。
- 超时/沙箱拒绝的最终结果含完整 `ExecToolCallOutput{exit_code,stdout,stderr,aggregated_output,duration,timed_out}`（exec.rs:800-807）。

### 4.2 unified_exec（交互式 PTY + 后台会话）
- 工具 `exec_command`（PTY 会话，`shell_spec.rs:15-111`）参数：`cmd, workdir, tty, yield_time_ms, max_output_tokens, shell, login, [environment_id]` + 审批参数。**没有显式 background 布尔**——「后台」= 命令在 `yield_time_ms` 内没结束时返回 `session_id`（输出 schema `unified_exec_output_schema`，shell_spec.rs:264-296）。
- `write_stdin` 工具（shell_spec.rs:113-155）：`session_id + chars + yield_time_ms + max_output_tokens`；空 chars = 轮询。
- 常量（`core/src/unified_exec/mod.rs:66-75`）：`MIN_YIELD_TIME_MS=250`、`MAX_YIELD_TIME_MS=30_000`、空轮询 `MIN_EMPTY_YIELD_TIME_MS=5_000`、`DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS=300_000`（5min，也是 max_write_stdin_yield_time_ms）、`MAX_UNIFIED_EXEC_PROCESSES=64`、输出上限 1MiB / 10k tokens；Windows 初始 exec 轮询下限 10s（mod.rs:67）。
- 轮询语义（`unified_exec/process_manager.rs:814-823`）：非空写入 ≤30s；空轮询 5s–上限。
- 会话管理：`terminate_background_terminal(process_id)` / `list_background_terminals`（core/src/session/tasks/mod.rs:869-878；进程管理器 `terminate_process`），turn 结束清理 `close_unified_exec_processes`（session/handlers.rs:64-66）。协议层 `Op::CleanBackgroundTerminals`（protocol.rs:866）。
- 审批与沙箱对 PTY 同样走 ToolOrchestrator（`unified_exec/mod.rs:1-23` 流程注释）。

---

## 5. 网络审批与 hooks

### 5.1 网络审批（`core/src/tools/network_approval.rs`）
- 模型：MITM 代理按域名策略决策（`NetworkPolicyDecider`）；未命中 allowlist → `NetworkDecision::deny` + 同步触发审批（`handle_inline_policy_request`，network_approval.rs:582-982）。
- 审批键 = `(environment_id, host, protocol, port)`（:138-166）；会话缓存 approved/denied host（:277-280, 622-626）。
- 展示：`target = "https://host:port"`、reason `"<host> is not in the allowed_domains"`、retry_reason `"Network access to \"<target>\" was blocked by policy."`（:628-631）。动作 `ApprovalAction::NetworkAccess`（approvals.rs:128-141），命令展示为 `network-access <target>`（network_approval.rs:698）。
- 决策：`AllowOnce / AllowForSession / Deny`（:177-182）；`NetworkPolicyAmendment(allow|deny)` 会**持久化网络规则**到 policy（:838-937）；拒绝时取消执行（`cancel_execution_if_denied`，:322-328）。
- 前置条件：`never` 策略直接拒绝（`allows_network_approval_flow`，:198-200）；仅 Managed 权限 profile 支持（:202-204）。
- 执行代理按执行注册（`begin_network_approval`，:1015-1069），Deferred/Immediate 两种模式（orchestrator.rs:65-133）。

### 5.2 hooks（pre/post tool use + permission request）
- 事件类型：`PreToolUse / PostToolUse / PermissionRequest / SessionStart / SessionEnd / UserPromptSubmit / Stop / Compact`（hooks/src/events/ 目录；协议 HookEventName）。
- **PreToolUse**（`hooks/src/events/pre_tool_use.rs:24-147`）：输入 `{session_id, turn_id, agent_id, cwd, model, permission_mode, tool_name, tool_input, tool_use_id}`（:175-191）；可 `permissionDecision: deny`（带 reason）**阻止**执行（:241-248, 261-277），`allow` 可提供 `updatedInput` **改写工具入参**（:250），或注入 `additionalContext` 给模型（:225-232）。exit 0 + 有效 JSON 视为决策；exit 2 + stderr 视为 deny。
- **PermissionRequest**（`hooks/src/events/permission_request.rs:36-169`）：在**审批 UI 之前**运行，可返回 allow/deny（`PermissionRequestDecision`，:50-54）；多 handler 折叠：**任一 deny 即 deny，否则最后 allow 胜出**（:152-169）。集成于审批优先级首位（`core/src/tools/approvals.rs:470-487`：hooks → guardian → user）。
- PostToolUse：`hooks/src/events/post_tool_use.rs`（结果回填模型上下文）。
- 引擎：Claude Code hooks 兼容（`ClaudeHooksEngine`），JSON 配置文件（hooks.json）+ 命令执行（hooks/src/engine/），按 matcher（正则匹配 tool name）选择 handler。

---

## 6. 配置键清单

### 6.1 config.toml（`codex-rs/config/src/config_toml.rs`）
| 键 | 类型 | 出处 |
|---|---|---|
| `approval_policy` | `"untrusted"\|"on-request"\|"granular"\|"never"`（`on-failure` 为别名） | config_toml.rs:172-173；protocol.rs:914-938 |
| `approvals_reviewer` | `"user"\|"auto_review"\|"guardian_subagent"` | config_toml.rs:175-178；config_types.rs:180-182 |
| `sandbox_mode` | `"read-only"\|"workspace-write"\|"danger-full-access"` | config_toml.rs:197-198；config_types.rs:81-96 |
| `sandbox_workspace_write` | `{writable_roots=[], network_access=false, exclude_tmpdir_env_var=false, exclude_slash_tmp=false}` | config_toml.rs:200-201；protocol.rs:1024-1048 |
| `default_permissions` | 内置 `:read-only / :workspace / :danger-full-access` 或 `[permissions]` 命名 profile | config_toml.rs:203-206；core/src/config/permissions.rs:43-97 |
| `[permissions.<name>]` | `{extends, workspace_roots={path=true}, filesystem={<path>="read"\|"write"\|"deny"或{子路径=…}}, network={enabled, domains={allow/deny}}}` | config_toml.rs:208-210；permissions_toml.rs:111-119, 223-244, 246-280 |
| `[windows]` | `{sandbox="elevated"\|"unelevated", sandbox_private_desktop=bool}` | types.rs:156-170 |
| `[hooks]` | hooks 配置 | config_toml.rs:447 |
| `[shell_environment_policy]` | `{inherit="all"\|"core"\|"none", exclude/ set/ include_only 模式, use_profile}` | config_types.rs:187-254（默认排除 `*KEY* *SECRET* *TOKEN*`） |

### 6.2 requirements.toml（托管强制配置，`codex-rs/config/src/config_requirements.rs`）
关键字段（`ConfigRequirements`，config_requirements.rs:152-185）：`approval_policy`（`Constrained<AskForApproval>`，只允许更严格的值，:161, 1613-1660 附近）、`approvals_reviewer`、`permission_profile`（`Constrained<PermissionProfile>`，:164）、`allowed_sandbox_modes`（config_toml 侧 `allowed_sandbox_modes=["read-only",…]`，:936, 999, 1674-1700）、`allowed_permission_profiles`（:937）、`exec_policy`（`[permissions.rules]`，:177, 954）、`network.allowed_domains / denied_domains`（:341-359, 421-441）、`permissions.filesystem.deny_read`（config_requirements.rs:591-654，跨层高优先级并集合并，requirements_layers/permissions.rs:1-68）、`windows.sandbox`（:165, 820）、`allow_managed_hooks_only`（:168）。
- `[permissions.rules.prefix_rules]` 是 `.rules` 的 TOML 化（`requirements_exec_policy.rs:48-190`）：**只允许 `prompt`/`forbidden`，不允许 `allow`**（:117-119, 150-155，因为托管规则与用户规则合并时取最严格）。
- requirements.toml 位置：Windows `%ProgramData%\Codex\requirements.toml`（loader/mod.rs:715-767）、macOS 托管偏好（loader/macos.rs:22）、Linux 系统目录；`requirements_toml_base64` 走云配置。
- 冲突处理：托管值覆盖配置值并产生 source-aware 启动警告（core/src/config/requirements.rs:13-77）。

---

## 7. 复刻要点与风险（DSH 在 Windows 上）

### 7.1 架构分层（可直接映射）
1. **策略层**（DSH 可 1:1 复刻）：Decision 三元组、前缀规则（含 justification）、安全名单/危险名单、命令规范化、approval_policy 四值（含 granular）、deny-read 路径策略。这些都是纯数据/解析逻辑，与平台无关。
2. **审批编排层**（可复刻）：approval → 尝试 → 沙箱拒绝 → 按策略决定"重试无沙箱（untrusted/granular）还是直接返回失败（never/on-request）"；approval 缓存（session 级）；`ExecApprovalRequestEvent` 的字段集（command/cwd/reason/available_decisions/网络上下文/策略修订建议）就是网页审批 UI 需要的全部数据。
3. **执行层**（平台差异）：PTY 会话、yield/轮询、进程组 kill、输出 delta（call_id 关联）、后台会话清理。

### 7.2 Windows 上无 seatbelt/landlock 时的对照
- codex 的答案：**不是"放弃沙箱"，而是"默认关闭 + 策略降级 + 更严审批"**：
  - workspace-write → read-only 降级（config_toml.rs:759-767）；
  - 无后端 + 受限策略时，未匹配命令不自动放行（exec_policy.rs:754-780）；
  - on-request 下沙箱拒绝不升级弹窗（orchestrator.rs:349-370），避免"无沙箱可升"的伪安全。
- DSH 可选的渐进路线：
  - **最低**：纯策略层（deny-read 通过文件系统工具自己强制，像 codex file-system crate 那样在工具层拦截，permissions.rs:250-350 的 ReadDenyMatcher 是现成模型）+ 审批 UI 完整复刻 + 网络域名策略。Windows 下 codex 的 RestrictedToken 后端可以暂不实现。
  - **可选增强**：用 Windows 受限令牌（CreateRestrictedToken + ACL deny ACE）做进程沙箱——这正是 codex 的 `windows-sandbox-rs` 路线；DSH 复刻需额外做身份隔离、私有桌面、WFP 网络过滤，工作量很大。
- 关键设计决策要复刻：**弹窗只应在"策略要求或显式升级请求"时发生**，restricted 沙箱下默认"让沙箱兜底"，避免噪音审批；**deny-read 存在时禁止无沙箱升级**（否则升级即绕过 deny-read）。

### 7.3 风险 / 未知
- [!] on-request 的语义与历史 "on-failure" 不同：HEAD 已取消"失败后自动弹窗重试无沙箱"，若 DSH 用户期待旧行为需显式说明。
- [!] execve 拦截式 escalation（shell-escalation，Unix 专属）在 Windows 上不可用；Windows 的"无沙箱升级"只能靠显式 `require_escalated` 一次性审批，无法按 exec 粒度逐命令决策。
- [?] `~/.ssh`/`~/.aws` 默认 deny 仅存在于 Windows 沙箱后端（setup.rs:55-68）；macOS/Linux 现代版本不内置，DSH 若要内置应自行配置。
- [?] `ask` 类网络审批只在"受管 MITM 代理"下有意义；DSH 若不做 MITM，只能做"域名 allowlist 预检"，无法在连接瞬间同步拦下并发起审批。
- [!] 托管 requirements.toml 不允许 allow 前缀规则（只能 prompt/forbidden）——策略合并是"取最严格"而非"覆盖"，复刻合并语义时注意。
- [!] 审批展示的 `available_decisions` 必须按事件动态计算（有网络上下文/有 execpolicy 修订/有 additional_permissions 时按钮不同，approvals.rs:314-347）。

### Evidence Chain（核心证据）
| Finding | Source | Location |
|---|---|---|
| AskForApproval 四值 + on-failure 别名 | protocol/src/protocol.rs | 914-938 (alias 923) |
| Granular 开关集 | protocol/src/protocol.rs | 940-977 |
| Decision 三元组 | execpolicy/src/decision.rs | 9-16 |
| 前缀规则匹配 | execpolicy/src/policy.rs | 268-335；rule.rs 39-60 |
| .rules Starlark 语法 | execpolicy/src/parser.rs | 347-472 |
| 未匹配命令启发式 | core/src/exec_policy.rs | 727-828 |
| 安全命令名单 | shell-command/.../is_safe_command.rs | 67-173 |
| 危险命令判定 | shell-command/.../is_dangerous_command.rs | 19-53, 169-246 |
| 命令规范化 | core/src/command_canonicalization.rs | 14-38 |
| 审批事件字段 | protocol/src/approvals.rs | 226-291 |
| available_decisions | protocol/src/approvals.rs | 314-347 |
| 审批路由 hooks→guardian→user | core/src/tools/approvals.rs | 451-514 |
| 沙箱拒绝→升级重试编排 | core/src/tools/orchestrator.rs | 299-497 |
| on-request 不重试 | core/src/tools/orchestrator.rs | 349-370 |
| wants_no_sandbox_approval | core/src/tools/sandboxing.rs | 330-337 |
| SandboxPolicy 四模式 | protocol/src/protocol.rs | 997-1049 |
| workspace_write 策略构造 | protocol/src/permissions.rs | 582-636 |
| 受保护元数据 .git/.agents/.codex | protocol/src/permissions.rs | 22-31, 1607-1644 |
| Windows 默认 deny 名单 | windows-sandbox-rs/src/setup.rs | 55-68 |
| 平台沙箱选择 | sandboxing/src/manager.rs | 36-76, 285-321 |
| Windows 降级 read-only | config/src/config_toml.rs | 749-767 |
| 沙箱拒绝判定 | sandboxing/src/denial.rs | 13-72 |
| 超时/退出码/进程组 kill | core/src/exec.rs | 58-66, 141-249, 1011-1066 |
| 输出 delta/call_id | core/src/exec.rs | 80, 1107-1161 |
| unified_exec 常量 | core/src/unified_exec/mod.rs | 66-75 |
| write_stdin 轮询语义 | core/src/unified_exec/process_manager.rs | 749-927 (814-823) |
| exec_command/write_stdin 工具 | core/src/tools/handlers/shell_spec.rs | 15-155, 264-296 |
| 网络审批流 | core/src/tools/network_approval.rs | 582-982 |
| hooks pre/permission | hooks/src/events/pre_tool_use.rs；permission_request.rs | 24-147；36-169 |
| config.toml 键 | config/src/config_toml.rs | 172-210, 447 |
| requirements.toml 键 | config/src/config_requirements.rs | 152-185, 591-654 |
| requirements 规则禁 allow | config/src/requirements_exec_policy.rs | 117-119, 150-155 |
| shell-escalation execve 拦截 | shell-escalation/src/unix/escalate_protocol.rs; core/.../unix_escalation.rs | 11-52；585-663 |
| seatbelt | sandboxing/src/seatbelt.rs + seatbelt_base_policy.sbpl | 21-39 |
| linux landlock/bwrap | sandboxing/src/landlock.rs, bwrap.rs | 23-60；15-72 |

## Context Handoff: Codex 审批/沙箱机制

Start here: `D:\Data\DEV\dsh\research\2026-08-14-codex-approval-sandbox.md`

上下文资料（只读调研结论，含 60+ 条 `文件:行号` 证据）。实现/规划 DSH 复刻时以此为事实来源；如需更细的某块（如 guardian prompt、windows-sandbox-rs 内部、exec-server 远程执行）再针对性深入。
