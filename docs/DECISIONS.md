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
| [ADR-0034](adr/ADR-0034-forget-project-and-projection-repairs.md) | Accepted | 删除项目（forget）+ 回滚后投影修复 + 房间自适应：迁移 v7 归一遗留 external status（单行脏数据不再毒死 task.list）+ rowToDto 读侧防御；task.rolledBack 置 `filesReset`、live fold 与 replay 同投影重置已触文件、rollback 后 changeSet 重取；Session Canvas 断点改容器查询（量房间实际宽度）；新通道 workspace.remove 单事务忘记项目全部记录、永不碰磁盘、运行中防护 | 2026-07-20 | 用户缺陷报告 ×3（Restore 后 Diff 残留、窄窗错位、Projects 无删除入口）；ADR-0006/0009/0032、§9.3、§11.2 |
| [ADR-0035](adr/ADR-0035-replay-v32-lean-recap.md) | Accepted | Replay V3.2 lean recap：五条投影规则——折叠条 FOLD_MIN=3 且心跳跨度归 footer 汇总、紧凑随规模涌现、批准经 id-backed `resolves` 关系（permission requestId→callId 链 / plan 版本 join）chip 化到目标行、软过程错误 amber 降级、'结构化记录' 徽章反转只标例外；账本与 Explore/Verify 不变 | 2026-07-20 | 用户对比 mock 验收（replay-v32-lean-recap-mock.html）；扩展 ADR-0031；相邻性不造边不变量保持 |
| [ADR-0043](adr/ADR-0043-unsigned-public-beta-release.md) | Accepted | 零成本 unsigned public beta：三平台 GitHub prerelease + checksums/SBOM；签名 Stable 保持外部阻断且策略禁止冒充 | 2026-07-21 | M12-01..07、§12.2、§14 M12、§16、§18.2/18.3 |
| [ADR-0039](adr/ADR-0039-clipboard-image-card.md) | Accepted | 剪贴板图片浮卡：元数据优先轮询（types 查询→仅裸图片才读内容+指纹）、启动基线不播报、空闲退避 1.2s→5s、PNG 落 userData 受管目录（16 张 FIFO、名字不复用）经 `ScreenshotWatcher.announce()` 进 ADR-0036 同一管线；`origin: 'clipboard'` 可选字段、卡片仅换头部 | 2026-07-21 | 用户排障裁定（微信/⌘⇧⌃4 类剪贴板截图不落盘，目录 watcher 全盲）；反转 ADR-0036 对剪贴板轮询的否决；`PI_IDE_CLIPBOARD_CAPTURE=0` 应急关闭 |
| [ADR-0040](adr/ADR-0040-skills-usage-external-consumers.md) | Accepted | Skills 透视纳入外部 CLI 消费方：usage 事件带 consumer(charter/claude/codex)、`skills.usage` v2 加 `byConsumer` 分账；Claude Code 转录 `Skill` tool_use 经 archaeology 采集(带时间戳)、slug+源优先 join 回目录名；Codex 保留位恒零(格式未验证不猜写)；UI Via 筛选投影 + 分色堆叠火花线 + 徽章全消费方 + 断舍离经济学仍按 Charter(外部-only 不预选) | 2026-07-21 | 用户裁定(首版仅 Claude Code、UI 完整版);ADR-0037/0038、§9.3 |
| [ADR-0044](adr/ADR-0044-session-orchestration.md) | Accepted | 会话编排（agent 指挥 agent）：六个 terminal.* gateway 工具（send 文本过分类器动态定级、R4 前置拒绝不变）+ per-terminal token 身份（内存态不落盘）+ unix socket 外部门（claude/codex 当司机，验票→翻译进同一 executeCall）+ 长在 rail/房间的指挥 UI（家谱缩进 44px 子行、编队区双列瓦片、导播位叠加）；两层封顶、两档暂停、敲字即接管、审批单记录多入口、read/wait 只记元数据不落输出、总开关熔断 | 2026-07-21 | ORCH-001..012（M13 立项，M12 先行）、ADR-0002/0006/0015/0017/0021/0023/0030、PIVOT-013/014、fusion+v3-director-stage mockup 验收；外部参考 alchaincyf/fanbox docs/12 |
| [ADR-0045](adr/ADR-0045-user-level-instruction-surfaces.md) | Accepted | 外部 CLI 用户级指令面：设置一键把 charter-terminal 手册装进受管库 + ~/.claude/skills + ~/.codex/skills（显式点击才写、tmp+rename 原子、byte 对比 upToDate 可更新）；手册自带触发条件与门票自检、无 MCP 时走 charter-terminal 命令/curl 同一扇门；修订 ADR-0044"不碰 ~/.claude"（wrapper 仍不做静默编辑）；wrapper 链加固：解析追加 ~/.local/bin 等安装目录、CLI 消失即清理 stale wrapper | 2026-07-22 | 现场失效裁定（alias/PATH prepend/安装迁移三重绕过）；ADR-0044 决策 8、ADR-0015/0017；外部参考 fanbox builtinSkillInstall；`skills.installCharterTerminal` v2 + `skills.charterTerminalStatus` |

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
