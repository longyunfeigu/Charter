# ADR-0038: 会话考古 — 发现并收编 Charter 之外的 CLI 会话

- Status: Accepted (user decision 2026-07-20，mockup 浏览器验收：
  `docs/design/session-archaeology-mock.html`，用户选定"完善版"归属语义)
- 日期: 2026-07-20
- Relates to: ADR-0017 (外部 CLI 会话 + 撤回 hooks-capture 的边界教训)、
  ADR-0015/0019 (外部根只读发现模式)、ADR-0028 (项目记忆投影)、
  ADR-0029 (单项目树/Projects 面板)、ADR-0030 (外部会话单输入口)

## 背景

用户的 agent 工作一半发生在 Charter 之外：iTerm 里随手启动的 Claude Code、
Codex。这些会话的 transcript 完整躺在 CLI 自己的存储里——
`~/.claude/projects/<munged cwd>/<uuid>.jsonl`（按启动目录分文件夹，条目内
带 `cwd` 字段）与 `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
（按日期分，首行 `session_meta.payload.cwd`）——但 Charter 只认自己终端里
启动的会话。零件其实全齐：`cli-session-locator` 已实现 munge 规则、UUID 安
全校验与时间窗匹配；`externalResumeCommand` 已能生成
`claude --resume <id>` / `codex resume <id>`；`createExternalTask` +
entry-snapshot 语义已定义"外部会话如何诚实入账"。本 ADR 把它们接成产品能力：
**Charter 从「记录在 Charter 里发生的事」升级为「用户全部 agent 活动的家」。**

核心用户故事：三天前在 iTerm 里让 claude 干到一半的活，今天在 Charter 的
Projects 面板顺路看见「N outside」，点进考古页凭自己说的第一句话认出它，
一键 ▶ Resume 接着干——结算、审阅、回滚全套生效。

## 决策

1. **只读发现服务 `SessionArchaeologyService`**（`services/session-archaeology.ts`）。
   启动目录级扫描：Claude 枚举 `~/.claude/projects/*/`（uuid 文件名过滤）；
   Codex 走近 30 天日期窗口。每个 transcript 全文解析一次，按
   (path, mtime, size) 内存缓存，重扫只重读变化文件；>50MB 文件跳过并记日志。
   绝不写入这两个目录（ADR-0017 hooks-capture 撤回的边界教训延续）。
   E2E 遵循 ADR-0015/0019 模式：只扫 `PI_IDE_ARCHAEOLOGY_HOME` 指定的假
   home，`PI_IDE_E2E` 下无假 home 即整体禁用（`enabled:false`，渲染端隐藏
   全部考古表面）。
2. **transcript 归纳**（纯函数 `parseClaudeTranscript` / `parseCodexRollout`）：
   标题 = CLI 自己的 `ai-title`（如有）否则第一条真人消息（跳过
   `<command-*>` 包装、`Caveat:` 前言、tool_result 回执、sidechain 子代理
   分支）；改动文件 = Claude 的 Edit/Write/MultiEdit/NotebookEdit tool_use
   与 Codex 成功的 `patch_apply_end.changes`；skills = `Skill` tool_use；
   0 真人回合的 transcript 视为噪音不列出。
3. **归属：做过什么 > 从哪启动**（`attributeProject`）。cwd 落在某项目路径
   下（含子目录前缀匹配，最内层项目优先）→ `attribution:'cwd'`；否则按
   改动文件的绝对路径投票，得票最多的项目胜 → `'files'`（覆盖"在 home 随手
   开 claude 改了 bullpen"场景）；都不中 → `'none'`，按真实 cwd 诚实展示在
   「Agent activity」组，绝不硬塞。
4. **去重**：`TaskService.externalSessionIndex()`（全部 external 任务的
   conversation id → taskId，小写归一）。已被 Charter 记录的会话带
   `trackedTaskId` 列为 Tracked（只能 Open，不能二次收编）。
5. **通道**（v1，均 strict）：`archaeology.scan`
   （`{}` → `{ sessions≤500, scannedAt, enabled }`）；`archaeology.adopt`
   （`{ cli∈{claude,codex}, sessionId:UUID正则, terminalId }` →
   `{ taskId, terminalId, cli }`）。adopt 由主进程从发现缓存反查 cwd/标题，
   **渲染器永远不传原始路径**；未发现/已跟踪分别拒绝
   （`ARCHAEOLOGY_SESSION_UNKNOWN` / `_TRACKED`）。
6. **收编 = 两段式 resume**。渲染端先以新 context kind
   `{ kind:'archaeology', cli, sessionId }` 建终端（host 从发现缓存解析
   cwd，`TerminalInfo.contextKind` 落为 `recent` 语义）；再调
   `archaeology.adopt`：`ExternalSessionService.adopt()` 取 entry snapshot
   （git 项目 `snapshotTree`，失败降级 first-seen）→ `createExternalTask`
   （未知目录经 `workspaceRowForPath` 自动注册为项目）→
   `setExternalSessionId` → 记 `external.sessionAdopted` 事件 → 复用与
   settled-continuation 完全相同的尾部
   （`startResumedSession`，自 `resume()` 提取）：LiveSession/watcher/广播/
   12s 检测窗/延迟 350ms 注入 resume 命令。**CLI 未启动 → 任务退役
   （archive），RPC 报 `EXTERNAL_RESUME_NOT_DETECTED`**——失败路径与既有
   续接完全一致。账本诚实：收编前的一切改动不入 diff 基准。
7. **渲染端表面**：`archaeologyStore`（60s 新鲜度的 scan 缓存 + 单飞
   adopt）；Projects 面板项目行小字追加「· N outside」+ 每行 🕘 入口；面板
   底部「Agent activity」（列出从未在 Charter 打开过的目录，含 CLI 徽标/
   次数/最近时间）；主区域新 surface `ArchaeologyView`
   （HomeShell 分支，appStore.archaeology `{scope}`，scope=项目路径/发现
   目录/null=全机），行含 provider 徽标、标题、External/Tracked 药丸、
   文件数/skills/相对时间、Resume(或 Open) 动作；空/加载/禁用态齐备。

## 替代方案

- **反解 munged 目录名得项目路径**：munge 有损（`-` 吞掉一切非字母数字），
  弃用；改读 transcript 内的 `cwd` 字段，零猜测。
- **后台 file-watcher 常驻实时发现**：V1 用"打开 Projects 面板即扫 + 手动
  Rescan + 60s 新鲜度"，避免常驻监听两个外部大目录；缓存已让重扫近乎免费。
  实时性不足再升级。
- **收编时把历史对话导入房间时间线（mock 屏③的灰显区）**：需要把
  external-replay-parser 扩展为 transcript 渲染器并新增只读回合类型，
  V1 不含；先靠 CLI 自己的 TUI 在终端里回显历史。同理「View 只读回放」
  按钮 V1 不做，列表元数据（标题/文件/skills）已覆盖大部分辨认需求。
- **archaeology 专用 contextKind 贯穿 TerminalInfo**：会波及既有
  contextKind 枚举的所有消费者；收编终端本质是"项目终端"，落为 `recent`
  语义即可，contract 的 context 请求侧仍是独立 kind（host 解析路径）。

## 安全与数据影响

- 新能力面（读）：主进程读 `~/.claude/projects`、`~/.codex/sessions` 的
  目录名与文件内容——均为用户自己的数据，纯只读，任何 fs 错误降级为
  "未发现"。E2E 永不触碰真实 home。
- 新能力面（写）：`archaeology.adopt` 最终向 PTY 写入
  `claude --resume <uuid>` / `codex resume <uuid>`——uuid 三重校验
  （channel 正则、发现缓存反查、`isSafeCliSessionId`），命令模板与既有
  resume 共用 `externalResumeCommand`，无自由文本注入面。
- 终端 cwd 由 host 从发现缓存解析（`archaeology` context kind），渲染器
  无法借此在任意路径开终端。
- 收编创建的任务/事件走既有 external 任务持久化，无 schema 迁移。

## 迁移/回滚

无持久化 schema 变更。回滚 = 移除通道注册、服务构造与渲染端表面；已收编
的任务是普通 external 任务，回滚后依然有效。

## 验证证据

- `apps/desktop-main/src/services/session-archaeology.test.ts`：9 例——
  Claude 归纳（标题跳过 Caveat/命令包装/工具回执、sidechain 过滤、
  ai-title 优先、半行容错）、Codex 归纳（meta/成功补丁）、归属
  （cwd 最内层优先 / files 投票 / none 诚实）、fs 扫描（双存储、相对化、
  tracked 去重、非 uuid 与 0 回合过滤、日期窗、disabled）。
- `apps/desktop-main/src/services/terminal-file-open.test.ts` 原样通过
  （resume 重构未触及）。
- `packages/ipc-contracts/src/channels.test.ts`：adopt 请求
  （uuid 正则拒注入、cli 枚举、strict）、terminal.create archaeology
  context（无原始路径）。
- `apps/desktop-renderer/src/store/archaeologyStore.test.ts`：scope 匹配
  （项目/前缀/兄弟目录不误伤）、未知目录分组、扫描新鲜度。
- `npm run check` 与全量 `npm run test` 通过（见 IMPLEMENTATION_STATUS）。
- 待补（记录为后续项）：E2E 假 home fixture 走通"发现→收编→房间"整链；
  收编房间内嵌只读历史（mock 屏③）；View 只读回放。
