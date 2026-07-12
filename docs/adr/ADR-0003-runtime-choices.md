# ADR-0003: 运行时基础设施选型（SQLite / PTY / ripgrep / 构建链）

- 状态：Accepted
- 日期：2026-07-12
- 关联需求：REL-003、TERM-002、SRCH-005、§9.1

## 决策与理由

1. **SQLite = `node:sqlite`（Node 24 内建，Electron 43 验证可用）**
   替代 better-sqlite3。消除原生模块 ABI/重编译风险；同步 API + WAL + 事务满足 REL-003。
   持久层封装在 `@pi-ide/persistence`，接口不暴露 node:sqlite 类型，必要时可换实现。
2. **PTY = node-pty@1.1.0（N-API + darwin/win 预编译）**
   实测其 prebuilt 二进制在 Electron 43 主进程直接可用（N-API 与 ABI 无关）。
   npm 会丢失 spawn-helper 的可执行位 —— `scripts/postinstall.mjs` 修复，已验证 PTY spawn 正常。
3. **ripgrep：解析顺序 = env 覆盖 → @vscode/ripgrep 二进制 → 系统 PATH 中的 rg → JS 兜底扫描器**
   本机网络无法访问 GitHub Releases（@vscode/ripgrep 的下载源），系统已有 rg 14.1.1。
   SRCH-005 允许"受控 ripgrep 子进程或等价实现"；JS 兜底保证无 rg 环境功能不缺失（性能降级并提示）。
4. **构建链：esbuild（main/preload/worker 三 bundle）+ Vite（renderer）+ vitest + Playwright(_electron)**。
   Preload 以 CJS 打包（sandbox 要求）；Worker 以 ESM 打包、Pi SDK 保持 external（其为 ESM+wasm 资产）。
5. **网络镜像**：electron 二进制与 electron-builder 资源走 npmmirror（.npmrc），因 GitHub 直连不可用。

## 迁移/回滚

persistence 接口稳定，切换 better-sqlite3 只需替换 driver 文件；PTY 失败时终端功能降级为 pipe 模式并明确提示。
