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
| [ADR-0022](adr/ADR-0022-preview-gate-and-pr-draft.md) | Accepted | 可见的验收：预览 tab、圈选反馈、PR 草稿（补录索引） | 2026-07-16 | VER-005/007/008、GIT-007、ADR-0012 |
| [ADR-0023](adr/ADR-0023-grouped-activity-rail.md) | Accepted | Session Rail 方向 D：分组活动栏（补录索引） | 2026-07-16 | PIVOT-038/039、PIVOT-011r/013r2/027r2 |
| [ADR-0024](adr/ADR-0024-room-context-feeding-parity.md) | Accepted | Room 上下文投喂对齐：常驻 Files 树、统一引用 chips、任务附件图片（补录索引） | 2026-07-18 | PIVOT-015/020、ADR-0014/0022 |
| [ADR-0025](adr/ADR-0025-m11-rescope.md) | Accepted | M11 任务清单重定义：差距收口式改写、pivot 新增面纳入、新增 M11-07 隐私任务 | 2026-07-18 | §14 M11、§16.4/16.5、A11Y-001..005、PRIV-001..003 |
| [ADR-0026](adr/ADR-0026-boundary-checker-aliased-requires.md) | Accepted | 边界检查器覆盖别名 require；Pi package.json 元数据读取为显式豁免（补录索引） | 2026-07-18 | CLAUDE.md 边界规则、§9.5、M1-06 |
| [ADR-0027](adr/ADR-0027-m11-hardening-implementation.md) | Accepted | M11 硬化实现：fuses、四路秘密验证、Room 窗口化、真窗口缩放、无障碍 Diff、诚实隐私 | 2026-07-18 | §16.4/16.5、A11Y-001..005、PRIV-001..003、ADR-0025 |
| [ADR-0028](adr/ADR-0028-project-memory.md) | Accepted | 项目记忆：审查即学习的规则沉淀，单源三投影（preamble / CLAUDE.md / AGENTS.md 托管区块），私有记忆只管理不合并 | 2026-07-19 | 提案① mock Ⓐ/Ⓑ/Ⓒ、ADR-0015/0019 模式复用、ADR-0017 边界教训、M11-07 清理路径 |
| [ADR-0029](adr/ADR-0029-single-project-tree.md) | Accepted | 单一项目文件树：rail Files 面板并入 ExplorerView 管理能力成为唯一的树（ProjectTree）；编辑器表面移除 Files 工具列，'files' 工具改名 'editor'；railView 提升至 appStore | 2026-07-20 | 用户验收截图指出双树冗余并选定合并终局；部分取代 ADR-0024 中「Editor 保留 canonical ExplorerView」 |
| [ADR-0030](adr/ADR-0030-external-terminal-single-input.md) | Accepted | 外部会话单输入口：删除底部 product composer，CLI 输入行是唯一对话面；拖拽/选区经 external.injectContext 注入（bracketed paste 不带回车）；注入记台账、typed-line 命名会话 | 2026-07-20 | 用户 mockup 验收（B 案）；部分取代 ADR-0017/0024 的外部 composer 表述 |
| [ADR-0031](adr/ADR-0031-replay-v31-conversation-first-recap.md) | Accepted | Replay V3.1：对话优先 Recap——引自报告的结论行（逐字+引用锚）、只读返回线（审阅唯一入口在房间）、折叠占位符、转折（计划修订）检测、对外动作双轨与不可逆置顶、输入台账；外部 parser 补 TodoWrite/todo_list→plan | 2026-07-20 | 用户两轮 mock 验收（replay-v4-recap-mock*.html）；砍掉与房间重复的行动面板/成本条；扩展 ADR-0017 am.8 |
| [ADR-0032](adr/ADR-0032-session-as-conversation.md) | Accepted | 会话即对话（4b）：一个 Session 聊天+干活不换房间；账按轮记（agent_runs.review_state），验收/回滚/Answered 结算到 IDLE 续聊；ARCHIVED 是唯一关门，worktree 合并挪到归档时；按轮回滚（最新已结轮逆序，字节级）；对话流保持纯净。验收修订：右栏轮次账本撤除（summary 保持会话级、对齐 Claude Code/Codex，按轮通道仅存 API 层）；已答 Done 仪式删除、accept 幂等化 | 2026-07-20 | 用户两轮 mock 验收（session-4b-continuous-room.html，第 2 轮删轮标记/内联验收条）+ 验收轮截图反馈两条；取代 ADR-0008 的会话粒度终结与 follow-up 开新任务；历史终结任务迁移（migration v6） |
| [ADR-0033](adr/ADR-0033-terminal-file-links.md) | Accepted | 终端文件链接：⌘+单击 file token 经 terminal.openPath（cwd 封禁+扩展名分流）系统浏览器打开 html/svg/pdf、其余进编辑器；OSC 8 + 正则双轨识别；顺带修复终端网页链接点击无响应 | 2026-07-20 | 用户 mockup 验收（terminal-file-link-mock.html，选定 ⌘+单击/系统浏览器）；§12.3 策略未放宽 |

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
