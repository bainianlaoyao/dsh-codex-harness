# 实施状态（2026-10-15）

- 目标：完善模型输入及 DSH 原生扩展上的 Notes；本地实现已完成；2026-10-16 用户追加授权发布 0.4.0。
- 授权：用户要求完成实现，并明确选择最近已记录路由估算 + DSH 原生 overflow recovery；严格下一请求路由冻结已撤销。不修改 DSH 安装包。
- 已完成：工具图片/developer role、Responses ordered replay/phase 与指纹/路由隔离、模型能力和流错误；Notes 原子修订、幂等、分页、fork 私有副本、持久 replacement 恢复；单压缩 owner、原生摘要兜底；codex-only 挂载、Web 投影、只读分页、发布映射。
- 已验证：真实 DSH loop + tokenMeter + JSONL 的写入→切窗→读取→重启→原生摘要兜底，steering 保留；历史分页；Note revision/幂等/fork/中断后恢复；两种最终 wire；客户端组件、发布映射、打包清单及预设结构。
- 完整回归：npm run test:isolated 在统一 DSH 0.1.5 依赖上通过（包括 posttest agent/settings/UI）。新增 Notes/protocol 路径亦在 plugins 当前解析的 0.2.0-rc.2 上通过。
- 环境限制：根目录和 plugins 各有不同外部 node_modules 链接，直接 npm test 的旧 agent 测试失败于 SettingsProvider/原生 mock API。保留链接；隔离脚本避免混用。未宣称整个插件支持 0.2，也未验证真实付费模型网络、运行中浏览器服务。
- 有意保留的 DSH 差异：AGENTS baseline/local 叠加；编辑前模型检查目标目录；原生 agent/权限/工具/交互，不复制 Codex harness。
- 用户既有修改：package.json、client 与 context 原型已保留并整合；纳入本次发布源码，保留原有实现意图。

## 2026-10-16：shell 接口兼容修复

- 目标：修复 DSH 0.2 的 `ctx.shell.start is not a function`，保留 0.1.5 执行兼容；授权为源码修复与验证。
- 已修改：等待异步 `shell.execute()`，旧接口回退到 `start()`；明确 `onExpiry: none`；准备/前台取消传递独立 signal，后台发布后解除调用 signal；失败或取消时 kill 并等待句柄收敛。
- 一并修复：0.2 jobs 归属改用 session ID，使用 observed 输出流避免 `write_stdin` 抢走 `job_output` 的数据；旧 jobs 路径保留输出并报出异步 provider 失败。
- 已验证：真实 DSH 0.2 shell/subprocess/jobs 与统一 0.1.5 依赖环境下的短命令、退出码 7、超过默认 50ms 超时的后台运行、write_stdin/job_output、job_kill、Ctrl-C、前台取消。异步 resolve/准备失败、准备取消、迟到句柄和交接取消由契约回归覆盖；0.2 另执行了真实 executeArgv 的准备取消。
- 入口：`npm run test:exec`；旧版依赖验证 `npm run test:isolated -- run test:exec`。完整测试脚本也已纳入新增用例。
- 修复交付时未部署或发布；用户随后明确授权发布 0.4.1 并在本机安装。完整隔离回归已通过；安装目标为现有 Web profile 的 0.3.5 副本。整个插件对 DSH 0.2 的兼容范围仍按此前记录，不因修复 shell 就扩大声明。
