# ADR-0047: 内置 SSH 连接管理器（ssh2 选型、凭据与 host key 安全模型）

- 状态：Accepted
- 日期：2026-07-23
- 关联需求：TERM-002/TERM-005（终端安全域）、§11.1（settings 非敏感）、SEC 系列（凭据边界）；UI 依据 `docs/design/ssh-mockups/b-connection-manager.html`（用户已确认）

## 背景

用户需要在产品内管理 SSH 远程主机并在远端跑 claude/codex CLI（核心场景），后续叠加 SFTP 与端口转发。两条本质路线：spawn 系统 `ssh` 二进制（OpenSSH 全兼容但无法程序化管理密码/复用连接开 SFTP/转发通道），或引入 `ssh2` 纯 JS 协议库（程序化认证 + 单连接多路复用，electerm/SimpleShell 已验证 node-pty+ssh2 混合架构）。产品选定后者（方案 B）。

## 决策

1. **协议层 = `ssh2@1.17.0`（精确钉扎，运行时依赖仅 asn1/bcrypt-pbkdf，均纯 JS）。**
   新包 `@pi-ide/ssh-service` 持有连接生命周期/认证编排/host key 信任/ssh_config 导入；仅被
   desktop-main 消费，esbuild main bundle 将 `ssh2` 列为 external。
2. **可选 native 加速器 `cpu-features` 不进入发行版。**
   electron-builder files 排除 `node_modules/cpu-features/**` 与 `node_modules/nan/**`，打包产物
   永远走 ssh2 的纯 JS 回退（无 Electron ABI 风险、无三平台 prebuild 依赖）。本机 dev/CI 上它
   即使被构建出来，在 Electron 内加载失败也会被 ssh2 try/catch 吞掉，行为一致。
3. **终端接入 = TerminalManager 的 backend 接缝，不建并行会话体系。**
   `TerminalBackend` 接口（write/resize/kill/hasChildren/processTitle/onData/onExit/injectData）
   由 PtyBackend（现有 node-pty 路径，行为不变）与 SSH shell channel 适配器
   （`apps/desktop-main/src/services/ssh-terminal-bridge.ts`）分别实现；`adoptBackend()` 让远程
   会话进入同一 sessions Map，terminal.data/write/resize/kill/list 的 IPC 契约与 renderer 管线
   全部复用。terminal-service 不 import ssh2。
4. **凭据模型：主机元数据（host/port/user/keyPath/tags）进 `settings.ssh`（非敏感，§11.1）；
   密码与私钥 passphrase 进独立 `SshVaultService`**（safeStorage/OS keychain 加密，目录
   `userData/secrets/ssh/`，文件 `host-<id>-{password|passphrase}.bin` + 非敏感 `.bin.meta`）。
   不扩展 provider 专用的 SecretService（其 kind:'api-key' 语义与列表扫描面保持干净）。
   **方向性不变量：秘密只允许 renderer→main（用户键入或 main 内解密使用）；所有 ssh.* 响应与
   事件 schema 不含 secret 字段；日志不落 value。** test:security 有静态断言与 logger spy 覆盖。
5. **Host key 信任：TOFU + known_hosts 只读参考。**
   校验顺序 = 产品信任库 `userData/ssh/trusted-hosts.json` → 只读解析 `~/.ssh/known_hosts`
   （明文与 `|1|` HMAC 哈希行；解析失败一律按未知处理，永不误判已信任）→ 未知则弹窗展示
   SHA256 指纹由用户决定（可记住）。**指纹不匹配走独立告警弹窗，不提供一键继续。**
   keyboard-interactive/2FA/密码提示统一经 requestId 桥接到 renderer 模态。
6. **主进程读 `~/.ssh`（config/known_hosts/IdentityFile）与 tool-gateway R4 规则的边界：**
   R4（读 ~/.ssh 归高危）约束的是 **agent 工具调用路径**；本功能是用户显式发起的主进程服务
   行为，不经过 Tool Gateway，二者安全域不同。SshVaultService/ssh-service 仅读取用户在 UI 中
   指定的路径，私钥内容仅在 main 进程内存中用于握手。
7. **重连语义：传输层自动重连（指数退避 1/2/4/8/15s、上限 6 次、可关），shell channel 不自动
   重生**（远端进程已死，不伪造会话延续）。连接断开时会话注入 `[ssh: connection lost]` 提示行
   后正常退出；Reconnect = 创建同主机同 launch 的新会话。连接引用计数归零后 idle 5 分钟断开。
8. **远程 claude/codex：launch × target 正交。** `terminal.create` v4 增加
   `target:{kind:'ssh',hostId}`；远端经 `$SHELL -lc 'command -v <cli>'` 探测（仅 advisory），
   命中后在 shell channel 写入 `cd + exec <cli>`（exec 保证 CLI 退出即会话退出，knownAgent
   状态不说谎）；未命中降级为普通远程 shell 并提示安装。已知限制（记录）：远程纯 shell 中手动
   启动的 agent 不会被检测（本机进程探测对远端不可见）；远程会话无 --session-id/archaeology。

## 替代方案

- **spawn 系统 ssh**：OpenSSH 配置零成本兼容，但密码/passphrase 无法走 keychain 注入、SFTP 与
  动态端口转发无法复用同一连接程序化管理，与方案 B 的产品形态冲突。保留为潜在降级路径。
- **扩展 SecretService**：省一个服务，但污染 provider 语义（list 扫描、kind 校验、worker 凭据
  热路径），审计面变差。否决。

## 安全与数据影响

- settings.json 仅新增非敏感 `ssh` section（不进 workspace 覆盖白名单）；密文只在
  `userData/secrets/ssh/`；信任库在 `userData/ssh/trusted-hosts.json`。
- 新 IPC 通道 `ssh.*` 全部 zod 版本化契约；renderer 仅见 `hasPassword/hasPassphrase` 布尔。
- release 门禁：ssh2 依赖树 audit 干净（引入时 `npm audit --audit-level=high` 为 0）；
  锁文件中 Pi SDK shrinkwrap shadow 条目的手工钉扎流程不受影响（本次引入时已按
  既定流程重新修补 brace-expansion@5.0.7 / protobufjs@7.6.5 两条 shadow 条目）。

## 迁移/回滚

功能自包含：移除 `ssh` settings section 与新通道即可整体回退，不触及既有终端/agent 数据。
ssh2 若出现不可接受缺陷，backend 接缝允许把远程会话切换为 spawn 系统 ssh 的 PtyBackend
变体（丢失密码注入与单连接多路复用，UI 不变）。

## 验证证据

- 单测：ssh2 自带 Server 起 loopback 假 sshd（密钥运行时生成，不入库），覆盖认证三态、
  TOFU/mismatch、断线重连状态机、shell 数据回环；terminal-service FakeBackend 回归。
- e2e：Playwright 下起本地假 sshd 走「新建主机→TOFU→密码→终端→远程 claude→断线→重连」全流程。
- test:security：schema 静态断言（无 secret 字段）、logger spy（无 secret 子串）、
  settings.json 落盘断言（无密码）。

---

## 修订 · 2026-07-23（验收反馈 + PR2/PR3）

### D9 · 连接生命周期修正（验收 bug）

原实现 idle 断开为 5 分钟，会话全部退出后卡片长时间仍显示 `connected`（用户截图反馈）。
改为：

- **idle 宽限 10 秒**：channel 与 hold 均归零后 10s 断开传输层，卡片及时回到可 `Connect`。
- **hold 引用计数**：SFTP 通道、活跃转发、被跳板依赖的连接各持一个具名 hold；`channels` 与
  `holds` 同时为空才算 idle。这样一个开着的文件面板 / 活跃转发不会让连接假性断开。
- **断线重连门控**：传输层丢失后，仅当存在 hold（转发/SFTP/跳板依赖）时才指数退避重连；
  否则直接 `disconnected`——纯终端会话无法随传输复活，重连没有意义，卡片显示 `Connect` 才诚实。
- **disconnect 显式关闭每个 channel**：`client.end()` 不保证在 socket 拆除前对每条 channel
  发 close，故 disconnect 先逐条 `channel.close()`，保证每个会话确定性退出（多会话尤为关键）。

### D10 · Remotes 卡片交互重做（验收反馈）

- 去掉卡片上的 **Open Claude / Open Codex** 独立按钮；主操作为 **Connect / + New Session**
  （开 shell），旁边下拉 caret 选择 Shell / Claude / Codex——一个 remote 多路复用任意多个会话。
- 卡片列出该 host 的活跃会话（点击聚焦），底部状态行反映真实会话数 / 转发态。
- `Files`（SFTP）与 `Forwards`（端口转发）入口进卡片。

### D11 · PR2 SFTP（拖拽传文件面板）

- 同连接 `sftp` channel（计一个 hold），`SftpSession` 封装 realpath/list/mkdir/rename/
  delete/rmdir/stat/upload/download；**字节流全在 main 进程**（fs↔sftp `stream.pipeline`），
  renderer 只见路径 / 名称 / 进度数字。
- `ssh.sftp*` 通道 + `ssh.sftpProgress` 事件（节流 150ms，终态即时）；上传走 OS 拖拽的绝对
  路径（preload `pathForFile`），下载目的地经 Electron 保存对话框，取消经 `AbortSignal` 即时
  拆流并删除半成品本地文件。
- 递归删除有界（≤2000 项 / ≤16 层），软链不跟随（只 unlink），避免文件面板一键误删整棵树。
- UI：Remotes 内嵌文件浏览器（面包屑 / 新建文件夹 / 重命名 / 删除二次确认 / 拖拽上传遮罩 /
  传输行进度条与取消）。

### D12 · PR3 本地端口转发 + ProxyJump 单跳

- **本地 (-L) 转发**：`net.Server` 监听本地端口，每个 TCP 连接向连接管理器申请一条
  `direct-tcpip` channel（`forwardOut`）。**本地监听存活于传输断线之上**——下一个连接会按需
  重连传输，故转发无需自带重试即可从网络波动恢复；活跃监听持一个 hold 防止 idle 断开。
- 转发记录持久化在 `settings.ssh.hosts[].forwards`（host 拥有，主机对话框不覆写）；启停为运行
  态，经 `ssh.forwardState` 事件广播；`ssh.startForward` 在本地监听绑定后才 resolve（EADDRINUSE
  等即时 reject 到对话框）。显式 `disconnect` / 删除主机会连带停掉其转发，避免隧道悄悄重拨。
- **ProxyJump 单跳**：跳板作为一等连接（自己的 host key 校验 + auth 管线）连上后，`forwardOut`
  到真实目标，把得到的流作为目标连接的传输 `sock`。跳板被依赖方以 hold 持活；显式拒绝多跳链与
  自跳。跳板可用保存的主机（id/label/hostname 命中）或临时 `user@host[:port]`（agent 认证）。

### 修订后的验证证据

- 单测新增：idle 自动断开、hold 保活、`direct-tcpip` 流回环、ProxyJump 单跳（真代理假 sshd）、
  多跳/自跳拒绝（ssh-service）；SFTP 会话 list/传输/进度/取消/递归删除边界（ssh-service +
  desktop-main SftpService）；转发监听绑定/隧道回环/EADDRINUSE/按 host 拆除（ForwardService）。
- e2e 扩为三条：首连全流程 + **断线后卡片回到 Connect**；一 remote 多会话（New Session /
  caret 菜单 / Disconnect 清零）；SFTP 列目录+建文件夹 + 转发真 TCP 回环。
- test:security：`secret-not-detectable` 递归遍历 `secrets/`（含 `secrets/ssh/`）断言无明文；
  schema 边界断言覆盖全部新 `ssh.sftp*` / `ssh.*Forward` 通道与 `ssh.sftpProgress` /
  `ssh.forwardState` 事件（无 secret 字段）。

### 独立验证捕获并已修的缺陷（2026-07-23，对抗式 verifier）

- **[CONFIRMED] 握手期 disconnect 泄漏连接并卡死 host**：在 auth 弹窗挂起（≤120s）或握手中
  途 `disconnect()`（如 connecting 态删除 host）会 bump `gen`，而 `client.on('ready')` 的
  stale-gen 分支**既不 `client.end()` 也不 settle promise** → 远端留下一条无主的已认证连接，
  且 `connect()` 永不 settle、`connectPromise` 永不清除，该 host 此后点 Connect 永久无反应
  直到重启。**修复**：stale-gen 统一走 `superseded()`（关闭孤儿 client + 单次 reject settle）；
  `connect().finally` 用 `m.connectPromise === attempt` 守卫避免晚到的被取代尝试清掉在用的；
  `disconnect()` 主动清 `connectPromise`；失败重连的 `.catch` 用 `m.gen === gen` 守卫，避免被
  取代的尝试与接管的世代抢生命周期。回归测试：连接管理器 "disconnect during an in-flight
  handshake abandons it cleanly and leaves the host reconnectable"。
- **[PLAUSIBLE] 转发 start 竞态**：`connect`+`listen` 完成前不在 `active`，此窗口内 disconnect
  的 `stopHost` 看不到它 → 断开后监听器与 hold 残留、下个 TCP 连接静默重拨。**修复**：`starting`
  在途表 + cancel 令牌，`stop`/`stopHost`/`stopAll` 置 cancelled，start 在 connect 后与 bind 后
  两处检查点自我拆除。回归测试："cancelling (stopHost) during an in-flight start leaves no
  listener or hold"。
- **[PLAUSIBLE] autoReconnect 运行时开启不生效**：构造时把 `reconnectDelaysMs` 依当时设置冻结
  为 `[]`。**修复**：删除该冻结，始终用默认退避，由 `scheduleReconnect` 内每次连接从 settings
  读取的 per-target `autoReconnect` 门动态决定开关。
- **[次要] 卡片状态 churn**：每次 channel 开关都重发 `connected` → 触发 settings 落盘 +
  renderer 全量 refresh。**修复**：`lastState` 边沿检测，只在真正进入 connected 时 touch。

## 修订 · 2026-07-24（Files 面板改版:双栏指挥官 + 全局传输中心)

用户按「先 mockup 后编码」流程从三个交互范式(双栏指挥官 / 装载篮 / 环境拖放+传输中心)
中选定融合版:**A 双栏为主体 + C 的全局传输中心**(`docs/design/ssh-mockups/
upload-fused-dualpane-transfercenter.html`)。

### 决定

- **D13 · 本地目录列举进主进程(`LocalFilesService`)**:渲染层沙箱不可读盘,双栏的
  「This Mac」栏经 `ssh.localHome` / `ssh.localList` 取**元数据**(名称/类型/大小/mtime/
  symlink 标记,复用 `SftpEntrySchema`),文件字节不过 IPC。路径必须绝对(支持 `~` 展开),
  相对路径拒绝。安全定位:与 OS 文件对话框同级的用户侧浏览能力,不属于 Pi 工具面
  (Tool Gateway R4 边界不变,Pi 仍无任意文件系统访问)。
- **D14 · 定向下载 + 冲突 uniquify**:`ssh.sftpDownload` v2 增可选 `localDir` —— 双栏下载
  直落本地栏当前目录,同名自动 `name (1).ext` 顺延,**绝不静默覆盖**;不带 `localDir`
  保持原 OS 另存对话框行为。
- **D15 · 传输重试留在主进程**:传输端点(本地/远端全路径)从不进渲染层;终态传输在主
  进程保留 10 分钟(原 60s),`ssh.sftpRetry {transferId}` 用留存端点重发并返回新
  transferId。渲染层重试成功后丢弃旧行。
- **D16 · 全局传输中心取代面板内嵌传输条**:传输状态(含渲染层差分平滑的速率)提升为
  跨主机、跨 surface 的常驻 UI —— 右下角胶囊(聚合 进行中数/百分比/速率)+ 按主机分组的
  弹层(取消/重试/清除已完成),挂载于 Workbench 根(与 SshPromptHost 同级),切换
  surface 或返回 Hosts 不丢。
- **D17b · 可编辑路径栏**:两栏面包屑均可切换为路径输入(点击空白轨道或悬停铅笔按钮),
  Enter 直达、Esc/失焦取消;远端 `~`/`~/x` 依服务器解析的 home 在渲染层展开(SFTP realpath
  对 `~` 是字面量),本地 `~` 由主进程展开;非法路径经既有错误横幅呈现,不清空当前列表。
- **D17 · 双栏交互模型**:click/⌘·Ctrl/Shift 多选;中间 ›/‹ 传输闸按选区推送;跨栏拖拽
  (内部 `application/x-charter-sftp` 标记)与 OS 文件拖入远程栏共存;双击目录进入、双击
  文件即传;远端管理动作(改名/删除/单文件下载)保留为行内悬停按钮。目录上传仍拒绝
  (提示走 shell),目录下载跳过。

### 测试

- LocalFilesService:dirs-first 排序、`~` 展开、相对路径拒绝、损坏 symlink 不炸目录。
- SftpService:`localDir` 下载跳过对话框且冲突 uniquify(事件只带最终文件名,无本地路
  径);失败传输 retry 用留存端点重发成功、运行中/未知 id 拒绝。
- e2e 第三条升级为双栏真回路:本地临时目录 → 选中 → › 上传 → 远端出现 + 假 sshd 字节
  断言 → 远端选中 → ‹ 下载 → 本地出现 `up (1).txt`(uniquify)+ 磁盘内容断言 → 传输中心
  胶囊/弹层/Clear finished 断言。
- 安全:全部新通道过 schema 边界断言(无 secret / 无本地全路径出主进程——进度事件仅
  文件名);148 项安全单测 + secret-scan + 2 条 Playwright 安全 spec 全绿。

## 修订 · 2026-07-24b（远程会话收敛为 shell-only)

用户验收决定:**目前远程会话只要 shell,不要 Claude/Codex session**。UI 层收敛:卡片
split-button 的 caret 菜单整体移除(主键只剩 Connect / + New Session,恒开 shell);
New Terminal 对话框选中远程 target 时强制 launch=shell(Claude/Codex 选项禁用并注明
"Not available on remotes")。**引擎不删**:terminal.create v4 的 launch×target 正交、
远端 CLI 探测、cd+exec 启动序列全部保留(D4),功能回归只需恢复 UI 入口。README 中英
同步删去"在服务器上运行 Claude Code / Codex"表述,避免夸大现状。

## 修订 · 2026-07-24c(Forwards 弹窗隧道图式 + 两处传输层加固)

- **Forwards 弹窗重设计(方案 A,用户从 A/B mockup 选定,`docs/design/ssh-mockups/
  forwards-dialog-redesign.html`)**:主机名移入副标题;空态改教学示意图(This Mac ╌▶ host
  ╌▶ target);新增「隧道 composer」——本机端口卡 ─⚿主机 chip─▶ 目标卡,方向自解释;
  复选框换开关;转发行=呼吸灯 + mono 路由 `local → host → target` + Stop/Start + 行内删除。
  testid 与行为(saveForward/立即启动/二次确认删除)不变,e2e 无需改动。
- **[加固] disconnect 会话残留竞态(e2e 曾抓到 Disconnect 后残留 1 行)**:`channel.close()`
  的本地 `close` 事件要等服务端回包,紧随的 `client.end()` 可在负载下抢先拆 socket → 事件
  永不到、终端不退。改为 manager 持有 per-channel **finalize**(`channelFinalizers`),
  `disconnect()` 与 `handleTransportClose()` 直接同步终结全部会话,不再依赖 ssh2 事件。
  回归单测:"disconnect finalizes every open session without waiting for close acks"
  (旧实现无法通过——close 事件至少晚一个网络往返)。
- **[加固] fake-sshd `dropConnections` 改真断网语义**:原 `Connection.end()` 是优雅关闭
  (flush 出站队列+DISCONNECT),高负载下客户端 close 可被无限期推迟;改为销毁底层 raw
  socket(`_sock.destroy()`),与"网络断了"的被测语义一致。单测/e2e 共用。
- **[教训] e2e 必须带 `--config tests/e2e/playwright.config.ts` 跑**(或 `npm run
  test:e2e`):配置不在仓库根,裸 `npx playwright test` 加载不到 → `workers` 回退默认并行,
  多个 Electron 实例互相饿死,制造与代码无关的幻影失败(rail 已更新/终端视图停滞的半更新
  快照)。本次为此追了一小时。launchApp 顺带排水主进程 stdout/stderr 管道(防 64KB 缓冲
  填满阻塞 main 的 console.log)。

## 修订 · 2026-08-07（New Session 恢复远端 Agent，入口改为 target-first）

用户重新确认核心 user story：**IDE 在本机，Agent 与工作目录可以在任意 SSH 服务器**，
而且首次使用必须从 IP/主机名连接开始，不能假设已经存在某台 Mac mini 或预配置工作区。

- New Session Composer 增加执行目标，默认 **This Mac**；远端入口为 **Connect remote over
  SSH**。无已保存主机时直接打开 IP/主机名、端口、用户名和认证表单；有主机时可以复用。
- 连接继续复用既有 TOFU host-key、交互认证和 OS keychain 边界。连接后选择服务器目录，
  并通过 SSH 对所有声明 `surfaces.remote` 且具有 terminal contract 的 Agent Manifest 逐一
  `command -v`；远端探测与本机是否安装同名 CLI 完全独立。
- 用户选定目录与 Agent 后回到同一个 Composer。提交时 `terminal.create` 携带
  `target:{kind:'ssh',hostId}` 与 initialPrompt；主进程再次探测 CLI，并以 POSIX 单引号分别
  转义目录和首条 Prompt，再执行 `cd -- <dir> && exec <agent> <prompt>`。不存在本机回退。
- 服务器目录模式禁用本地文件/对话引用、Advanced charter 和 Worktree，避免把本机路径假装
  成服务器上下文；本机目录模式的引用边界见 2026-08-07c 修订。远端仍是原生 PTY Session；
  其文件变更由下述 Managed Worker 修订进入 Diff/Review。
- 2026-07-24b 的 shell-only 决策继续适用于 **Remotes 主机卡片 / New Terminal**，它们保持
  shell-first，避免出现第二套 Agent 启动菜单；恢复的唯一 Agent 入口是 New Session。

## 修订 · 2026-08-07b（Managed Remote Worker：Diff / Review / rollback / Resume）

仅有 SSH PTY 只能“看见 Agent 在跑”，不能给 Charter 提供入口基线、可靠变更、拒绝写回和恢复。
因此远端 Agent Session 增加独立的 change-plane Worker；PTY 仍由 `ssh2` shell channel 提供，
Worker 不冒充终端，也不在 SSH 握手成功时静默注入。

- **显式安装与版本握手：** Folder & Agent 步骤同时显示 Worker 的 Missing / Update / Ready /
  Unsupported / Error 状态。只有用户点击 Install / Update 才把本构建内置的单文件 Worker 上传到
  `~/.charter/worker/bin/remote-session-worker.cjs`；临时文件原子换名，权限为 0700。每次运行前
  校验 Node.js ≥18、协议版本、Worker 版本和完整文件 SHA-256；任一不符即 fail closed。
- **基线与净变更：** `start` 在 Agent 启动前取基线。Git 根使用独立临时 index 生成包含 tracked
  与 untracked（不含 ignored）的 tree，并用 `refs/charter/worker/<session>` 抵御 gc；非 Git 根
  保存有界 manifest/blob（20k 文件、256 MiB 基线、32 MiB/文件）。`changes` 返回相对入口基线
  的净变更与前后哈希/字节，Main 做二次路径、数量和 SHA-256 校验后写入 Session 专属稀疏镜像，
  复用原 ChangeService / Diff / Review 账本。
- **拒绝与回滚是真写回：** Review 在稀疏镜像算出目标字节，Main 通过 Worker `apply` 的 stdin
  传递结构化 payload；文件内容不进入 shell argv 或 renderer IPC。Worker 对每个路径先核对上次
  同步的 expected hash、拒绝软链穿越与 `..`，整批预检无冲突后再原子写入。远端抢先变化时，
  本地 Review/rollback 决策保持 pending，不伪造成功。
- **退出、恢复与继续：** SSH channel 结束时先等待最终 `changes`，再发终端退出边；失败会记入
  Session diagnostic。Worker 状态保留到 Review/删除；应用重启后用 durable change paths 调
  `inspect`，即使远端路径已恢复为“无净 Diff”也能清掉本地幽灵变更。`discover` 在远端 CLI 自己的
  transcript 索引中按 cwd + 生命周期找出 Claude/Codex/Kimi conversation id；Resume 新开 SSH
  PTY、复用同一 Worker 基线并执行 Manifest 拥有的精确 resume argv，绝不误开本机终端。
- **生命周期与数据边界：** 普通 SSH shell 不要求 Worker。Managed Session 删除时尽力执行
  `destroy`（含 Git keepalive ref）并删除本机稀疏镜像；离线删除不被远端清理失败阻塞。完整项目
  和命令执行留在服务器，但 Diff 所需的基线/改动文件字节会随 Session 保存在本机——UI/README
  明示此数据边界，不再笼统宣称“代码绝不离开服务器”。

验证契约：Worker 非 Git/Git 独立进程测试；Main 对恢复 inspect、哈希冲突、安装握手的单测；
Electron E2E 覆盖显式安装、远端目录选择、远端写入进入普通 Diff、PTY 退出前最终同步、Review
拒绝删除服务器文件，以及 Resume 仍在同一服务器/目录/Worker baseline 上运行。

## 修订 · 2026-08-07c（SSH Workspace 双模式与产品身份）

远端 Agent 的“执行位置”和“用户认定的项目文件位置”不再被合并成一个选择。New Session 在
服务器连接成功后显式提供两个互斥模式，并把该选择持久化为 `remote.workspaceKind`：

- **On this server（`remote`）：** 用户选择已有服务器目录，Agent 与命令直接在该目录运行。
  Session 分组名称由 host label + 远端 basename 派生，Files 通过 SFTP 读取 `remote.root`；内部
  `rws_*` Worker id 与 `remote-mirrors` 稀疏核算目录不得作为项目名称、Files 根目录或本地
  Workspace 被打开。因为 group path 是服务器路径，UI 也不提供误导性的“本地 New Session”按钮。
- **On this Mac（`local`）：** 当前本机 Workspace 是 canonical project。Main 在启动前冻结一个
  有界、无软链快照；Git 根只包含 tracked + non-ignored untracked 文件，`.git`、`.charter`、
  `node_modules` 与 ignored secret/dependency 不上传。快照经 SFTP 写入严格生成的
  `~/.charter/workspaces/<rws_id>`，Agent 的 SSH PTY 只在这个隔离副本中执行；Renderer 只能声明
  当前 focused Workspace，不能授予任意本机路径。
- **受保护双向同步：** Worker `changes` 向本机落地前核对 Main 记录的本机 expected hash；本机
  watcher 向服务器 `apply` 前核对远端 expected hash。所有 change/apply 操作串行，同一路径两边
  同时变化时两次写入都会 fail closed，哈希水位只在成功落地后推进，因此不会在下一拍反向覆盖。
  Diff/Review 继续使用同一个 ChangeService 账本；本地引用可用，但 task-owned Worktree 不跨机桥接。
- **所有权与清理：** `local` 隔离根必须精确等于远端 home 下由 Session id 生成的路径；Worker
  `destroy` 才允许递归删除它。删除/启动失败清理绝不删除 canonical 本机项目。Git ignored 文件默认
  不离开本机；UI 在选择前明示快照、双向同步和冲突边界。

新增验证契约：纯函数测试禁止 `rws_*` 泄漏到 Session group；Worker 测试验证 local root 精确
所有权与删除；Electron E2E 分别验证 server-owned Files 的真实 SFTP 根，以及 local-owned 的快照
过滤、远端 PTY 根、双向同步、同文件冲突不覆盖和只清理远端隔离副本。
