# Pi-powered Agentic IDE — 实施 Backlog v1.0

本文件是主规格的执行视图。`Pi_Agentic_IDE_Product_Engineering_Spec_v1.0.md` 为规范源；本 Backlog 不能降低主规格。每项完成后需填入 commit/PR、测试证据与状态。

状态：`NOT_STARTED / IN_PROGRESS / BLOCKED / DONE / VERIFIED`。

## Milestone 1: 工程基线与合同

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M1-01 | 建立 npm workspace/monorepo、strict TS、统一 tsconfig | 无 | VERIFIED | npm workspaces + strict TS (tsconfig.base.json) |
| M1-02 | 创建 Main/Preload/Renderer/Agent Worker 四入口 | M1-01 | VERIFIED | apps/{desktop-main,desktop-preload,desktop-renderer,agent-worker} |
| M1-03 | 配置 format/lint/typecheck/unit/CI | M1-01 | VERIFIED | npm run check / test / CI (.github/workflows/ci.yml) |
| M1-04 | 定义 ProductError、IPC envelope、AgentRuntime/AgentEvent | M1-01 | VERIFIED | packages/{foundation,ipc-contracts,agent-contract} + 28 unit tests |
| M1-05 | 实现 MockAgentRuntime 与 deterministic event scripts | M1-04 | VERIFIED | packages/agent-runtime-mock + scenario engine tests |
| M1-06 | 添加依赖边界 lint：Pi 仅 agent-runtime-pi | M1-04 | VERIFIED | scripts/check-boundaries.mjs + tests/unit/boundaries.test.ts |
| M1-07 | 创建 ADR、状态、测试报告和发布清单模板 | M1-01 | VERIFIED | docs/adr/ADR-0001..0003, status/report templates in docs/ |

## Milestone 2: 应用壳与持久化

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M2-01 | 主窗口、菜单、命令面板、主题、布局框架 | M1 | VERIFIED | Workbench/menu/palette/theme/layout (E2E m2-shell) |
| M2-02 | Preload 白名单 API 与 schema IPC router | M1-04 | VERIFIED | preload whitelist + schema router (M1) + settings/layout channels |
| M2-03 | SQLite 数据库、migration、事务与备份 | M1 | VERIFIED | node:sqlite + migrations + checksum + backup/restore (6 unit tests) |
| M2-04 | SettingsService、全局/Workspace 覆盖 | M2-03 | VERIFIED | SettingsService + lenient resolve (4 unit tests) + Settings UI |
| M2-05 | 结构化日志、错误页、Diagnostics 基础 | M2-03 | VERIFIED | FileLogSink rotation + app_errors + Diagnostics view + startup safe mode (E2E m2-db-failure) |
| M2-06 | 窗口/布局/最近项目恢复 | M2-01,M2-03 | VERIFIED | window-state.json + ui_workspace_state + recent list (E2E restart restore) |

## Milestone 3: Workspace 与编辑器

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M3-01 | Workspace open/close/recent/trust model | M2 | VERIFIED | WorkspaceHost + workspaces table + trust prompt (WS-015) |
| M3-02 | canonical path、文件树、忽略规则、监听器 | M3-01 | VERIFIED | canonical/realpath boundary (9 unit tests incl. symlink escape), lazy tree + ignore, recursive watcher |
| M3-03 | Document Store revision/hash/dirty model | M3-01 | VERIFIED | DocumentStore 11 unit tests: revisions/hash/dirty/conflict/binary/large/EOL/own-write suppression |
| M3-04 | Monaco tabs、split、save、autosave | M3-03 | VERIFIED | Monaco tabs/split/save/autosave/viewstate + tab restore (E2E-002) |
| M3-05 | 外部变化与冲突 UI | M3-02,M3-03 | VERIFIED | conflict bar Reload/Compare/Keep + renderer dirty-guard (E2E-003) |
| M3-06 | Diff/Conflict Editor | M3-04 | VERIFIED | Monaco diff compare overlay (disk vs buffer) |
| M3-07 | 大文件/二进制/编码/换行符处理 | M3-03 | VERIFIED | binary/large/EOL/BOM handling + editable cap + status bar EOL toggle |

## Milestone 4: 搜索、LSP 与终端

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M4-01 | Quick Open 与最近文件 | M3 | VERIFIED | QuickOpen server-side fuzzy + recent boost (E2E) |
| M4-02 | ripgrep 搜索、结果流、取消 | M3 | VERIFIED | SearchService: rg candidates + JS offsets engine, cancel, 6 unit tests |
| M4-03 | 替换预览与版本校验 | M4-02,M3-03 | VERIFIED | replace preview modal + per-file hash verification (E2E-004 + unit stale test) |
| M4-04 | LanguageServiceManager 与 Monaco bridge | M3 | VERIFIED | monaco TS worker project loading + registerEditorOpener + model sync |
| M4-05 | JS/TS LSP 能力与 Problems | M4-04 | VERIFIED | TS diagnostics/definition/rename-preview (E2E-005), Problems panel + status counts |
| M4-06 | Python 基础 LSP 与降级提示 | M4-04 | VERIFIED | Python LSP client (pylsp/pyright) + install guidance banner (E2E-006) |
| M4-07 | xterm + PTY 多终端、resize、process tree | M2 | VERIFIED | node-pty terminals: multi-tab/rename/kill-confirm/process-tree, no orphans (E2E-007) |

## Milestone 5: Git 与 ChangeService

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M5-01 | Git detect/status/diff | M3 | VERIFIED | GitService detect/status(porcelain v2)/diff incl. untracked (7 integration tests) |
| M5-02 | stage/unstage/discard/commit/branch | M5-01 | VERIFIED | stage/unstage/discard(confirm)/commit/branch UI + E2E-008 CLI parity |
| M5-03 | 内容寻址 blob store 与 file baseline | M2-03,M3-03 | VERIFIED | BlobStore content-addressed dedup + file_baselines capture-once (unit) |
| M5-04 | patch engine、base revision、atomic apply | M5-03 | VERIFIED | jsdiff patch engine, baseHash VERSION_CONFLICT, buffer-aware writeThrough (unit) |
| M5-05 | ChangeSet projection 与任务级净 Diff | M5-04 | VERIFIED | changeSet net projection collapsing intermediate patches (unit) |
| M5-06 | rollback engine 创建/修改/删除/重命名 | M5-03,M5-04 | VERIFIED | rollback engine + preflight external-change conflicts (CHG-010 unit) |
| M5-07 | 回滚矩阵测试 50 组 | M5-06 | VERIFIED | 34-case rollback matrix byte+mode identical (incl. CRLF/BOM/emoji/exec-bit/git) |

## Milestone 6: Pi 与只读 Agent

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M6-01 | 安装并精确锁 Pi SDK，建立 Adapter | M1-06 | VERIFIED | pi 0.80.6 exact-pinned; adapter with tools allowlist (3 contract tests incl. no-builtin-tools SECURITY) |
| M6-02 | Agent utility process 生命周期与 IPC | M2-02 | VERIFIED | utilityProcess worker + typed port protocol + ready handshake + supervisor |
| M6-03 | Provider/model/Secret Store/认证测试 | M6-01,M2-04 | VERIFIED | SecretService (safeStorage, masked hints) + models.list merged w/ configured flags |
| M6-04 | create/resume/prompt/steer/followUp/abort | M6-01,M6-02 | VERIFIED | createSession/startRun/steer/followUp/abort via worker protocol |
| M6-05 | Pi event → AgentEvent mapper 与 contract tests | M6-04 | VERIFIED | pi AgentSessionEvent→AgentEvent mapper (text-only deltas, usage, retry diagnostics) |
| M6-06 | Task domain、Ask 模式与 Timeline | M2-03,M6-05 | VERIFIED | TaskService state machine + event store + Ask flow + Timeline UI (E2E-009 a/b) |
| M6-07 | Worker crash/restart 与中断投影 | M6-02,M6-06 | VERIFIED | worker SIGKILL → INTERRUPTED + crash card + restart-scan (E2E-019 core, HIST-002 restart test) |

## Milestone 7: Tool Gateway 与权限

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M7-01 | Tool registry/schema/result contracts | M1-04 | VERIFIED | gateway registry + zod-strict + versioned catalog (M6, 9 tests) |
| M7-02 | read/list/search/symbol/diagnostic tools | M3,M4,M7-01 | VERIFIED | read/list/search/git R0 tools; get_symbols/get_diagnostics deferred P1 (LSP-007) |
| M7-03 | path policy 与 symlink/TOCTOU tests | M7-02 | VERIFIED | security-matrix.test.ts: symlink/dir-symlink/TOCTOU-swap/cwd-escape all fail closed (9 tests) |
| M7-04 | risk evaluator 与 permission state machine | M7-01 | VERIFIED | PermissionEngine once/task/workspace/always + R3-no-persist + PERM-007 rebind (15 tests) |
| M7-05 | 权限卡、一次/任务/Workspace scope | M7-04 | VERIFIED | PermissionCard §13.3 UI + AWAITING_PERMISSION flow + SQL store persistence (E2E-012 green) |
| M7-06 | structured command runner 与 classifier | M4-07,M7-04 | VERIFIED | classifier R2-R4 (17 tests) + runner tree-kill/timeout/minimal-env/redaction (11 tests) |
| M7-07 | R3/R4 security matrix 与 audit events | M7-03,M7-06 | VERIFIED | E2E-013 zero-side-effect refusal; audit rows for every DENIED/FAILED lifecycle |

## Milestone 8: Agent 写入与 Review

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M8-01 | Task plan schema、编辑、批准与历史 | M6-06 | VERIFIED | propose_plan/update_plan tools + plan-utils (5 tests) + PlanCard edit UI; E2E-011 |
| M8-02 | apply/create/delete tools 经 ChangeService | M5,M7 | VERIFIED | tools-write.ts + 10 unit tests (conflict/no-overwrite/R3-snapshot/ask-refusal) |
| M8-03 | Document Store 与 Agent patch 协调 | M3-03,M8-02 | VERIFIED | readLogical hash = baseHash contract; buffer-aware writeThrough; E2E-014 |
| M8-04 | Edit/Auto 模式与默认策略 | M8-01,M8-02 | VERIFIED | createPlanAwarePermission (AG-007 gate) + engine auto policy; unit + E2E-010 |
| M8-05 | Review 页面、文件/hunk 接受拒绝 | M5-05,M3-06 | VERIFIED | ReviewView + rejectHunk/revertFile (10 tests) + task.changeSet/reviewDecision IPC; E2E-015 |
| M8-06 | 三方冲突视图与恢复动作 | M3-05,M8-03 | VERIFIED | CHG_VERSION_CONFLICT ConflictCard + retry path; E2E-014 zero overwrite |
| M8-07 | 跨文件真实任务 E2E | M8 | VERIFIED | E2E-010: 3 files patched/created + npm test + accept → ACCEPTED |

## Milestone 9: 验证、报告与历史

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M9-01 | Verification config/project detector | M4,M7-06 | VERIFIED | VerificationService.detectSuggestions + NewTaskDialog suggestions/custom (VER-002) |
| M9-02 | verification runner/output/stale semantics | M9-01 | VERIFIED | run/superseded/stale/timeout + blob output_ref (7 unit tests); run_verification tool R2-recognized |
| M9-03 | Final Report 系统证据投影 | M5,M9-02 | VERIFIED | buildFinalReportData: changeSet/verification/denied-risks/git HEAD delta; agent narrative separated (§13.4) |
| M9-04 | REVIEW_READY/ACCEPTED/ROLLED_BACK 状态规则 | M8,M9-03 | VERIFIED | ACCEPT_NEEDS_CONFIRM (unverified), rollback preflight conflicts→blocked event; E2E-016/018 |
| M9-05 | 任务列表、筛选、归档、恢复 | M6-06,M2-03 | VERIFIED | filters/archive since M6; REVIEW_READY→IN_PROGRESS continue via startTask guard |
| M9-06 | 验证失败继续修复 E2E | M9-02,M8 | VERIFIED | E2E-017: fail→fix→pass, both records kept, old stale+superseded |

## Milestone 10: 恢复与诊断

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M10-01 | 应用重启未完成任务扫描与恢复页 | M9 | VERIFIED | INTERRUPTED 恢复入口（Home + AgentPanel Resume/Review/Roll back）+ 重启时孤儿 pending 权限在事件日志中取消；见 IMPLEMENTATION_STATUS.md M10 行 |
| M10-02 | Renderer/Worker/LSP/PTy crash injection | M6,M4 | VERIFIED | m10-recovery.spec 3 E2E（E2E-020/022 + renderer crash）；worker 孤儿防护（port close + ppid watchdog） |
| M10-03 | DB corruption/migration backup/read-only mode | M2-03 | VERIFIED | 启动安全模式（E2E m2-db-failure）+ 备份/校验（M2-03）+ disk-write-failure 单测 |
| M10-04 | 支持包生成与脱敏预览 | M2-05 | VERIFIED | diagnostics.supportBundle 脱敏支持包 |
| M10-05 | 50 次 soak task runner | M9 | VERIFIED | soak.spec 50-task run（opt-in），多次里程碑复跑（UX-ROOM-ENDING 亦过 50 laps） |
| M10-06 | 无孤儿进程与资源清理测试 | M4-07,M6-02 | VERIFIED | 有序 will-quit teardown（gates → worker → DB last）；孤儿防护见 M10-02 |

## Milestone 11: 安全、性能、隐私与可访问性

任务清单于 2026-07-18 按 **ADR-0025** 重定义：编号与 §16.4/16.5 + A11Y + PRIV 门槛锚定不变，
「交付」改写为对现有代码（盘点基线 `e81b72e`）的差距收口，并显式纳入 pivot 新增面；
新增 M11-07（隐私设置，原清单缺失项）。各项"已有底座"是现状记录，不是本任务交付物。

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M11-01 | Electron 硬化收口：@electron/fuses（afterPack）+ security-policy/preview-security 纯策略钉死 + `test:security` 双入口恢复 + CSP/导航/未知协议/恶意链接 e2e 矩阵 + 预览注入审计 | M2 | DONE | fuse-plan.cjs + after-pack.cjs；vitest.security.config.ts（14 文件 137 例）+ tests/security/{shell-hardening,secret-not-detectable}.spec + unit/{shell-policy,preview-boundary}；`npm run test:security` 全绿 |
| M11-02 | 秘密不可检出四路验收（heap snapshot/localStorage/日志/支持包）+ secret scanning（provider keychain、外部 CLI 转录、附件路径）+ repo/CI 扫描闸 | M6-03,M10-04,M11-01 | DONE | secret-not-detectable.spec（CDP 堆快照 + reload 不水合）；foundation `findSecrets` + scripts/secret-scan.mjs（进 test:security）；unit secret-scan 8 例 |
| M11-03 | 性能 fixture 与 `test:perf` 入口：50k 文件 / 1GiB 文本生成器 + vitest.perf.config.ts + §16.5 算法 harness | M3,M6 | DONE | createLargeTreeFixture(50k)/createLargeTextFixture(1GiB stream)；tests/perf/{tree-scan,search,timeline-projection}.perf；6 例全绿，PI_IDE_PERF_FULL 50k 验证 |
| M11-04 | RoomTimeline 万级事件窗口化（400 尾 + load-earlier）+ 流式 buffer 背压 + 大输出冻结门 | M11-03 | DONE | timeline-window.ts（computeWindow/growWindow/initialWindow + STREAM_*）；unit 9 例 + timeline-window.spec e2e；store append 封顶 256KB + 渲染 16KB plain-tail |
| M11-05 | 可访问性：真窗口缩放 80–200%（Monaco/终端）+ 无障碍 Diff 文本模式（F7/⇧F7 + aria-live）+ 键盘流 + A11Y-004 live region | M11-04 | DONE | ui-zoom.ts（webContents.setZoomFactor，菜单 ⌘±/⌘0，Settings 段）；accessible-diff.ts + SessionToolCanvas 文本模式；活动条 role=status；unit 10 + a11y-zoom-diff.spec |
| M11-06 | 安全与性能门槛报告：§16.4/16.5/A11Y/PRIV 全项对照 + npm audit + 未达项分析 | M11-01..05,M11-07 | DONE | docs/M11_SECURITY_PERFORMANCE_REPORT.md；ADR-0027；npm audit 1 low+1 moderate（DOMPurify/monaco，已缓解，无 Critical/High） |
| M11-07 | 隐私设置落地（PRIV-001..003）：诚实降级（无传输 banner，规则 9）+ 字段先行 + 真实脱敏崩溃预览 + 本地数据面板 + 一键删除历史/缓存 | M2-04,M10-04 | DONE | privacy-service.ts（dataSummary/crashPreview/clearHistory 三通道）+ SettingsView PrivacySection；unit 3 例 + privacy-settings.spec；impl-shots 三张 |

## Milestone 12: 安装、更新与 Stable

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M12-01 | macOS/Windows/Linux package pipelines | M10,M11 | NOT_STARTED |  |
| M12-02 | 签名/公证配置与 secrets procedure | M12-01 | NOT_STARTED |  |
| M12-03 | Stable/Beta update channels 与 rollback | M12-01,M2-03 | NOT_STARTED |  |
| M12-04 | SBOM、第三方许可证、隐私与用户文档 | M12-01 | NOT_STARTED |  |
| M12-05 | 干净机器安装/升级/卸载矩阵 | M12-03 | NOT_STARTED |  |
| M12-06 | E2E-001..024 与 Release Gates 全量 | 全部 | NOT_STARTED |  |
| M12-07 | Beta 修复、RC 冻结、Stable 发布 | M12-06 | NOT_STARTED |  |

## 完成规则

- `DONE`：代码与测试已提交，但尚未通过对应 Milestone 退出条件。
- `VERIFIED`：自动化和人工验收均通过，证据已记录。
- 任一 P0 缺陷、数据丢失、安全越界或无法恢复的迁移问题会阻止后续 Stable。
- Claude Code 不得把所有任务一次性标 DONE；每项需要可定位提交和测试。

## 未排期 backlog（记录，不承诺）

- **Best-of-N**（ADR-0009 am.2 调研结论）：同一 charter 用 N 个模型在 N 个隔离 worktree 并行执行，结果并排比较后选优落地。现有 worktree/任务架构天然支持；未排期。
- **PR/远端集成**：明确不做（本地 apply 派定位，ADR-0013）。
- **Merged worktree 任务的事后回滚**（"revert merge"）：ACCEPTED 后 worktree 已丢弃，需要基于 change-set 快照对主树做反向应用；当前给出明确提示（ADR-0012 记录限制）。
- **Gutter 变更条对未保存 buffer 的实时 diff**：当前保存后刷新（ADR-0013 记录取舍）。
