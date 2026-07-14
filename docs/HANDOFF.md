# HANDOFF — 自主构建会话交接文档

> 目的：上下文 compact/新会话后，从这里无损接续。规范源仍是 `docs/PRODUCT_ENGINEERING_SPEC.md` + `docs/IMPLEMENTATION_BACKLOG.md`；本文件只记录"规范里没有、但接续必须知道"的事实。
> 最后更新：2026-07-13，M7 完成并提交后。
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
| M10–M12 | NOT_STARTED | 见 `docs/TODO_M8_M12.md` |

证据基线（pivot 提交时）：**238 个单元/集成测试**（32 文件）、**32 个 E2E** 连续两轮全绿；`npm run check` 干净（boundary 151 文件）。

**重要方向变更（ADR-0004，用户 2026-07-13 试用后拍板）**：产品更名 **Charter**（UI 全面去 Pi 品牌，`@pi-ide/*` 包名与 `PI_IDE_*` 环境变量为内部实现保留）；默认入口是 Codex 式 **Home 任务台**（`HomeView.tsx`：项目/模型/审批策略内联 + 一句话意图 → `createFromIntent` 自动派生标题建任务），完整 IDE 为第二 surface（`appStore.surface`，标题栏 ⌂ Home / Open IDE workspace 切换，workspace 打开自动切 IDE，Home 选项目例外经 `homePick` 标志）；Settings→Models 有 Provider 密钥管理 + **实时拉模型**（主进程 `model-catalog.ts`，anthropic/openai 端点，merge 进 models.list）。用户后续计划：基于 Pi 扩展自研 agent 逻辑（保持 SDK 锁定 + AgentRuntime 合同，不复制源码——ADR-0004 记录了性能与维护性论证）；阶段 2：意图→元代理起草验收标准/验证命令、任务预算、验证不绿自动迭代。E2E 注意：`launchApp` 新增 `home:'keep'|'dismiss'`（默认 dismiss），无 workspace 的测试会自动点掉 Home。
**Shell v5（ADR-0014，2026-07-14）**：交互终态定为"一个房间三档缩放、对话恒锚"——L1=Task Room 内驻留式文件 peek（`task.peekFile` 走 per-mount `contextForTask().documents.readLogical`，worktree 诚实；`appStore.peek` + `views/FilePeek.tsx`，Changes/File 双模只读，Esc 收回）；所有文件引用默认开 peek，⌘/alt-click 或显式入口才进 Editor（PIVOT-034/035）；L2=⌘E 房间感知 + 每任务草稿（draftStore）/时间线滚动（scrollMemory）跨表面共享（PIVOT-036）；PIVOT-037 壳层合一为记录的下阶段。peek 内 spot-edit 需先做归属语义 ADR 再上。
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
- **M12**：electron-builder 已配置并验证过 --dir 打包+启动（M1 时）；缺 scripts/release-verify.mjs、SECURITY.md、PRIVACY.md、SBOM/许可证清单、TEST_REPORT.md 填充、最终 STATUS。签名/公证无证书 → 记录为发布阻断项。

## 已知妥协/待记录事项（诚实清单）

- OAuth Provider 登录未实现（API Key 全流程可用）→ 需补 ADR + Known Limitations（ONB-003 部分满足）。
- validateCredential 只做存在性检查，未做活探测（ONB-005 错误分类依赖真实 run 的错误路径）。
- Python LSP：机器无 pylsp 时走降级提示（E2E-006 按规格双路径验证过）。
- get_symbols/get_diagnostics 工具（LSP-007，P1）未注册。
- Timeline 虚拟化（10k 事件）留给 M11 性能项。
- 真实 Pi smoke（需 API key）未运行——用户醒来后可配 key 验证；mock 路径全绿。

## 用户指令备忘

用户睡前指令：按文档完成整个产品、全部决策委托给我、要测试、醒来时要"完整且可用"。用户要求 compact 时任务不丢、做好交接（即本文件）。
