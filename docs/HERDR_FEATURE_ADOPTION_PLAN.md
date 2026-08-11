# Herdr 能力借鉴与 Charter 实施计划

> 状态：Proposed  
> 范围：外部 Agent 语义运行时、终端可观测性、后台运行、远端输入与扩展机制  
> Charter 基线：当前工作树，HEAD `b0bca3980a424a2a689cec370f1ce0055cb959d9`  
> Herdr 研究基线：干净工作树，HEAD `ddffb6e1d79efb517a92034ed18b75c388a36e55`

## 1. 文档目的

本文将 Herdr 中值得 Charter 借鉴的七项能力转化为可评审、可分期、可验收的实施方案：

1. 外部 Agent 状态引擎
2. Agent 语义控制 API
3. Alternate-screen 完整转录读取
4. Detach / reattach 与后台运行
5. 本地图片到外部或远端 TUI 的输入桥
6. 多 Agent Adapter Pack
7. 受限的可执行扩展机制

目标不是把 Herdr 移植进 Charter，也不是把 Charter 改造成终端复用器。目标是在保留 Charter 的 Session、Mission、证据、Review、回滚和权限模型的前提下，补齐外部 Agent CLI 的生命周期可见性和可编排性。

完成前，Charter 主要回答：

> Agent 改了什么，结果是否有证据，是否值得接受？

完成后，Charter 还应稳定回答：

> 每个 Agent 在哪里、现在处于什么状态、为什么这样判断、何时需要用户，以及协调者何时可以安全继续？

## 2. 总体原则

### 2.1 状态不是完成证据

外部 TUI 的 `idle` 或 `done` 只能说明该 Agent 当前可继续输入或完成了一个可观察回合，不能直接完成 Charter Task、Mission 或 Assignment。

以下边界必须保持：

```text
Agent lifecycle state
    ├── 驱动通知、注意力、等待和编排唤醒
    └── 不直接驱动 Task/Mission 完成

Task/Mission completion
    └── 继续由显式交付、验证、证据和 Review 决定
```

### 2.2 Structured 与 Observed 永远区分

- `structured`：来自受管运行时、可信协议事件或完整生命周期 Adapter。
- `observed`：来自 OSC、终端屏幕、进程和静默窗口等观察信号。
- `unknown`：证据不足时的正式状态，不得用乐观推断替代。

UI 可以简化展示，但诊断层必须保留来源。

### 2.3 扩展现有底座，不建立平行系统

实施应复用：

- `AgentRegistry`：Agent discovery、launch、resume、history 和能力目录。
- `TerminalManager`：PTY、进程识别、VT screen model。
- `TerminalControlService`：稳定终端标识、send、read、wait、Worker 控制。
- `ExternalSessionService`：外部 Session 身份、回合边界、文件核算和 Review。
- Terminal daemon：本地 PTY 所有权、重放、断线重连。
- Tool Gateway：权限、身份、风险和证据入口。

### 2.4 所有自动判断必须可解释

只显示一个状态颜色不够。状态系统必须能回答：

- 当前状态是什么？
- 状态来自 Hook、OSC、屏幕规则还是降级推断？
- 命中了哪条规则、哪个屏幕区域？
- 哪些更高优先级信号被跳过？
- 使用的是哪一版 Adapter/Manifest？
- 最近一次状态变化序号和时间是什么？

### 2.5 规则更新不得绕过发布信任链

Herdr 支持从远端下载检测 Manifest 并热加载。Charter 第一版不采用未签名远端规则更新。规则应随应用发布，或使用经过签名和版本校验的独立规则包。

## 3. 目标架构

```text
Agent Adapter Hook ───────────────┐
Structured runtime event ────────┤
OSC title/progress ──────────────┤
Rendered terminal screen ────────┼──> AgentPresenceEngine
Foreground process ──────────────┘          │
                                             ├──> Session Rail / For You
                                             ├──> Notification / Needs you
                                             ├──> Worker Wall / Runtime Inspector
                                             ├──> agent.status / wait / explain
                                             └──> Transcript read safety gate

Terminal daemon / SSH / SFTP
        ├──> PTY 生命周期
        ├──> 后台窗口 detach
        └──> 外部 TUI 图片输入桥

AgentRegistry
        ├──> Launch/Resume manifest
        ├──> Lifecycle detection manifest
        └──> Optional lifecycle/session adapter
```

建议新增独立的 `AgentPresenceEngine`，而不是继续把状态判断分散在 `ExternalSessionService`、renderer store 和 Terminal 控制代码中。

建议的核心状态模型：

```ts
type AgentProcessState = 'running' | 'exited';
type AgentLifecycleState = 'working' | 'blocked' | 'idle' | 'unknown';
type AgentAttentionState = 'none' | 'needs_user' | 'done';
type AgentPresenceSource =
  | 'structured'
  | 'lifecycle-adapter'
  | 'osc'
  | 'screen-manifest'
  | 'process';

interface AgentPresenceSnapshot {
  terminalId: string;
  taskId: string | null;
  agentId: string | null;
  processState: AgentProcessState;
  lifecycle: AgentLifecycleState;
  attention: AgentAttentionState;
  source: AgentPresenceSource;
  stateChangeSeq: number;
  changedAt: string;
  seen: boolean;
  evidence: AgentPresenceEvidence;
}
```

不建议使用一个不透明的数值 `confidence`。优先级、来源和命中证据比“83% 可信”更可测试，也更利于排障。

---

## 4. 能力一：外部 Agent 状态引擎

### 4.1 用户结果

用户不必逐一打开终端，就能区分：

- `Working`：Agent 正在执行或推理。
- `Needs you`：当前存在需要人类输入的权限、确认或问题界面。
- `Done`：Agent 从工作状态回到 idle，且用户尚未查看。
- `Idle`：已查看且可继续输入。
- `Unknown`：Agent 存在，但 Charter 无法可靠分类。
- `Exited`：进程已结束；它是进程状态，不与 lifecycle 混为一谈。

### 4.2 当前基础与缺口

Charter 当前已经具备：

- Claude/Codex OSC title spinner 的 busy/idle 边界。
- 无明确 busy title 时的 quiet settlement。
- 受管 Agent 的结构化问题、权限、计划和运行状态。
- 外部 Agent 的进程识别、Session identity、文件核算与 Resume。

缺口是：

- 没有外部 Agent 通用 `blocked` 状态。
- 没有正式 `unknown` 语义。
- 没有 Hook、OSC、screen、process 的统一仲裁。
- 没有可查询的命中证据。
- `done until seen` 没有成为所有 Agent 的统一注意力模型。

### 4.3 实施内容

#### A. 生命周期规则 Manifest

在 Agent Registry 旁增加独立的 lifecycle manifest，至少包含：

```ts
interface AgentLifecycleManifest {
  id: string;
  version: string;
  minEngineVersion: number;
  rules: AgentLifecycleRule[];
}

interface AgentLifecycleRule {
  id: string;
  state: AgentLifecycleState;
  priority: number;
  region:
    | 'osc_title'
    | 'osc_progress'
    | 'whole_visible'
    | 'whole_recent'
    | `top_non_empty_lines(${number})`
    | `bottom_non_empty_lines(${number})`
    | 'after_last_prompt_marker';
  contains?: string[];
  regex?: string[];
  lineRegex?: string[];
  all?: AgentLifecyclePredicate[];
  any?: AgentLifecyclePredicate[];
  not?: AgentLifecyclePredicate[];
  visibleIdle?: boolean;
  visibleBlocker?: boolean;
  visibleWorking?: boolean;
  skipStateUpdate?: boolean;
}
```

Manifest 必须严格拒绝未知字段、无效正则、重复 rule id 和不支持的 engine version。

#### B. 信号权威顺序

建议仲裁规则：

1. 受管运行时的结构化事件。
2. 声明为 full-lifecycle 的 Adapter Hook。
3. 当前屏幕上的强可见 blocker；只允许覆盖不完整 Adapter。
4. OSC title/progress。
5. screen manifest。
6. 进程信号只证明 Agent identity 或退出，不单独证明 working/idle。
7. 无可靠证据时返回 `unknown`。

#### C. 状态稳定

- Hook 报告必须带单调递增序号；拒绝旧报告。
- `working -> idle` 的弱信号需要短窗口重复确认。
- 强 blocker 可以立即发布。
- transcript/history viewer 应设置 `skipStateUpdate`，不能用历史文本覆盖实时状态。
- 进程退出清除失效 Hook 权威，并发布 `processState: exited`。
- 状态不变且屏幕 revision 不变时跳过重复扫描。

#### D. Done 与 seen

- `working -> idle` 后，若 Session 未聚焦，则 `attention = done`。
- 强 blocker 始终产生 `attention = needs_user`。
- 用户聚焦对应 Session 后清除 `done`，但不改变底层 lifecycle。
- CLI/API read 不应自动标记 seen。

### 4.4 UI 影响

- Session Rail：Working、Needs you、Done、Unknown。
- For You：按 `needs_user > done > working > unknown` 聚合。
- Worker Wall：阻塞 Worker 优先置顶。
- Room/Terminal header：显示简化状态和来源图标。
- Runtime Inspector：显示完整证据、规则版本、状态序号。

主界面只显示简单状态；规则详情进入诊断抽屉。

### 4.5 验收标准

- Claude、Codex、Kimi 至少覆盖 startup、working、idle、permission/question blocker、history viewer、exit。
- 同一终端状态序号严格单调递增。
- 弱 idle 信号不会造成可见闪烁。
- 无法确认时返回 `unknown`，不得默认 `idle`。
- 外部状态不能直接完成 Task、Assignment 或 Mission。
- `agent.explain` 能给出规则、区域、来源、版本和跳过原因。
- 每个规则均有录制 fixture，且 fixture 失败能定位到具体 rule id。

---

## 5. 能力二：Agent 语义控制 API

### 5.1 用户结果

协调者可以表达：

- 等 Agent 进入 blocked。
- 等 Agent 完成当前可观察回合。
- Prompt 提交后确认 Agent 真正开始活动。
- Agent 被替换或退出时立即失败，而不是继续等待同一个终端 id。
- 读取当前状态为何成立。

### 5.2 API 设计

第一版建议提供以下 Tool Gateway/API 能力：

```text
agent.status
agent.explain
agent.prompt
agent.wait
agent.sendKeys
```

所有目标解析应接受稳定 terminal id 或当前 Session 内唯一 Worker 名称。

#### `agent.status`

返回：

- identity：terminal、task、agent、session ref。
- process state。
- lifecycle 与 attention。
- state change sequence。
- source 和简化 evidence。

#### `agent.explain`

返回诊断信息，不产生副作用：

- 当前使用的 Adapter/Manifest。
- 命中规则和被评估规则。
- OSC、screen region 的安全截断预览。
- Hook authority 状态。
- 跳过或降级原因。

输出必须经过敏感信息截断，不把完整终端内容写入普通日志或支持包。

#### `agent.prompt`

语义：

1. 解析目标 Agent identity。
2. 验证 Agent 当前仍控制终端前台。
3. 记录发送前的 `stateChangeSeq` 和 identity。
4. 通过现有 bracketed-paste + 独立 Enter 路径提交。
5. 可选等待真实 activity edge。
6. 可选继续等待目标状态。

如果非 working Agent 在限定时间内没有产生状态变化，应返回 `AGENT_PROMPT_STALLED`，不能无限等待。

#### `agent.wait`

建议输入：

```ts
{
  target: string;
  until: Array<'working' | 'blocked' | 'idle' | 'done' | 'unknown' | 'exited'>;
  afterStateChangeSeq?: number;
  timeoutMs: number;
}
```

- 初始状态已满足时立即返回。
- 带 `afterStateChangeSeq` 时必须观察到更新后的状态。
- 等待期间 identity 改变时返回 `AGENT_NOT_RUNNING`。
- 使用事件唤醒，不进行高频轮询。

#### `agent.sendKeys`

- 仅发送经过 schema 允许的键或组合键。
- 发送前验证 Agent identity。
- 保留 Tool Gateway 权限、调用者归属和频率限制。
- 普通文本 Prompt 继续走 `agent.prompt`，不滥用 raw keys。

### 5.3 与现有 Terminal API 的关系

- `terminal.send`：明确需要原始终端输入时使用。
- `terminal.wait(command|quiet|until|turn)`：继续服务 shell 和原始终端场景。
- `agent.*`：需要确认目标是当前 Agent，并理解生命周期时使用。
- `agent.wait(done)` 不替代 Mission Assignment completion。

实现上，`agent.*` 应调用现有 `TerminalControlService` 和 `ExternalSessionService`，不复制 send/read/wait 基础设施。

### 5.4 验收标准

- Prompt 发送前后 Agent 被替换时安全失败。
- 非 working 起点必须观察 activity edge，才能把后续 idle 当作新回合完成。
- 已 working 的 Agent 可以接受 follow-up，但 API 明确它可能由当前活动回合满足等待。
- blocked、unknown、exit 均能作为精确等待条件。
- 取消只移除 waiter，不停止 Agent。
- 所有 Agent API 调用进入现有权限和证据账本。

---

## 6. 能力三：Alternate-screen 完整转录读取

### 6.1 用户结果

当 Claude Code、Codex、OpenCode 等全屏 TUI 把旧回复保存在应用自己的 alternate-screen transcript 中时，协调者仍能读取指定行数的完整近期转录，而不是只能看到当前一屏。

### 6.2 设计边界

第一版增加显式读取意图：

```ts
type TerminalReadMode = 'screen' | 'transcript';
```

- `screen` 保持当前纯被动读取行为。
- `transcript` 才允许受控滚动 Agent TUI。
- ANSI、检测扫描、wait-output、订阅均不得隐式滚动。

### 6.3 启动条件

只有同时满足以下条件才能采集：

- 当前终端存在已识别 Agent。
- lifecycle 为 `idle`。
- active buffer 是 alternate screen。
- TUI 报告或实验证明支持 mouse wheel transcript scrolling。
- 当前 viewport 位于底部。
- 请求行数大于当前可见行数。
- 没有用户输入、direct attach 写控制者或另一个 transcript read。

不满足时：

- 显式 `agent.read(transcript)` 返回明确错误或被动降级标志。
- 普通 `terminal.read` 始终返回当前可用 screen，不改变 viewport。

### 6.4 采集状态机

```text
settle initial
  -> probe bottom
  -> scroll up in bounded batches
  -> capture overlapping viewports
  -> align and merge rows
  -> restore to original bottom
  -> verify restore
  -> return transcript or safe fallback
```

必须处理：

- 固定 header/status 区域不重复拼接。
- soft-wrapped 行可选择展开。
- 动态耗时和 spinner 区域不会破坏全部对齐。
- 终端 resize、Agent 开始工作、用户输入、无法对齐或总超时会中止。
- 中止后优先恢复 viewport；恢复失败必须显式报告。

### 6.5 输入所有权

建议增加短期 `TerminalInteractionLease`：

- transcript reader 获取临时自动输入租约。
- 用户键盘/鼠标输入拥有更高优先级，可取消自动读取。
- 同一时间只能有一个自动 viewport 操作者。
- resize 和 writable direct attach 自动使租约失效。

### 6.6 验收标准

- 在真实 Claude/Codex Electron TUI 中能读取超过一屏的转录。
- 返回内容无固定 header 重复，soft-wrap 合并正确。
- 成功后 viewport 回到底部。
- 用户交互、Agent working、resize、对齐失败均安全中止。
- 重复运行三次稳定，不留下滚动位置漂移。
- 普通 screen read、状态检测和 output wait 永不触发自动滚动。

---

## 7. 能力四：Detach / reattach 与后台运行

### 7.1 用户结果

用户关闭 Charter 窗口后，长任务、文件核算、通知和本地/远端连接可以继续运行；重新打开窗口时回到原 Session。

### 7.2 关键架构事实

Charter 的 terminal daemon 已持有本地 PTY，但以下能力仍在 Electron Main 中：

- `ExternalSessionService` 文件核算和回合边界。
- Task/Mission 状态机。
- Tool Gateway 和 Worker 编排。
- SSH、SFTP、forward 与远端 Worker。
- 通知和数据库写入。

因此，只是不在退出时调用 `terminalDaemon.shutdown()` 会造成“PTY 仍在跑，但核算、通知、SSH 和证据停止”的不完整状态。

### 7.3 分两阶段实施

#### 阶段 A：窗口 detach，Main 后台继续

这是第一版推荐范围：

- 关闭最后一个窗口时，根据设置隐藏窗口而不是退出 Main。
- Main、数据库、Terminal daemon、SSH、watcher、Mission 和通知继续运行。
- Dock/tray/menu 显示仍有多少 Session 在运行。
- 再次启动或点击图标时恢复窗口并聚焦原 Session。
- `Quit and stop all` 才执行现有有序 teardown。

建议退出选择：

```text
Close window and keep 4 Agents running
Quit and stop all running work
Cancel
```

可以提供“记住我的选择”，但必须在 Settings 中清楚可撤销。

#### 阶段 B：Electron Main 完全退出后仍可 reattach

这需要把更多运行时能力迁移到独立服务，不属于第一版：

- Task/Mission runtime ownership。
- 外部文件 watcher 与归属账本。
- SSH/remote connection ownership。
- 通知和数据库写入协议。
- Tool Gateway 调用和调用者身份。

只有完成这些迁移，才可以承诺 Command+Q 后 Agent 仍安全运行且证据不断档。

### 7.4 后台模式规则

- 后台运行必须有明显的菜单栏/tray 状态。
- 显示运行 Agent 数量、远端连接、最近通知和 Stop all。
- 更新安装前要求所有运行时达到安全边界或由用户明确停止。
- 后台仍可能消耗 Token/CPU，必须在退出提示中写明。
- 操作系统 logout/shutdown 不承诺继续运行。
- 异常重启时复用现有 daemon replay 和数据库恢复路径。

### 7.5 验收标准

- Windows/Linux 关闭最后窗口后，选择 keep running 不触发 `app.quit()`。
- macOS 关闭窗口后继续运行，重新激活恢复原窗口。
- 后台期间本地外部 Agent 文件改动仍进入 ChangeSet。
- 后台期间 Mission continuation、通知和 SSH Session 均继续工作。
- `Quit and stop all` 保持当前有序 teardown，不遗留 PTY、SSH listener 或数据库写入。
- 崩溃恢复与受控更新路径分别测试，不能把 E2E-only preserve 环境变量产品化。

---

## 8. 能力五：本地图片到外部或远端 TUI 的输入桥

### 8.1 用户结果

用户可以在外部 Claude/Codex/Kimi TUI 中执行“粘贴图片”，Charter 将本机剪贴板图片转换为目标 Agent 能访问的文件路径：

- 本地 TUI：写入本机受管临时文件并粘贴路径。
- SSH TUI：上传到远端私有临时目录并粘贴远端路径。

### 8.2 为什么需要独立桥

受管 Charter Agent 已能接收 prompt image bytes；外部 Agent 的 conversation 则是其原生终端，没有 Room Composer。因此该功能不是重复现有图片附件，而是补外部 TUI 的输入通道。

### 8.3 交互设计

第一版提供显式动作，不劫持普通文本粘贴：

- Terminal 右键菜单：`Paste image as path`。
- 可配置快捷键，例如 `⌥⌘V`。
- 剪贴板同时包含文本和图片时，普通 `⌘V` 继续粘贴文本。
- 没有图片、图片过大或上传失败时显示可恢复错误。

可复用现有 bare-image clipboard 判断和图片解码校验。

### 8.4 本地路径

- 存储在 Charter 管理目录，不写入项目树。
- 文件名不可复用，权限在 Unix 上为 `0600`，目录为 `0700`。
- 允许 PNG、JPEG、GIF、WebP、BMP。
- 统一沿用 Charter 现有 10 MB 图片上限，避免产品出现两个限制。
- Session 结束时清理；异常遗留文件按 24 小时 TTL 清理。

### 8.5 远端路径

- 使用现有 SSH/SFTP 连接，不启动额外 `scp` shell 命令。
- 目标目录建议为 `~/.charter/tmp/image-paste/<session-id>/`。
- 远端目录和文件采用私有权限。
- 上传完成并校验字节数后，才向 PTY 粘贴路径。
- observer 或无写控制权的终端禁止执行。
- SSH 重连、取消和中途失败必须删除不完整临时文件。

### 8.6 输入方式

- 路径通过 bracketed paste 写入，默认不自动 Enter。
- 用户可以先检查路径，再手动提交。
- Agent Adapter 可声明路径包装方式；默认粘贴 shell/TUI 可接受的绝对路径。
- 所有路径都是 host 生成的数据，不接受 renderer 传入任意远端目标路径。

### 8.7 验收标准

- 本地 Claude/Codex TUI 可收到有效图片路径。
- SSH 外部 TUI 可读取上传后的图片。
- 文本剪贴板行为不受影响。
- 超大、伪造 MIME、解码失败、无写控制权、上传取消均安全失败。
- Session 正常结束和 TTL 清理都能移除临时文件。
- 路径中空格和非 ASCII 字符不会被拆分或意外提交。

---

## 9. 能力六：多 Agent Adapter Pack

### 9.1 用户结果

更多已安装 Agent 可以进入同一套 Charter 工作流：

- 自动发现
- 原生 TUI 启动
- 精确 Resume
- 生命周期状态
- Needs you / Done 通知
- Worker 编排
- 文件核算、Diff 和 Review
- 可用时的 Skills、instructions 和 history

### 9.2 Adapter 分层

每个 Agent 的支持不应是一个笼统的 `supported: true`，而应拆成：

#### A. Launch Adapter

- executable discovery
- version probe
- new session args
- first prompt delivery
- exit sequence
- remote availability

#### B. Session Adapter

- session id pattern
- preassigned id
- resume/continue args
- history connector
- session identity Hook

#### C. Lifecycle Adapter

- process aliases
- OSC signals
- screen detection manifest
- optional full-lifecycle Hook
- integration authority coverage：full、session-only、none

#### D. Capability Declaration

- images
- embedded context
- MCP/ACP
- exact resume
- history
- skills
- instructions
- remote
- lifecycle confidence source

UI 只展示真实可用能力，不能因为 Agent 被发现就宣称支持全部能力。

### 9.3 推进顺序

#### Wave 1：现有三家完整化

- Claude Code
- Codex
- Kimi Code

目标是先证明新状态和 API 架构，而不是扩大名单。

#### Wave 2：高价值常见 CLI

候选：

- Gemini CLI
- OpenCode
- GitHub Copilot CLI
- Cursor Agent

进入 Wave 2 的条件：可获得稳定进程身份、真实 TUI fixture，并且至少能诚实声明 observed lifecycle 或 `unknown`。

#### Wave 3：社区或实验性 Adapter

- 通过受签名的 Adapter Pack 或本地开发目录安装。
- 默认标记 Experimental。
- 不满足兼容版本时拒绝加载。
- 单个 Adapter 失败不能破坏其他 Agent 或 Terminal。

### 9.4 Manifest 更新策略

第一版：

- bundled with app release。
- 允许开发模式本地 override。
- Settings/diagnostics 显示 active source 和 version。

后续独立 Pack：

- 必须签名。
- 必须绑定 engine version。
- 拒绝降级和“同版本内容变化”。
- 原子写入，失败回退到上一版或 bundled 版本。
- 支持一键禁用问题 Pack。

### 9.5 验收标准

- 一个 Adapter 可以在不修改核心 provider 分支的情况下完成 discovery 和 launch。
- 每项 capability 均由实现和测试证明，不靠 Agent 名字推断。
- 未知 Agent 可以作为普通终端运行，不污染 lifecycle 状态。
- Adapter 解析失败只影响自身，并产生诊断。
- 当前三家在本地和 SSH 路径中通过真实 Electron E2E。

---

## 10. 能力七：受限的可执行扩展机制

### 10.1 用户结果

用户或团队可以为 Charter 增加可复用工作流，而不必修改核心仓库或等待应用发版，例如：

- 在 Review ready 时运行团队检查。
- 从当前 Session 生成内部报告。
- 对某类链接提供自定义动作。
- 创建项目初始化或发布准备动作。
- 订阅有限的 Charter 事件并产生通知或本地工件。

### 10.2 与 Skills 的边界

- Skill：给 Agent 的说明、参考资料和上下文包。
- Workflow Extension：由 Charter 主机调度的可执行动作和事件处理器。
- Agent Adapter：描述外部 Agent 的 discovery、launch、session 和 lifecycle。

三者必须在 UI、目录和权限上明确分开。

### 10.3 第一版范围

建议只支持：

- local linked extension。
- 声明式 actions。
- 有限、白名单化的 event hooks。
- manifest/version/platform validation。
- Tool Gateway 权限预览。
- 有界 stdout/stderr、超时、取消和执行日志。
- 独立 config/state 目录。

第一版不支持：

- 任意 renderer React 代码。
- 自定义原生 UI pane。
- 自动获得 terminal socket/token。
- 自动继承全部环境变量。
- 未经确认的 startup command。
- GitHub 一键安装或远端自动更新。

### 10.4 建议 Manifest

```toml
id = "example.release-checks"
name = "Release checks"
version = "0.1.0"
min_charter_version = "1.0.0-beta.6"
platforms = ["macos", "windows", "linux"]

[[actions]]
id = "run"
title = "Run team release checks"
contexts = ["project", "session"]
command = ["node", "dist/run.mjs"]
permissions = ["workspace.read", "command.execute"]

[[events]]
on = "task.review_ready"
action = "run"
automatic = false
```

### 10.5 执行模型

- Manifest command 使用 argv 数组，不经过隐式 shell。
- 主机只注入最小上下文：extension id、action id、调用来源、project/session/task id。
- Workspace 路径和内容访问继续经过 Tool Gateway 或受限 host API。
- 默认不注入 provider key、SSH credential、terminal token 或完整 `process.env`。
- 自动 event hook 第一版只能创建提示或待执行动作，不直接执行写入。
- 每次执行保留开始时间、结束时间、exit code、截断输出和权限决策。

### 10.6 安装与信任

第一版仅允许用户明确选择本地目录并 link：

1. 解析并验证 Manifest。
2. 展示将运行的命令、权限和事件。
3. 用户确认后注册。
4. 默认禁用自动事件。
5. 支持 disable、unlink 和清理 state。

未来若支持远端安装，必须增加签名、来源固定、revision pin、安装预览和可回滚更新。

### 10.7 验收标准

- 扩展不能绕过 Tool Gateway 直接取得受保护能力。
- 未声明权限的访问稳定失败。
- command 超时、取消、进程退出和输出上限均有测试。
- 一个扩展崩溃不影响 Main、Terminal daemon 或其他扩展。
- 支持包默认不包含扩展输出中的敏感内容。
- disable 后不再响应事件；unlink 不删除用户拥有的源码目录。

---

## 11. 分期与依赖

### Phase 0：合同与 ADR

- 为 Agent Presence、Agent API、后台生命周期和 Extension Trust 分别形成 ADR。
- 确认状态模型、structured/observed 边界和“不完成 Mission”的硬约束。
- 设计 IPC schema、数据库恢复策略和事件版本。
- 录制当前 Claude/Codex/Kimi 真实 TUI fixture。

交付物：类型合同、ADR、fixture 工具和测试矩阵。

### Phase 1：Agent Presence 与语义 API

实施能力一和能力二：

- `AgentPresenceEngine`
- 当前三家的 lifecycle manifest
- 状态仲裁与稳定
- `agent.status/explain/prompt/wait/sendKeys`
- Session Rail、For You、Worker Wall 的最小接入

这是最高价值、也是后续能力的基础。

### Phase 2：读取与图片输入

实施能力三和能力五：

- transcript read mode
- interaction lease
- local image-to-path
- SSH/SFTP image-to-remote-path

两者都依赖稳定 Agent identity 和 idle 判断。

### Phase 3：后台窗口 detach

实施能力四阶段 A：

- close window while Main remains alive
- tray/menu status
- reopen/restore
- quit-and-stop teardown
- background local、Mission 和 SSH 验证

完全退出后的 runtime reattach 另立后续 Mission，不混入此阶段。

### Phase 4：Adapter Pack

实施能力六：

- Manifest 分层
- 当前三家完整化
- Wave 2 Agent
- 本地 override 与签名 Pack 设计

### Phase 5：受限扩展

实施能力七：

- local link
- action/event contracts
- permission preview
- process runner、日志、禁用与隔离

插件是最后阶段。状态、身份、权限和运行时边界未稳定前，不应先开放可执行生态。

## 12. 跨能力风险

### 12.1 状态误判

风险：错误 Done、漏报 blocker、TUI 版本变化。

控制：

- 正式 `unknown`。
- Explain diagnostics。
- 规则版本化和 fixture。
- 强信号与弱信号分级。
- 问题 Pack 可禁用或回滚。

### 12.2 状态数量污染 UX

风险：主界面充满技术标签。

控制：

- 主界面只显示 Working、Needs you、Done、Unknown。
- structured/observed、规则和 evidence 放在诊断层。
- process exited 与 lifecycle 分离，避免组合爆炸。

### 12.3 后台资源和费用

风险：用户以为退出后停止，但 Agent 仍消耗 CPU、Token 或远端资源。

控制：

- 明确退出选择。
- tray/menu 常驻指示。
- Stop all。
- 后台通知和资源摘要。

### 12.4 自动终端输入干扰用户

风险：transcript scroll、图片路径或 Agent prompt 与用户输入竞争。

控制：

- 单写者和 interaction lease。
- 用户输入优先。
- 默认不自动 Enter 图片路径。
- transcript read 仅显式启用。

### 12.5 扩展供应链

风险：Adapter/Extension 获得用户权限后执行恶意代码。

控制：

- 第一版 local-only。
- 最小环境和权限声明。
- Tool Gateway。
- 远端来源必须签名和 pin revision。
- 安装预览、禁用和回滚。

## 13. 测试与验证策略

### 13.1 单元测试

- Manifest schema、优先级、region 和布尔组合规则。
- stale sequence、Hook authority 和 fallback arbitration。
- working-to-idle debounce、done/seen 聚合。
- Agent wait race、identity replacement、cancel、timeout。
- viewport row alignment、fixed header、soft-wrap、restore。
- image MIME、size、path、权限、TTL 和取消。
- extension manifest、权限、输出上限和进程隔离。

### 13.2 录制 TUI fixture

每个受支持 Agent 至少保留：

- fresh startup
- trust/update gate
- idle composer
- working spinner/progress
- permission/question blocker
- transcript/history viewer
- normal exit
- narrow viewport

Fixture 应保留 ANSI/OSC 输入和预期 explain 结果，而不是只存清洗后的字符串。

### 13.3 Electron E2E

按仓库既有规则：

- renderer、preload、main、shared package 变更后先运行 `npm run build`。
- 使用 `tests/e2e/helpers/launch.ts` 和隔离 user-data。
- 先运行目标 spec；修复后重复受影响测试三次，再运行完整 Electron suite。
- QA 截图、trace 和临时 fixture 放在 `/tmp`。
- 验证标准桌面 viewport 和较窄 viewport。
- 检查页面 identity、非空渲染、console/page error 和主交互路径。

建议新增目标 spec：

```text
agent-presence.spec.ts
agent-control.spec.ts
terminal-transcript-read.spec.ts
background-runtime.spec.ts
external-image-paste.spec.ts
agent-adapter.spec.ts
workflow-extension.spec.ts
```

### 13.4 真实 Agent 验证

状态和 TUI 读取不能只使用 fake CLI。每个 Wave 在发布前至少进行一次受控真实 Claude/Codex/Kimi 验证，并记录版本、平台、viewport 和状态轨迹。

## 14. 完成定义

七项能力全部完成，需要同时满足：

- 外部 Agent 的状态可查询、可解释、可等待。
- `unknown` 是可见且稳定的降级状态。
- Agent 状态不会隐式完成 Mission/Assignment。
- transcript read 不干扰用户且能恢复 viewport。
- 关闭窗口后台运行期间，文件核算、Mission、通知和 SSH 不断档。
- 外部本地和 SSH TUI 都能安全接收图片路径。
- Agent 支持由能力 Manifest 证明，不靠硬编码 Agent 名字。
- 可执行扩展不能绕过 Tool Gateway 和权限预览。
- 目标 Electron E2E 稳定重复通过，完整检查无新增失败。
- 文档、诊断、设置和退出语义与实现一致。

## 15. 明确不做

本计划不包括：

- 把 Charter UI 改造成 Herdr 风格的 TUI workspace/tab/pane。
- 用 Agent idle/done 替代 Charter Review 或证据完成条件。
- 重写 Charter 已有 Worktree、Mission、SSH、SFTP 或 Terminal 控制底座。
- 第一版实现 Electron Main 完全退出后的完整 Mission/SSH 持续运行。
- 加载未签名的远端 lifecycle manifest。
- 第一版允许插件注入 renderer 原生 UI 或获得完整主机权限。
- 为了扩大 Agent 数量而虚报 unsupported capability。

## 16. 源码依据

### Herdr

- Agent 状态模型：`~/git/herdr/src/detect/mod.rs`
- Codex/Claude lifecycle 规则：`~/git/herdr/src/detect/manifests/`
- 状态稳定：`~/git/herdr/src/pane/agent_detection.rs`
- Hook 与 fallback 仲裁：`~/git/herdr/src/terminal/state.rs`
- Agent wait/prompt：`~/git/herdr/src/api/wait.rs`
- Agent explain：`~/git/herdr/src/app/api/agents.rs`
- Alternate-screen 读取：`~/git/herdr/src/server/alt_screen_read.rs`
- viewport 合并：`~/git/herdr/src/terminal/history_read.rs`
- 常驻 server/client：`~/git/herdr/src/server/headless.rs`、`~/git/herdr/src/client/mod.rs`
- 本地图片远端桥：`~/git/herdr/src/server/clipboard_image.rs`
- 插件 Manifest/runtime：`~/git/herdr/src/app/api/plugins/`

### Charter

- Agent Registry：`apps/desktop-main/src/services/agent-registry.ts`
- Built-in Agent Manifest：`apps/desktop-main/src/services/builtin-agent-manifests.json`
- External Session 状态与回合：`apps/desktop-main/src/services/external-session-service.ts`
- Terminal control：`apps/desktop-main/src/services/terminal-control-service.ts`
- Terminal VT model：`packages/terminal-service/src/index.ts`
- Terminal daemon：`apps/desktop-main/src/services/terminal-daemon-*.ts`
- 当前退出 teardown：`apps/desktop-main/src/index.ts`
- SSH/SFTP：`apps/desktop-main/src/services/ssh-*.ts`
- 图片附件：`apps/desktop-main/src/ipc/context-attachment-handlers.ts`
- Skills：`apps/desktop-main/src/services/skill-store.ts`
- Worktree：`apps/desktop-main/src/services/worktree-service.ts`

