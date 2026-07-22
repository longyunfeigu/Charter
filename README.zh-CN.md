<div align="center">

# Charter

### 让 Agent 快速行动，让每一步始终可见。

**Charter 是一款为“需要交付证据”的编码 Agent 打造的本地优先驾驶舱。**<br>
在真实代码仓库中运行内置 Charter Agent、Claude Code 和 Codex；实时看见每一次修改，从正在运行的产品里直接反馈，并基于证据而不是承诺批准结果。

*Agent 说它做完了，Charter 告诉你为什么可以相信。*

[![Beta 2](https://img.shields.io/badge/release-v1.0.0--beta.2-C47A19?style=flat-square)](https://github.com/longyunfeigu/Charter/releases/tag/v1.0.0-beta.2)
[![CI](https://img.shields.io/github/actions/workflow/status/longyunfeigu/Charter/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/longyunfeigu/Charter/actions/workflows/ci.yml)
[![macOS](https://img.shields.io/badge/macOS-Apple_Silicon-1B1A16?style=flat-square&logo=apple&logoColor=white)](https://github.com/longyunfeigu/Charter/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows&logoColor=white)](https://github.com/longyunfeigu/Charter/releases/latest)
[![Linux](https://img.shields.io/badge/Linux-x64-F4B728?style=flat-square&logo=linux&logoColor=111111)](https://github.com/longyunfeigu/Charter/releases/latest)
[![MIT License](https://img.shields.io/badge/license-MIT-2F855A?style=flat-square)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md)

[下载 Beta](https://github.com/longyunfeigu/Charter/releases/latest) · [产品导览](#产品导览) · [功能全景](#功能全景) · [快速开始](#快速开始) · [架构](#架构)

</div>

![Charter Session 同时展示对话、实时文件活动、内联 Diff、验证结果和审查操作](docs/assets/readme/session-diff.png)

<p align="center"><sub>一个真实的 Charter Session：对话、实时工作、代码、验证与最终决策同屏呈现。README 中的界面截图均由 Playwright 直接从 Electron 应用采集。</sub></p>

> [!IMPORTANT]
> Charter 当前是**开发预览版**。Beta 安装包尚未签名或公证，操作系统安全策略可能发出警告或直接阻止运行。已发布版本均附带 SHA-256 校验和、SBOM 和机器可读的发布清单。请勿全局关闭操作系统安全机制；如果本机不允许 unsigned 应用，请从源码构建。

## 为什么选择 Charter

编码 Agent 可以很快，但一个转圈动画不等于可观测，一段自动生成的总结也不等于证明。

多数 Agent 工具优化的是“发出 Prompt”的那一刻。Charter 更关注之后发生的一切：现在正在做什么、什么时候需要你介入、结果能否在真实环境中运行，以及这些改动是否值得保留。

| 常见的 Agent 工作流 | Charter 工作流 |
| --- | --- |
| 等待完整转录或最终总结 | 实时查看当前动作、文件写入、命令与 Diff |
| 在对话、终端、编辑器和浏览器之间来回切换 | 把对话、真实 PTY、文件与 Live Preview 放在同一个 Session 中 |
| 凭记忆描述一个视觉问题 | 选中准确元素或圈出区域，把结构化视觉上下文发回 Agent |
| 不断回来确认 Agent 是否完成 | 由 Charter 把你带回真正需要关注的那个 Session |
| 下周再次重复同一个纠正 | 把审查反馈沉淀为可编辑、归项目所有的规则 |
| 相信模型生成的“已完成” | 批准前审查真实改动、检查结果、预览证据与完整历史 |

在 Charter 中，**Session** 是一次人机协作的持久对象，而不只是一段聊天：

```text
Session = 项目 + Agent + Worktree + 对话 + 计划
        + 实时活动 + 文件 + 终端 + 预览
        + 验证 + 审查 + 回放 + 记忆
```

### 一条不中断的闭环

| 1. 发起 | 2. 观察 | 3. 干预 | 4. 决策 |
| --- | --- | --- | --- |
| 选择项目、Agent、自主模式、模型和验证计划 | 实时跟踪工具调用、文件热度、命令、子 Worker 与进度 | 在运行中附加代码、终端输出、截图、Preview 元素或新的纠正 | 检查 Diff 与验证，要求修改、批准、合回主目录，或逐字节回滚 |

长任务可以放心离开。回来时，同一段对话、PTY、文件、证据和决策状态仍然都在，不需要重新拼凑上下文。

## 产品导览

### 看见修改发生，而不是只看转圈

工作间（Room）会说明 Agent 当前调用的工具，Session 画布则在文件被写入时实时显示热度。节奏条、写入信标、增删行数和时间账本都来自同一批事件。点击活跃文件即可查看进行中的 Diff，不必离开对话。

![Charter 在运行中的 Session 内展示实时文件活动、写入热度、节奏与当前工具动作](docs/assets/readme/live-file-activity.png)

- **动作就在眼前：** 查看当前动作、目标路径、耗时、Token 流以及读写状态。
- **文件级信号：** 热、温、冷却中的文件卡片清楚显示工作集中在哪里。
- **运行中纠偏：** Agent 工作时仍可追加指令和结构化上下文，无需整段重启。
- **同一条事件流：** 会话栏、工作间、Diff、Review 与 Replay 读取同一份账本，信息不会互相打架。

### 一个 Composer，选择最适合的 Agent

从同一个 Composer 启动受管 Charter Agent、Claude Code 或 Codex。开始前可以选择项目、权限模式、模型、思考级别和检查项。

![Charter Composer 在同一个 Agent Picker 中展示 Charter Agent、Claude Code 和 Codex](docs/assets/readme/agent-picker.png)

受管 Agent 通过 Charter 的 Tool Gateway 工作。已安装的 Claude Code 与 Codex CLI 保留原生终端体验和原始会话身份；Charter 负责保留 PTY、核算仓库改动，并把结果带入同一套审查模型。

一个 Session 还可以指挥由 shell、Claude Code 和 Codex 组成的可见 Worker 编队。Worker 始终有明确归属，任务结束后也会保持打开以便追问；审批、暂停、接管和控制动作都留在台面上，而不是消失在后台任务里。

### 在真实产品里预览，直接指出哪里不对

Charter 会识别属于当前任务目录的回环地址开发服务器，并把它打开在对话旁边。不必切换窗口，也不必再说“按钮旁边那段橙色文字”。

![Charter 在 Session 对话旁展示 Live Preview，并准备把选中的页面元素发给 Agent](docs/assets/readme/live-preview.png)

- **任何阶段都能打开：** 运行中、审查时和任务结束后都可以继续使用 Preview。
- **选择页面元素：** 附上真实 selector、边界、文字、页面 URL 与截图。
- **圈选区域：** 当 DOM selector 不适合描述问题时，直接标出视觉区域。
- **把错误带回来：** 手动发送捕获到的 Preview Console 错误，或使用有边界的自动策略。
- **隔离必须真实：** Worktree Session 只显示归属于自身任务目录的服务器。

### 你可以离开，Charter 会在需要时叫你回来

当 Agent 完成、等待批准、回答问题或进入审查状态时，Charter 会显示可点击通知。对应 Session 还会在会话栏中短暂产生涟漪和回复提示，让你能快速找到它，又不会把整个应用做成警报面板。

![Charter 完成通知，以及会话栏中通过水波提示需要关注的对应 Session](docs/assets/readme/completion-attention.png)

通知可以配置；没有打扰你的已完成工作，仍然可以从 Session 历史中随时找回。

### 先看证明，再决定是否批准

Review 不是聊天结束时弹出的总结窗口。Charter 把结果、改动文件、增删行、验证历史和最终操作放在同一个区域。

![Charter Review 展示改动文件、通过的验证，以及要求修改、回滚和批准操作](docs/assets/readme/session-review.png)

你可以检查内联 Diff 或无障碍文本 Diff、重新运行检查、带着具体行上下文要求修改、回滚已记录的变更集，或者批准结果。检查历史不可变：一次新运行不会覆盖旧失败，过期或被替代的证据仍然可见。完成的 Session 可以通过结果优先的 **Recap**、更深入的 **Explore** 和证据优先的 **Verify** 三种视图回看。

### 让这一次纠正真正改善下一次工作

Charter 会把审查反馈记录为 Memory 候选，让你编辑或丢弃，并将确认后的规则写入项目内可随 Git 共享的 `.charter/rules.md`。

![Charter Memory 管理器展示项目规则、注入统计和可选的分发目标](docs/assets/readme/memory-management.png)

- **把审查变成学习：** 将要求修改或计划纠正转成明确、可复用的规则。
- **可量化的复用：** 查看规则被注入到哪些任务，以及相同问题是否再次发生。
- **可控分发：** 可以选择把受管区块投射到 `CLAUDE.md` 或 `AGENTS.md`。
- **不静默覆盖：** 手工修改过的受管区块必须明确选择导入、覆盖或停止。
- **私有记忆仍然私有：** 只有你主动选择，外部 CLI 的记忆才会被提升为项目规则。

## 功能全景

如果只想快速知道 Charter 到底能做什么，可以先看这张表：

| 我想做什么 | 从哪里开始 | Charter 会做什么 |
| --- | --- | --- |
| 让 Agent 修改一个仓库 | 点击 **New Session**，选择项目和 Agent | 建立独立 Session；按所选模式规划、修改、运行命令，并把全过程记入账本 |
| 使用现成的 Claude Code / Codex | 在 Composer 的 Agent Picker 中选择对应 CLI | 打开真实交互终端，保留原生体验，同时记录会话身份、工作目录和文件改动 |
| 看 Agent 此刻在改哪里 | 打开 Session Room | 实时显示当前工具、正在写入的文件、增删行、耗时和命令；点击文件即可看进行中的 Diff |
| 检查网页修改效果 | 打开 Session 的 **Preview** | 识别当前任务的开发服务器；可以操作页面、选择元素、圈出区域并把反馈发回 Agent |
| 决定是否保留改动 | 打开 **Review** | 按文件或 Hunk 查看 Diff 和验证历史，然后要求修改、批准、回滚或丢弃 Worktree |
| 找回以前的 Agent 会话 | 点击项目旁的时钟，或进入 **Agent activity** | 只读扫描支持的 Claude Code / Codex 历史，按时间和项目归类，并可一键 Resume |
| 管理长期规则和 Skills | 打开 **Memory** 或 **Skills** | 编辑项目规则、检查 Skill 安装位置和使用量，按 Agent 启用或停用 |

### Session 与 Agent 编排

- **新建任务时一次选全：** 在 **New Session** Composer 中选择项目、Charter Agent / Claude Code / Codex、自主模式、模型、思考级别和预设验证项，然后直接描述目标。
- **Charter Agent：** 由应用内模型循环执行，文件读取、写入、搜索和命令都经过 Tool Gateway；每一步都能进入权限判断和证据账本。
- **Claude Code / Codex：** 直接启动本机已经安装的 CLI 和真实 PTY，不套一层假的聊天界面；Charter 会识别 CLI 进程、会话 ID、工作目录和结束状态，并把仓库改动带入 Review。
- **四种模式有明确区别：** `Read` 只回答问题，不写文件也不执行命令；`Approve` 先给计划，每次写入或命令都询问；`Auto` 自动执行低风险动作、遇到风险暂停；`Full` 自动执行并应用结果，但禁止动作、验证失败和合并冲突仍会被拦下，事后也可以回滚。
- **计划不是一段普通回复：** 写入前会出现结构化计划卡；你可以查看步骤和验证方式，再点击 **Approve plan** 放行。计划未批准时，受计划保护的写入不会开始。
- **一个 Session 可以指挥多个 Worker：** 主 Agent 可以创建 shell、Claude Code 或 Codex 子会话。工作间会显示 Worker 监看墙、当前输出、待审批和失败状态，并提供 **Pause all**、单 Worker 暂停与接管。
- **会话可以接着聊：** 受管 Session 完成后可在同一个 Room 继续追问；已结束的 Claude Code / Codex 会话会出现 **Resume Claude/Codex session**，使用记录下来的会话身份和目录继续工作。
- **多个仓库也不会混在一起：** 左侧会话栏按项目组织 Session，显示运行中、Needs you、Review 和 History；切换 Session 时，项目、Worktree、终端和 Preview 上下文会一起切换。

### 观察与干预

- **当前动作会持续更新：** Room 中直接显示 Agent 正在 Read、Write、Search、Run 还是 Verify，同时列出目标路径、耗时、Token 和命令退出状态。
- **文件写到哪里，信号就走到哪里：** 活跃文件卡会出现写入信标和热度变化，并显示 `+N / -N`；点击卡片即可在旁边打开只读 File Peek 或实时 Diff。
- **上下文不必复制粘贴：** 可以从项目树拖入文件或目录，用 `@` Picker 搜索文件，选中代码后点击“添加到上下文”，或把搜索结果、终端选区、图片和 Preview 反馈附到 Composer。发送后的消息会保留引用来源。
- **运行中也能纠偏：** Agent 尚未结束时，可以在同一个 Composer 追加“先别改这个文件”或新的文件引用；指令会进入当前 Session，而不是另开一个失去上下文的新任务。
- **截图直通车有三个明确动作：** macOS 新截图或剪贴板截图出现后，右下角卡片可以 **Feed to agent**、**Annotate first**（画框、打码后再发），或 **Save to project assets** 保存到 `assets/screenshots/` 而不发送消息。
- **不用守着长任务：** Agent 等待批准、完成回答或进入 Review 时，会弹出可点击通知；左侧准确的 Session 行同时产生短暂涟漪，**Needs you** 筛选也会汇总所有待处理会话。
- **会话考古按真实时间组织：** **Agent activity** 会只读扫描受支持的 `~/.claude` 和 `~/.codex` 历史，按 Today、Yesterday、Past 7 days、Earlier 分组，并用 All / External / Tracked 筛选。外部记录可以点击 **Resume** 收编，已跟踪记录则直接 **Open**。
- **状态不含糊：** 工作中、等待权限、等待计划、待审查、已回答、已批准、已回滚、已中断和外部 CLI 已结束都会使用不同状态；没有文件改动的回答不会伪装成“等待代码审查”。

### 文件、编辑器与终端

- **项目树能直接完成常用文件操作：** 新建文件/目录、重命名、移入系统废纸篓、复制路径；HTML 文件还可以通过 **Open in Browser** 用默认浏览器打开。把任意行拖进 Composer，即可作为上下文发送。
- **Git 状态就在文件名旁：** 新文件显示 `A`，修改或重命名显示 `M / R` 与真实 `+N -N` 行数；目录也会提示内部存在改动，不必先打开 Source Control 才知道 Agent 碰过哪里。
- **快速找到项目和文件：** `⌘K` 在项目、Session、文件和操作之间统一搜索；`⌘P` 按文件名 Quick Open；Workspace Search 支持全文/正则搜索，并在实际替换前给出预览。
- **不离开 Room 也能读代码：** 点击对话、时间线或文件树里的路径会打开 File Peek，可在 File / Diff 间切换并固定多个 Tab。需要修改时再点 **Open in editor**，Session 对话仍然保留。
- **编辑器不是只能看：** 代码和 JSON 使用 Monaco；Markdown 可以切换到富文本编辑；图片支持画框、箭头、文字和打码，并以副本保存。所有写入仍走统一的保存、冲突检测和变更记录。
- **基础语言能力可直接用：** 支持的语言可以查看 Problems、跳转定义和预览重命名；Python 未安装兼容 Language Server 时会显示安装指引，而不是假装已经提供诊断。
- **终端是真实 PTY：** 可以运行交互式 CLI、测试、开发服务器、vim 等程序。每条命令形成独立 Block，保留输出、退出码、耗时和进度，并支持跳转与重新运行；切换页面后进程和滚动缓冲不会丢失。
- **`⌥Space` 速召台：** 无论当前在哪个页面，都能拉起临时或项目终端；选中一段输出后可以直接 **Send to Room**，不必把整屏日志复制进 Prompt。
- **终端路径可以直接打开：** `src/app.ts:42` 会跳到对应文件和行；本地 HTML 可以交给默认浏览器；带空格或中文的真实路径会先经过文件系统确认，减少误识别。
- **皮肤不只是换强调色：** Studio、Terminal、Archive 和 Index 会一起调整背景、字体、图标、编辑器与终端配色；Light / Dark / System 主题仍可独立选择。

### Preview、变更控制与证据

- **Preview 会先确认服务器属于谁：** Charter 按进程工作目录寻找当前项目或 Worktree 的回环地址端口；如果没有服务器，会显示可启动的开发命令。启动后可随时查看 **Dev log**、刷新页面或在外部浏览器打开。
- **页面反馈可以精确到元素：** 普通模式下直接操作应用；点击 **Pick** 后选择一个 DOM 元素，Charter 会附上 selector、文字、边界、URL 和截图；点击 **Draw** 可以圈出一块区域。两种结果都会成为 Composer 中可见的附件。
- **Console 错误也能作为上下文：** Preview 会统计页面 Console 错误，展开后可以检查并手动发给 Agent；自动转发只在配置允许的边界内发生。
- **编码任务可以使用独立 Worktree：** Agent 的修改不会立刻污染主 Checkout。任务结束后明确选择批准并合回，或者点击 **Discard worktree** 丢弃隔离目录。
- **Diff 基于记录的起点，而不是 Agent 的描述：** 每次文件写入都会生成 Change Record 和内容检查点。Review 按新增、修改、删除、重命名列出文件与 `+N -N`，文本文件显示真实基线与当前内容。
- **Review 可以从具体代码继续对话：** 选中 Diff 中的行并点击 **Request changes**，所选行和你的说明会回到同一个 Session。也可以逐文件/逐 Hunk 接受或拒绝，而不必只能“全部接受”。
- **验证历史不会被最后一次运行覆盖：** 预设或手工运行 `npm test` 等检查后，每次结果都保留命令、状态和时间；失败、通过、过期、被替代会分别显示。即使强行接受失败结果，界面也会明确标记为 unverified。
- **最终决策是可操作按钮：** **Approve changes** 保留改动；**Rollback** 把已记录文件恢复到 Session 前的字节内容；存在 Worktree 时则使用 **Discard worktree**。检测到冲突时，危险操作会被阻止并说明原因。
- **Replay 有三种深度：** **Recap** 先展示结果和关键变化；**Explore** 按语义章节查看过程；**Verify** 直接查看主张、证据引用、审批和验证。还可以导出 HTML/JSON 收据，逐行带哈希，并明确列出账本无法证明的边界。
- **PR Draft 不会偷偷发布：** Charter 根据已记录结果生成可复制的分支名、PR 正文和命令建议，但不会自行 commit、push 或创建远程 PR。

### Memory 与 Skills

- **审查意见可以变成候选规则：** 当你要求修改或纠正计划时，Charter 会生成可编辑的 Memory Candidate；只有你确认后，它才会进入项目规则，Dismiss 则不会影响未来任务。
- **规则是普通项目文件：** 已批准规则写入 `.charter/rules.md`，可以随 Git 审查和共享。Memory 页面会显示规则是否启用、注入过多少个任务，以及相同问题是否再次出现。
- **按 Agent 和项目查看记忆：** Memory 顶层区分 Charter、Claude Code 与 Codex，再查看 Global 和各项目文件。受支持的外部记忆可以只读浏览、编辑或明确 Promote 为 Charter 候选，不会被暗中吸收。
- **同步到指令文件前会检查漂移：** 可以把规则投射为 `CLAUDE.md` 或 `AGENTS.md` 中的受管区块；如果区块被手工编辑，Charter 会要求选择 Import、Overwrite 或 Stop，而不是静默覆盖。
- **Skills 页面会列出真实安装情况：** 同一个逻辑 Skill 在 Charter、Claude Code、Codex 中有几份副本、哪些已启用、最后使用时间、总调用次数和对 Pi 上下文的 Token 开销都在一张表里。
- **用量可以按消费方拆开：** 查看 Pi 的精确调用、Claude Code 转录中识别到的使用，以及 Codex 支持范围；按 Most used、Recently used、Highest Pi context 或名称排序，快速找到长期未用或上下文成本高的 Skill。
- **启停不会删除原文件：** 可以按 Agent 单独启用或停用 Skill；外部 Skills 来源默认不受信任，明确连接后才参与实时扫描。来源文件变化后目录会更新，但 Charter 不会接管或改写原目录。
- **运行 Skill 有明确入口：** 点击 **Run a Skill** 回到 Composer，再通过 `/` Picker 搜索并选择已启用 Skill；Agent 收到的是对应版本和内容，而不是仅凭名字猜测。

### 本地状态、安全与隐私

- **项目文件和任务历史默认留在本机：** 项目路径、Session、事件、验证、决策、Replay 与 Memory 元数据保存在本地 SQLite 和有界 Blob 存储中；当前 Beta 不发送遥测或 Crash Report。
- **API Key 不进入 Renderer：** Provider 凭据使用 Electron `safeStorage` 加密。设置界面只能拿到 Provider 名称、端点和脱敏状态，无法读取明文 Key。
- **受管 Agent 不能绕过 Tool Gateway：** 模型循环运行在独立 Worker 中，没有直接文件系统、数据库或静态密钥权限。它提出的读写和命令请求必须回到 Electron Main，经过 Schema、项目路径和权限检查后才能执行。
- **路径边界会在主进程再次确认：** Renderer 即使传入伪造路径，Workspace 服务仍会检查它是否位于当前项目或 Worktree 内；Workspace 外写入、读取密钥、`sudo`、`git push` 和大范围破坏性命令属于硬阻止项。
- **外部 CLI 不假装受管：** Claude Code 与 Codex 的内部权限、网络请求和模型上下文仍由它们自己负责。Charter 能保留 PTY、记录外部观察到的改动并统一 Review，但不会声称控制了 CLI 内部没有暴露的行为。
- **Preview 只允许本机任务服务器：** 嵌入页面限于经过归属判断的回环地址，并限制任意导航、弹窗、权限请求和 Frame 能力；页面不能借 Preview 直接获得终端或文件权限。
- **删除和回滚是不同动作：** 项目树中的普通删除进入系统废纸篓；Session Rollback 根据记录的基线恢复被 Agent 改过的内容；删除 Charter 中的项目记录不会删除磁盘上的仓库文件。

> [!NOTE]
> “本地优先”不等于“离线推理”。Prompt 和你附加的上下文会发送到所配置的模型端点，并遵循对应 Provider 的数据政策。外部 Claude Code 与 Codex 会话也继续使用它们自己的权限和网络模型。

## 快速开始

### 下载 unsigned Beta

从[最新 GitHub Release](https://github.com/longyunfeigu/Charter/releases/latest) 下载当前平台的安装包与 `SHA256SUMS.txt`。

| 平台 | 安装包 | 预览目标 |
| --- | --- | --- |
| macOS | `.dmg` 或 `.zip` | Apple Silicon（`arm64`） |
| Windows | NSIS 安装程序 | `x64` |
| Linux | `.tar.gz` | `x64` Preview |

这些安装包尚未签名或公证。Gatekeeper、SmartScreen、Smart App Control、企业策略或杀毒软件都可能拒绝启动。请在重要仓库中使用前阅读[发布说明](docs/RELEASE_NOTES.md)、[已知限制](docs/KNOWN_LIMITATIONS.md)、[隐私声明](PRIVACY.md)和[安全策略](SECURITY.md)。预览版需要手动更新。

### 从源码运行

环境要求：[Node.js](https://nodejs.org/) **22.19 或更高版本**、npm 和 Git。

```bash
git clone https://github.com/longyunfeigu/Charter.git
cd Charter
npm install
npm run dev
```

首次启动后：

1. 打开一个 Git 项目。
2. 进入 **Settings → Models**，添加 Provider 并拉取模型列表。
3. 创建 Session，选择 Agent 与自主模式，然后描述真正想要的结果。
4. 当任务需要具体上下文时，附加文件、代码行、图片或验证计划。
5. 跟随实时 Session，并在接受改动前审查已经记录的证据。

Charter 提供 Anthropic、OpenAI、OpenRouter 和 LiteLLM 预设，也支持自定义 Anthropic/OpenAI 兼容端点。

如果暂时没有 Provider Key，可以在 macOS 或 Linux 上使用确定性 Mock Runtime 体验完整受管流程：

```bash
PI_IDE_FORCE_MOCK=1 npm run dev
```

如果要使用外部 **Claude Code** 或 **Codex**，请先独立安装对应 CLI，并确保可执行文件已加入 `PATH`。

## 快捷键

下表以 macOS 为准；在 Windows 和 Linux 上，相应操作通常使用 `Ctrl` 替代 `Command`。

| 操作 | 快捷键 | 操作 | 快捷键 |
| --- | --- | --- | --- |
| 搜索一切 | `⌘K` | 新建 Session | `⌘N` |
| 打开 Editor | `⌘E` | 打开速召台 | `⌥Space` |
| 命令面板 | `⌘⇧P` | Quick Open | `⌘P` |
| 打开项目 | `⌘O` | Workspace 搜索 | `⌘⇧F` |
| 切换 Agent Panel | `⌘L` | 切换底部面板 | `⌘J` |
| 新建终端 | `Control+反引号` | 停止当前 Agent | `⌘Esc` |

## 架构

Charter 将产品界面、模型循环、工具执行、项目服务和持久证据划分到不同的信任边界中。

![Charter 六层架构图：体验层、信任桥、控制层、执行层、Workspace 服务层与证据数据层](docs/assets/readme/architecture.webp)

| 平面 | 职责 |
| --- | --- |
| **01 - 体验层** | Session Rail、Room、Editor、Preview、Terminal、Review、Replay、Memory 与 Skills |
| **02 - 信任桥** | 沙箱化 Preload 与带版本的 IPC Schema，是 Renderer 使用高权限能力的唯一通道 |
| **03 - 控制层** | 任务状态、项目上下文、Tool Gateway、权限、Preview、Replay 与编排 |
| **04 - 执行层** | 隔离的受管 Agent Worker，以及单独信任的 Claude Code/Codex PTY |
| **05 - Workspace 服务层** | 文档、搜索/语言、Git/变更追踪、终端与验证 |
| **06 - 证据与数据层** | SQLite 账本、内容 Blob、附件、Worktree、项目规则和操作系统保护的密钥 |

受管 **Agent Worker** 只负责模型循环，不能直接读取文件、运行命令或访问密钥。工具请求会返回 **Electron Main**，由 Tool Gateway 校验 Schema 与 Workspace 边界、应用权限策略、执行操作、脱敏敏感输出并记录证据。

外部 Claude Code 与 Codex 有意保留不同的信任边界。Charter 会保存真实 PTY、观察生命周期与会话身份、核算仓库改动并把结果带入 Review；CLI 内部的权限模型仍由外部工具自身负责。

### 权限模型

| 等级 | 典型操作 | 默认处理 |
| --- | --- | --- |
| **R0 - 只读** | 读取文件、搜索、诊断、`git status` 与 `git diff` | 允许 |
| **R1 - Workspace 写入** | 在隔离 Worktree 内创建或修改文件 | 询问，或在计划/模式策略允许后执行 |
| **R2 - 本地执行** | 已知本地命令与验证 | 已知检查可以运行；未知命令需要询问 |
| **R3 - 外部或高后果** | 联网或可能产生明显后果的操作 | 除非文档化的模式策略允许，否则每次都要明确确认 |
| **R4 - 禁止** | `sudo`、`git push`、读取密钥、Workspace 外写入、大范围破坏性命令 | 产品直接拒绝 |

应用层权限并不等同于操作系统沙箱。批准前请审查命令；处理不可信仓库或指令时，请使用额外隔离环境。

## 核心技术

| 层 | 核心技术 |
| --- | --- |
| 桌面壳 | Electron 43、沙箱化 Preload、加固的打包 Fuses |
| 界面 | React 19、Zustand、Vite |
| 编辑 | Monaco Editor、MDXEditor、React Markdown |
| 终端 | node-pty、xterm.js、WebGL、Unicode 11 支持 |
| 搜索 | 基于 ripgrep 的 Workspace 搜索 |
| Agent Runtime | Pi coding-agent 适配层，以及外部 Claude Code/Codex PTY |
| 质量保障 | TypeScript、Vitest、Playwright Electron、安全与性能门禁 |
| 分发 | electron-builder、校验和、SPDX SBOM、发布清单 |

准确的第三方依赖清单会根据发布时的 Lockfile 生成。发布产物如何记录许可证与 Notices，详见 [THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md)。

## 仓库结构

```text
apps/
  desktop-main/       Electron 宿主、IPC 路由、Task Engine 与服务
  desktop-preload/    窄接口、带版本的 Renderer Bridge
  desktop-renderer/   Session-first React 界面
  agent-worker/       隔离的受管模型循环
packages/
  agent-runtime-pi/   Pi Runtime 适配层
  tool-gateway/       工具策略、执行和证据边界
  persistence/        本地 SQLite 状态与账本
  *-service/          Workspace、Git、文件、搜索、终端与验证
tests/
  单元 + 安全 + 性能 + Playwright Electron E2E
docs/
  产品规格、ADR、实施状态与发布证据
```

建议先阅读：

- [实施状态](docs/IMPLEMENTATION_STATUS.md) - 每项功能与里程碑都有相应证据。
- [产品与工程规格](docs/PRODUCT_ENGINEERING_SPEC.md) - 需求、状态机、安全边界与验收标准。
- [Session-first UX 规格](docs/UX_PIVOT_SPEC.md) - 产品对象与壳层模型。
- [架构决策](docs/DECISIONS.md) - ADR 索引与设计理由。
- [发布检查表](docs/RELEASE_CHECKLIST.md) - 已完成的 Beta 门禁与剩余 Stable 门禁。

## 开发

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 构建并以开发模式启动 Electron 应用 |
| `npm run build` | 构建 Renderer、Preload、Main 与 Worker |
| `npm run check` | 运行格式、架构边界与 TypeScript 检查 |
| `npm test` | 运行单元与集成测试 |
| `npm run test:e2e` | 构建并运行 Playwright Electron 测试 |
| `npm run test:security` | 运行密钥扫描、安全测试、构建与安全 E2E |
| `npm run test:perf` | 运行性能门禁 |
| `npm run package -- --dir-only` | 构建用于 Smoke Test 的未打包桌面产物 |

迭代时可以只运行目标 Electron 测试：

```bash
npm run build
npx playwright test \
  --config tests/e2e/playwright.config.ts \
  tests/e2e/session-canvas.spec.ts
```

README 中的产品截图可以从真实应用中重新生成：

```bash
npm run build
CHARTER_README_SHOTS=1 npx playwright test \
  --config tests/e2e/playwright.config.ts \
  tests/e2e/readme-assets.spec.ts
```

## 项目状态

Charter 正在公开开发，并朝首个签名 Stable 桌面版本推进。

- **当前已发布：** `v1.0.0-beta.2` 是首个可下载的 unsigned 公开预览版，支持 macOS Apple Silicon、Windows x64 和 Linux x64。
- **当前源码树已实现：** Session-first 壳层、受管 Agent 路径、外部 CLI 核算与编排、实时文件现场、结构化上下文、Preview、Terminal、Verification、Review、Replay、Memory、Skills 和核心安全边界。
- **发布流水线：** 三平台打包、发布清单、校验和、SBOM/许可证清单、打包态启动测试、数据库升级/恢复演练和无凭据门禁都已就绪。
- **Stable 仍待完成：** Apple 公证、可信 Windows 签名、自动更新、固定任务真实 Provider 评估和项目负责人最终确认。

本 README 描述当前源码树；可下载 Beta 可能落后于 `main` 上正在进行的工作。Beta 2 的准确内容请查看 [Beta 2 发布说明](docs/RELEASE_NOTES.md)，当前实施证据请查看 [IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)。

## 参与贡献

我们尤其欢迎能够强化 Session 模型、证据质量、平台可靠性、安全边界、无障碍体验或发布就绪度的贡献。

1. 先阅读 [AGENTS.md](AGENTS.md) 和相关产品规格或 ADR。
2. 从[实施 Backlog](docs/IMPLEMENTATION_BACKLOG.md) 中选择范围清晰的任务，或创建 Issue 描述希望改变的行为。
3. 保持架构边界，并根据风险补充相应层级的测试。
4. 提交 Pull Request 前运行 `npm run check`、`npm test` 和 `npm run build`；UI 修改需要附带目标 Electron E2E 证据。

请不要把推测性或只完成一部分的行为标记为完成。Charter 的贡献标准很简单：每一项主张都应该有可观察的证据。

## 许可证

Charter 基于 [MIT License](LICENSE) 开源。

---

<div align="center">

**Prompt 发起工作，证据赢得批准。**

[下载 Beta](https://github.com/longyunfeigu/Charter/releases/latest) · [官方网站](https://charter-15n.pages.dev) · [报告问题](https://github.com/longyunfeigu/Charter/issues)

</div>
