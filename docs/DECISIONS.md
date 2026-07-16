# Architecture Decision Records

所有架构偏离、依赖变更、安全权衡、数据模型迁移和 Pi 补丁都必须记录 ADR。

| ADR | 状态 | 标题 | 日期 | 关联需求 |
| --- | --- | --- | --- | --- |
| [ADR-0001](adr/ADR-0001-pi-sdk-selection.md) | Accepted | Pi SDK 选型与锁定（@earendil-works/pi-coding-agent@0.80.6，noTools+customTools 注入） | 2026-07-12 | AG-013、§8、M6-01 |
| [ADR-0002](adr/ADR-0002-process-topology.md) | Accepted | 进程拓扑：宿主服务在 Main，Agent Worker 只承载模型回路 | 2026-07-12 | AG-002、REL-001/002、TOOL-001 |
| [ADR-0003](adr/ADR-0003-runtime-choices.md) | Accepted | 运行时基础设施：node:sqlite、node-pty 预编译、ripgrep 解析链、esbuild+Vite | 2026-07-12 | REL-003、TERM-002、SRCH-005 |
| [ADR-0019](adr/ADR-0019-external-skill-sources.md) | Accepted | 多来源 Skill 自动发现、信任策略与实时校准 | 2026-07-15 | AG-014、TOOL-001、ADR-0015 |
| [ADR-0020](adr/ADR-0020-coordinated-application-skins.md) | Accepted | 三套整体联动皮肤：Terminal / Archive / Index | 2026-07-15 | APP-006、ED-015、TERM-002、PIVOT-024 |
| [ADR-0021](adr/ADR-0021-legible-terminal-blocks.md) | Accepted | 读得懂的终端：shell 集成块模型、同源进度、命令级通知 | 2026-07-16 | TERM-003/005/006、PIVOT-014、VER-005/007、ADR-0017 |

## ADR 模板

### ADR-XXXX: 标题

- 状态：Proposed / Accepted / Superseded
- 日期：YYYY-MM-DD
- 关联需求：
- 背景：
- 决策：
- 替代方案：
- 安全与数据影响：
- 迁移/回滚：
- 验证证据：
