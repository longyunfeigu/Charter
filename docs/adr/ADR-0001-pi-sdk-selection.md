# ADR-0001: Pi SDK 选型与锁定

- 状态：Accepted
- 日期：2026-07-12
- 关联需求：AG-013、§8 全部、M6-01

## 背景

规格 §8.1 指定依赖 `@earendil-works/pi-coding-agent`。npm 上该包真实存在（earendil-works/pi monorepo，MIT），
按规格预期拆分为 `pi-agent-core` / `pi-ai` / `pi-tui`，SDK 提供 `createAgentSession`、`AgentSession`（subscribe/prompt/steer 语义）、
`AuthStorage`（含 InMemory 后端）、`ModelRegistry`、`SessionManager`、`ToolDefinition` 注入等能力。

## 决策

1. 精确锁定 `@earendil-works/pi-coding-agent@0.80.6`（engines: node>=22.19，Electron 43 内置 Node 24.18 满足）。
2. Adapter 通过 `createAgentSession({ noTools: 'all', customTools: [...] })` 完全禁用 Pi 内置 read/bash/edit/write，
   只注入产品 Tool Gateway 代理工具 —— Pi 进程内不存在任何直接文件/命令执行路径（TOOL-001 的实现基础）。
3. `AuthStorage` 使用内存后端，由产品 Secret Store 在 Worker 启动时注入凭据；Pi 不落盘任何密钥。
4. `SessionManager` 指向 AppData/runtime 下的产品管理目录；Pi session 文件仅作为恢复引用（HIST-003）。
5. `cwd` 传入产品控制的目录：未信任项目一律传空目录，阻止 Pi 自动发现项目扩展/技能（AG-014）。

## 替代方案

- 直接调用各 Provider SDK：放弃，规格明确 Pi 为第一 Runtime。
- Fork Pi：无必要，公开 API 满足全部已编号需求。

## 安全与数据影响

Pi 无内建权限隔离（官方声明），本决策把工具面收敛到产品网关，是 §12 威胁模型的前提。

## 验证证据

- packages/agent-runtime-pi 的 contract tests（M6）。
- 边界 lint：仅 agent-runtime-pi 可 import `@earendil-works/*`（scripts/check-boundaries.mjs + tests/unit/boundaries.test.ts）。
