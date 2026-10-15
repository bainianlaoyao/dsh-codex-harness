# 实施状态（2026-10-15）

- 目标：完善模型输入及 DSH 原生扩展上的 Notes；本地实现已完成；2026-10-16 用户追加授权发布 0.4.0。
- 授权：用户要求完成实现，并明确选择最近已记录路由估算 + DSH 原生 overflow recovery；严格下一请求路由冻结已撤销。不修改 DSH 安装包。
- 已完成：工具图片/developer role、Responses ordered replay/phase 与指纹/路由隔离、模型能力和流错误；Notes 原子修订、幂等、分页、fork 私有副本、持久 replacement 恢复；单压缩 owner、原生摘要兜底；codex-only 挂载、Web 投影、只读分页、发布映射。
- 已验证：真实 DSH loop + tokenMeter + JSONL 的写入→切窗→读取→重启→原生摘要兜底，steering 保留；历史分页；Note revision/幂等/fork/中断后恢复；两种最终 wire；客户端组件、发布映射、打包清单及预设结构。
- 完整回归：npm run test:isolated 在统一 DSH 0.1.5 依赖上通过（包括 posttest agent/settings/UI）。新增 Notes/protocol 路径亦在 plugins 当前解析的 0.2.0-rc.2 上通过。
- 环境限制：根目录和 plugins 各有不同外部 node_modules 链接，直接 npm test 的旧 agent 测试失败于 SettingsProvider/原生 mock API。保留链接；隔离脚本避免混用。未宣称整个插件支持 0.2，也未验证真实付费模型网络、运行中浏览器服务。
- 有意保留的 DSH 差异：AGENTS baseline/local 叠加；编辑前模型检查目标目录；原生 agent/权限/工具/交互，不复制 Codex harness。
- 用户既有修改：package.json、client 与 context 原型已保留并整合；纳入本次发布源码，保留原有实现意图。
