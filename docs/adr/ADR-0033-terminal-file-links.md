# ADR-0033: 终端文件链接 — ⌘+单击直接用系统浏览器打开 HTML

- Status: Accepted (user decision 2026-07-20，HTML mockup 浏览器验收：`docs/design/terminal-file-link-mock.html`，选定「⌘+单击 + 系统默认浏览器」)
- 日期: 2026-07-20
- Relates to: ADR-0021 (终端块模型), ADR-0030 (外部会话单输入口), §12.3 (导航/外链安全策略)

## 背景

Claude Code / Codex 在内嵌终端里完成任务后常提示"在浏览器中打开
rocket.html 就能看到效果"。该文件名只是终端文本（Claude Code 新版会附带
OSC 8 `file://` 超链接），点击行为完全由承载终端决定：产品终端此前只挂
`WebLinksAddon`（仅正则识别 http/https），而其默认激活走 `window.open` ——
被 §12.3 的 `setWindowOpenHandler` 全量拒绝。结果是**文件 token 完全不可
点，连普通网页链接点了也没反应**。用户裁定：⌘+单击文件 token，HTML 直接
用系统默认浏览器打开。

## 决策

1. **新通道 `terminal.openPath`**（v1，schema:
   `{ id, path }` → `{ action: 'external'|'editor', path, workspacePath }`）。
   主进程按终端 id 找到**该终端自己的 launch cwd**，token 归一化
   （`cwdRelativeToken`：绝对路径必须已在 cwd 内，否则拒绝）后经
   `resolveInsideRoot` 做与工作区路径相同的词法+符号链接封禁（WS-010），
   再要求 stat 为普通文件。
2. **浏览器/编辑器分流**：扩展名在
   `TERMINAL_EXTERNAL_OPEN_EXTENSIONS`（.html/.htm/.xhtml/.svg/.pdf，契约包
   导出，双端共用）内 → `shell.openExternal(pathToFileURL(abs))` 系统默认
   浏览器；其余返回 `editor` 动作，渲染器经既有 `doc.open`/`revealPosition`
   在 Monaco 打开（带 `:行号` 时跳行），不在焦点工作区内则 toast 说明。
3. **识别双轨**：xterm `linkHandler`（`allowNonHttpProtocols: true`）处理
   OSC 8 超链接——`file://` 走 `terminal.openPath`，http(s) 走既有
   `app.openExternal`（https-only 允许清单）；`registerLinkProvider` 正则兜底
   识别裸 token（`rocket.html`、`src/foo.ts:12`、`./out/index.html` 等，
   扩展名必须字母开头，杜绝 `v1.0`/`3.5` 误报；URL 粘连 token 排除）。宽字符
   （CJK）行经 `readBufferLine` 做字符串索引↔buffer 列映射，中文前缀不错位。
   `WebLinksAddon` 的激活函数替换为同一 https 通道——**顺带修复了网页链接
   点击无响应的存量缺陷**。
4. **交互**：激活一律要求 ⌘/Ctrl 修饰键（不与选中文本冲突）；未按修饰键
   点击给节流 toast 教学；hover 显示「⌘+click to open in browser/editor」
   浮层（`.terminal-link-hint`），提示文案由共享扩展名清单推导，与主进程
   行为恒一致。
5. **handler 落位**：`ipc/terminal-open-handlers.ts` 独立注册（m4-handlers
   被 vitest 直接 import，须保持 electron-free）；纯逻辑
   （`terminalOpenAction`/`cwdRelativeToken`）在 `services/terminal-file-open.ts`
   单测覆盖。

## 替代方案

- **直接单击激活**：与终端选择文本手势冲突，且误触面大——mockup 验收中用户
  选定 ⌘+单击。
- **内置 Live Preview 面板打开 HTML**：用户选定系统浏览器；Live Preview 仍可
  作为后续增强（右键菜单等），不在本 ADR 范围。
- **给 file:// 开 `app.openExternal` 白名单**：会把"任意本地文件"暴露给所有
  渲染器调用方（包括 Markdown 锚点），放弃；`terminal.openPath` 把能力绑定在
  具体终端的 cwd 封禁内，面小得多。

## 安全与数据影响

- 新增能力面：渲染器可请求主进程用系统默认应用打开**该终端 cwd 内**的
  白名单扩展名文件。路径逃逸（`..`、绝对路径、符号链接）在 `cwdRelativeToken`
  + `resolveInsideRoot` 双层拒绝；目录与不存在路径拒绝；错误均为 ProductFailure
  语义化文案。
- `window.open` 拒绝策略、https-only 外链允许清单均未放宽。
- 已知限制（可接受并记录）：cwd 取 launch cwd，用户在 shell 里 `cd` 后不跟踪
  （agent 终端不移动 cwd）；跨行折行的长路径 token 不识别（OSC 8 链接不受
  影响）；Windows 的 `file://` pathname 形态（`/C:/…`）留待打包里程碑校准。

## 迁移/回滚

无持久化数据。回滚 = 移除通道注册与渲染器接线，`WebLinksAddon` 恢复默认
构造（回到"链接点击无响应"的旧状）。

## 验证证据

- `packages/ipc-contracts/src/channels.test.ts`：openPath 请求 schema（strict、
  长度上限、拒绝多余字段）。
- `apps/desktop-main/src/services/terminal-file-open.test.ts`：分流大小写、
  `.html.bak` 不入浏览器、绝对路径含入/逃逸/cwd 自身、空 token。
- `apps/desktop-renderer/src/views/terminal-file-links.test.ts`：11 例——裸
  token（截图场景「在浏览器中打开 rocket.html」）、相对/绝对/`~`/盘符路径、
  `:line:col`、点分文件名、标点包裹、版本号/纯文本零误报、URL 粘连排除、
  CJK 宽字符列映射。
- `npm run check` 与全量 `npm run test`（78 文件 / 641 用例）通过。
