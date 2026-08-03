# HANDOFF — 自主构建会话交接文档

> 目的：上下文 compact/新会话后，从这里无损接续。规范源仍是 `docs/PRODUCT_ENGINEERING_SPEC.md` + `docs/IMPLEMENTATION_BACKLOG.md`；本文件只记录"规范里没有、但接续必须知道"的事实。
> 最后更新：2026-07-29，M12 桌面更新服务完成；signed Stable qualification 仍阻断。
>
> **M8 起的细粒度待办已单列到 `docs/TODO_M8_M12.md`——新会话读完本文件后从那里执行。**

## 当前进度（真实状态，全部有 commit 与测试证据）

| 里程碑 | 状态 | 提交 |
| --- | --- | --- |
| M1 工程基线与合同 | VERIFIED | b4ae0eb |
| M2 应用壳/设置/持久化 | VERIFIED | 902944d |
| M3 Workspace/编辑器 | VERIFIED | f16fc26 |
| M4 搜索/LSP/终端 | VERIFIED | 0f03e92 |
| M5 Git/ChangeService | VERIFIED | c704edd |
| M6 Pi Runtime/只读 Agent | VERIFIED | 931e167 |
| M7 Tool Gateway/权限系统 | VERIFIED | 6ccb16d |
| M8 Agent 写入/计划/审查 | VERIFIED | (见 git log) |
| M9 验证/报告/历史 | VERIFIED | (见 git log) |
| **PIVOT 双形态壳层（ADR-0004）** | VERIFIED | (本轮提交) |
| M10 | VERIFIED | (见 git log) |
| M11 | VERIFIED | (见 git log) |
| M12 unsigned Beta + 更新服务 | VERIFIED（Beta 5 候选） | `docs/TEST_REPORT.md`、ADR-0043/0048；signed Stable qualification BLOCKED |

证据基线（pivot 提交时）：**238 个单元/集成测试**（32 文件）、**32 个 E2E** 连续两轮全绿；`npm run check` 干净（boundary 151 文件）。

**重要方向变更（ADR-0004，用户 2026-07-13 试用后拍板）**：产品更名 **Charter**（UI 全面去 Pi 品牌，`@pi-ide/*` 包名与 `PI_IDE_*` 环境变量为内部实现保留）；默认入口是 Codex 式 **Home 任务台**（`HomeView.tsx`：项目/模型/审批策略内联 + 一句话意图 → `createFromIntent` 自动派生标题建任务），完整 IDE 为第二 surface（`appStore.surface`，标题栏 ⌂ Home / Open IDE workspace 切换，workspace 打开自动切 IDE，Home 选项目例外经 `homePick` 标志）；Settings→Models 有 Provider 密钥管理 + **实时拉模型**（主进程 `model-catalog.ts`，anthropic/openai 端点，merge 进 models.list）。用户后续计划：基于 Pi 扩展自研 agent 逻辑（保持 SDK 锁定 + AgentRuntime 合同，不复制源码——ADR-0004 记录了性能与维护性论证）；阶段 2：意图→元代理起草验收标准/验证命令、任务预算、验证不绿自动迭代。E2E 注意：`launchApp` 新增 `home:'keep'|'dismiss'`（默认 dismiss），无 workspace 的测试会自动点掉 Home。
**Shell v5（ADR-0014，2026-07-14）**：交互终态定为"一个房间三档缩放、对话恒锚"——L1=Task Room 内驻留式文件 peek（`task.peekFile` 走 per-mount `contextForTask().documents.readLogical`，worktree 诚实；`appStore.peek` + `views/FilePeek.tsx`，Changes/File 双模只读，Esc 收回）；所有文件引用默认开 peek，⌘/alt-click 或显式入口才进 Editor（PIVOT-034/035）；L2=⌘E 房间感知 + 每任务草稿（draftStore）/时间线滚动（scrollMemory）跨表面共享（PIVOT-036）；PIVOT-037 壳层合一为记录的下阶段。peek 内 spot-edit 需先做归属语义 ADR 再上。
**Session Canvas（PIVOT-037，2026-07-17，未提交）**：PIVOT-037 已实现并取代“双 surface/Full workspace”运行时。`Workbench` 永远只挂载一个 `SessionRail + HomeShell`；全局 Activity Bar、旧 Sidebar、重复 Agent Panel 不再挂载。用户对象统一为 Session：左侧 Sessions/Needs You/Projects，中间对话/计划/证据，右侧 `SessionToolCanvas` 的 Summary/File/Diff/Preview/Terminal/Review；File 工具可原位放大但不卸载对话。Home Composer 的 Agent Picker 统一派发 Charter/Pi、Claude、Codex。Review-ready 默认证据账本，所有决定只在一个响应式 Action Dock；零改动回答不会落入空 Review，Rollback 后 Review 会退回 Summary；Replay 收进 More。用户给定的 Diff 参考图已按真实数据链复刻：review 状态使用 `File / Diff / Preview / Terminal / Review`，Diff 内同时呈现文件汇总与统计、可切换文件、带行号和 Monaco 语法色的 inline hunks、验证卡、复制/高级审查入口，以及唯一的 Request changes / Rollback / Approve changes Dock；Diff 自动聚焦放大，File Peek 仍作为独立 File 状态保留。历史 HTML 的三层执行现场感也已接回统一壳：Session Rail 常驻 heartbeat ticker；Launcher 为每个运行中的 Session 展示独立 Live Board；Room 同时保留时间线 live tool row、Session 工具区的文件热度卡和底部 activity strip。它们全部由同一套 task/change 事件驱动，不是装饰动画；文件卡会随真实写入呈现 hot/warm/cool、节奏柱与 writing beacon，点击直接进入 Diff，Thinking/streaming 会覆盖过期 action label。没有活动 Session 时，`ProjectToolView` 在同一壳中保留 Files、Search/Replace、Git Changes、任意文件编辑、split/conflict、TypeScript Problems 与 Quick Open。原有 Terminal Parallel 管理器没有被牺牲：⌃` 打开的 shell、多 PTY 切换、Claude/Codex 检测、侧栏升格/缩放/归位、结束与恢复都作为 Session-owned Terminal 状态保留。兼容 `surface/workspace` 与旧 layout command id 只映射到 Session/Project 工具状态，不会恢复第二套壳。验收证据：单测 470/470、完整 Electron 106 passed/13 gated skipped、最新 Session Canvas/File Peek/Review/Editor/worktree/现场感定向 Electron 16/16，另有 focused Diff 1/1 与 heartbeat 1/1、1440×900/900×900 实机截图、参考/实现同图对照与 live-file→Diff 路径；详见 `tests/e2e/session-canvas.spec.ts`、`tests/e2e/external-cli.spec.ts` 与 `design-qa.md`。
**Skills live sources（ADR-0019，2026-07-15）**：Settings 不再只能复制导入；`SkillStore` 自动发现用户级 `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`，也支持 Connect 自定义根目录。外部来源默认只发现不加载，可按 Skill 或 Source 信任/auto-enable-new；watcher + 45s/聚焦/运行时全量校准保证增删改同步。冲突名限定为 `name@source`；`realpath` 同时守住 audit/load_skill 的链接逃逸；成功加载记录 source/revision/content hash。项目目录仍不会隐式扫描（AG-014）；E2E 只在显式 `PI_IDE_SKILLS_HOME` 下扫隔离假 home。
**会话回放 V2（ADR-0017 Amendment 6，2026-07-15）**：A 默认“刷视频”入口、D 长任务细节、E 审批审计、B 可观察因果、C 跨应用投影已经合入正式 `ReplayView`，五者共享 `task_events` + 内容寻址 blob。Pi 为 full；Claude/Codex 可识别 JSON 流为 structured；普通 TUI 为 observed，并在所有视图显示能力边界。外部会话会持久化脱敏/限额 PTY 证据和每次观察到的文件版本；structured JSON 在终端证据落库前完成解析，只存可观察摘要，thinking/reasoning 和分片私有 JSON 均丢弃。入口同时覆盖 managed Task Room 和 external Task Room。真实 Claude Code 2.1.210 stream-json 与 Codex CLI 0.144.4 JSONL smoke 已通过。
**桌面更新（ADR-0048，2026-07-29）**：`UpdateService` 已接进 Main、typed IPC、Settings、菜单与持久操作通知卡。自动检查在启动 15 秒后、此后每 6 小时；unsigned 新版本卡提供 **View & download**，signed 下载完成卡提供 **Later / Restart & install**，主体直达 Updates，卡片在处理/稍后/关闭前不按普通 toast 的 4 秒规则消失。signed packaged macOS/Windows 使用 `electron-updater@6.8.9` 后台下载，但必须用户明确重启安装，先过既有 quit blockers，再用 `node:sqlite backup()` 做版本化一致备份；Stable→`latest`、Beta→`beta`，禁止 downgrade。native delivery 只认打包时注入的 `charterUpdateMode: signed`，unsigned macOS/Windows 与 Linux 只查 GitHub Releases 并打开页面，严格保持 ADR-0043 不执行 unsigned replacement。Beta 5 首次公开携带该通知服务，Beta 3 用户仍需手动升级一次。验证：update/state/IPC/release unit、Updates Electron E2E、`beta-mac.yml` + 包内 `channel: beta`/unsigned/updater 依赖核验、真实 DMG install smoke 2/2。Stable 还需证书/notarization 与 macOS/Windows 真实 signed old→new qualification。
M7 交付与接续点详见 `docs/TODO_M8_M12.md` 顶部"已完成状态"。
测试命令：`npm test`、`npx playwright test --config tests/e2e/playwright.config.ts`、`npm run check`、`node scripts/build.mjs`。

## 关键架构事实（新会话必读）

1. **ADR-0001/0002/0003 在 `docs/adr/`**。最重要的偏离：宿主服务（ToolGateway、TaskService、DB、ChangeService、Git、Search、PTY）全部在 **Main 进程**；agent-worker（utilityProcess）**只跑 AgentRuntime**（Pi adapter 或 Mock），工具调用经 MessagePort 回主进程网关执行（`toolRequest`/`toolResult` 协议，定义在 `packages/agent-contract/src/worker-protocol.ts`）。
2. **Pi SDK**：`@earendil-works/pi-coding-agent@0.80.6` 精确锁定。适配层 `packages/agent-runtime-pi`（唯一可 import pi，boundary lint 强制）。关键：`createAgentSession({ tools: [仅网关工具名], customTools })` —— 显式白名单，pi 内置 read/bash/edit/write 永不激活（合同测试 `adapter-contract.test.ts` 守护）。凭据经 `AuthStorage.inMemory` 注入，session 文件在 AppData/runtime/agent/sessions/。
3. **持久化**：`node:sqlite`（Node 24 内建，Electron 43 验证可用，零原生依赖）。schema v1 已含全部表（tasks/task_events/agent_runs/tool_calls/permission_*/file_baselines/file_changes/verification_runs/...），M7+ 大多不需要新迁移。
4. **Mock Runtime**（`packages/agent-runtime-mock`）走与 Pi 完全相同的 ToolExecutor 路径 → E2E 用 `PI_IDE_FORCE_MOCK=1` 环境变量驱动真实网关。场景用 prompt 标记 `[scenario:xxx]`（见 `scenarios.ts`；M8 需新增 edit-multifile 真实写入场景）。
5. **E2E 基建**：`tests/e2e/helpers/launch.ts`（隔离 userData + `PI_IDE_OPEN_WORKSPACE` 自动开工作区 + `PI_IDE_E2E=1`）、`helpers/fixtures.ts`（createTsSmallFixture/createGitFixture）。
6. **渲染器扩展点**：`workbench/Workbench.tsx` 导出 registries（viewRegistry/bottomTabRegistry/editorAreaRegistry/agentPanelRegistry/statusBarRegistry/titleBarRegistry/overlayRegistry/editorBannerRegistry/initRegistry）；每个里程碑一个 `contrib/mN-*.tsx` 在 `main.tsx` 注册。
7. **本机环境坑（.npmrc 已配置，勿删）**：npm 11 allow-scripts 机制（approve 记录在 package.json `allowScripts`）；GitHub 直连不可用 → electron 二进制走 npmmirror（`electron_mirror`）；@vscode/ripgrep 二进制下载失败 → 搜索用系统 rg（/opt/homebrew/bin/rg）+ JS 兜底（ADR-0003）；node-pty 用自带 N-API prebuild，`scripts/postinstall.mjs` 修 spawn-helper 权限位。
8. **数据丢失防护的两处关键实现**（回归时注意）：editorStore 的 renderer-side dirty guard（clean-reload 事件到达但本地 model dirty → 转冲突，绝不覆盖）；ChangeService.rollbackPreflight 的外部修改冲突检测（CHG-010）。

## M7–M12 待办与已铺垫的接续点

- **M7 Tool Gateway 与权限：已完成（VERIFIED）**。PermissionEngine（PERM-001..010）、命令分类器/运行器、run_command/ask_user、权限卡 UI、安全矩阵、SQL 持久化全部落地。细节见 `docs/TODO_M8_M12.md` 顶部。**M8 起从 `docs/TODO_M8_M12.md` 执行。**
  - 仍未做（挪到 M8/M11 记录）：get_symbols/get_diagnostics（LSP-007，P1）未注册；写工具 apply_patch/create_file/delete_file 尚未注册（M8-02 的任务，ChangeService 已就绪）。
- **M8**：计划批准流（AWAITING_PLAN_APPROVAL + plan 编辑）、Edit/Auto 默认策略、Review 页（changeSet 已能产净 diff，需逐文件/hunk 接受拒绝 UI + `structuredPatch` 已从 change-service 导出）、三方冲突视图、E2E-010/011/014/015。
- **M9**：VerificationService（runner/stale/superseded）、真实 Final Report（现在 TaskService.buildFinalReport 是骨架，标注 unverified）、E2E-016/017/018。
- **M10**：恢复页（markOrphanedRunsInterrupted 已有）、DB 备份恢复演练、支持包脱敏导出（redact 基建在 foundation）、soak、无孤儿进程（E2E-007 已测一部分）。
- **M11**：CSP 已上（main/index.ts），需安全测试矩阵（tests/security/ 目录已建但空）、性能 fixtures（createLargeTreeFixture 已有）、a11y 补强、vitest.security.config.ts / vitest.perf.config.ts 尚未创建（package.json 脚本引用了它们）。
- **M12**：`release:verify`、E2E-023/024、三平台 native package/install workflow、SBOM/许可证/manifest/checksums、SECURITY/PRIVACY/recovery/limitations/release notes 均完成；macOS unsigned DMG 已真实安装启动。ADR-0043 将零成本构建强制限定为 GitHub Prerelease；ADR-0048 的 updater 服务/feed/UI/备份已落地。paid signing/notarization、双平台真实 signed update qualification、真实 20-task eval 与 owner sign-off 留作 Stable 阻断项。

## 已知妥协/待记录事项（诚实清单）

- OAuth Provider 登录未实现（API Key 全流程可用）→ 需补 ADR + Known Limitations（ONB-003 部分满足）。
- validateCredential 只做存在性检查，未做活探测（ONB-005 错误分类依赖真实 run 的错误路径）。
- Python LSP：机器无 pylsp 时走降级提示（E2E-006 按规格双路径验证过）。
- get_symbols/get_diagnostics 工具（LSP-007，P1）未注册。
- Timeline 虚拟化（10k 事件）留给 M11 性能项。
- 真实 Pi smoke（需 API key）未运行——用户醒来后可配 key 验证；mock 路径全绿。

## 用户指令备忘

用户睡前指令：按文档完成整个产品、全部决策委托给我、要测试、醒来时要"完整且可用"。用户要求 compact 时任务不丢、做好交接（即本文件）。
