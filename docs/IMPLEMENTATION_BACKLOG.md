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
| M5-01 | Git detect/status/diff | M3 | NOT_STARTED |  |
| M5-02 | stage/unstage/discard/commit/branch | M5-01 | NOT_STARTED |  |
| M5-03 | 内容寻址 blob store 与 file baseline | M2-03,M3-03 | NOT_STARTED |  |
| M5-04 | patch engine、base revision、atomic apply | M5-03 | NOT_STARTED |  |
| M5-05 | ChangeSet projection 与任务级净 Diff | M5-04 | NOT_STARTED |  |
| M5-06 | rollback engine 创建/修改/删除/重命名 | M5-03,M5-04 | NOT_STARTED |  |
| M5-07 | 回滚矩阵测试 50 组 | M5-06 | NOT_STARTED |  |

## Milestone 6: Pi 与只读 Agent

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M6-01 | 安装并精确锁 Pi SDK，建立 Adapter | M1-06 | NOT_STARTED |  |
| M6-02 | Agent utility process 生命周期与 IPC | M2-02 | NOT_STARTED |  |
| M6-03 | Provider/model/Secret Store/认证测试 | M6-01,M2-04 | NOT_STARTED |  |
| M6-04 | create/resume/prompt/steer/followUp/abort | M6-01,M6-02 | NOT_STARTED |  |
| M6-05 | Pi event → AgentEvent mapper 与 contract tests | M6-04 | NOT_STARTED |  |
| M6-06 | Task domain、Ask 模式与 Timeline | M2-03,M6-05 | NOT_STARTED |  |
| M6-07 | Worker crash/restart 与中断投影 | M6-02,M6-06 | NOT_STARTED |  |

## Milestone 7: Tool Gateway 与权限

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M7-01 | Tool registry/schema/result contracts | M1-04 | NOT_STARTED |  |
| M7-02 | read/list/search/symbol/diagnostic tools | M3,M4,M7-01 | NOT_STARTED |  |
| M7-03 | path policy 与 symlink/TOCTOU tests | M7-02 | NOT_STARTED |  |
| M7-04 | risk evaluator 与 permission state machine | M7-01 | NOT_STARTED |  |
| M7-05 | 权限卡、一次/任务/Workspace scope | M7-04 | NOT_STARTED |  |
| M7-06 | structured command runner 与 classifier | M4-07,M7-04 | NOT_STARTED |  |
| M7-07 | R3/R4 security matrix 与 audit events | M7-03,M7-06 | NOT_STARTED |  |

## Milestone 8: Agent 写入与 Review

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M8-01 | Task plan schema、编辑、批准与历史 | M6-06 | NOT_STARTED |  |
| M8-02 | apply/create/delete tools 经 ChangeService | M5,M7 | NOT_STARTED |  |
| M8-03 | Document Store 与 Agent patch 协调 | M3-03,M8-02 | NOT_STARTED |  |
| M8-04 | Edit/Auto 模式与默认策略 | M8-01,M8-02 | NOT_STARTED |  |
| M8-05 | Review 页面、文件/hunk 接受拒绝 | M5-05,M3-06 | NOT_STARTED |  |
| M8-06 | 三方冲突视图与恢复动作 | M3-05,M8-03 | NOT_STARTED |  |
| M8-07 | 跨文件真实任务 E2E | M8 | NOT_STARTED |  |

## Milestone 9: 验证、报告与历史

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M9-01 | Verification config/project detector | M4,M7-06 | NOT_STARTED |  |
| M9-02 | verification runner/output/stale semantics | M9-01 | NOT_STARTED |  |
| M9-03 | Final Report 系统证据投影 | M5,M9-02 | NOT_STARTED |  |
| M9-04 | REVIEW_READY/ACCEPTED/ROLLED_BACK 状态规则 | M8,M9-03 | NOT_STARTED |  |
| M9-05 | 任务列表、筛选、归档、恢复 | M6-06,M2-03 | NOT_STARTED |  |
| M9-06 | 验证失败继续修复 E2E | M9-02,M8 | NOT_STARTED |  |

## Milestone 10: 恢复与诊断

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M10-01 | 应用重启未完成任务扫描与恢复页 | M9 | NOT_STARTED |  |
| M10-02 | Renderer/Worker/LSP/PTy crash injection | M6,M4 | NOT_STARTED |  |
| M10-03 | DB corruption/migration backup/read-only mode | M2-03 | NOT_STARTED |  |
| M10-04 | 支持包生成与脱敏预览 | M2-05 | NOT_STARTED |  |
| M10-05 | 50 次 soak task runner | M9 | NOT_STARTED |  |
| M10-06 | 无孤儿进程与资源清理测试 | M4-07,M6-02 | NOT_STARTED |  |

## Milestone 11: 安全、性能、隐私与可访问性

| 任务 | 交付 | 依赖 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| M11-01 | Electron CSP/navigation/sandbox/fuses hardening | M2 | NOT_STARTED |  |
| M11-02 | Secret scanning、日志/支持包脱敏 | M6-03,M10-04 | NOT_STARTED |  |
| M11-03 | 50k files/10k events 性能 fixtures | M3,M6 | NOT_STARTED |  |
| M11-04 | 虚拟化、背压、输出限制、取消优化 | M11-03 | NOT_STARTED |  |
| M11-05 | 键盘、焦点、ARIA、缩放、accessible diff | M3,M8 | NOT_STARTED |  |
| M11-06 | 安全与性能门槛报告 | M11 | NOT_STARTED |  |

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
