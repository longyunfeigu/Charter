# Pi-powered Agentic IDE

## 完整产品与工程实现规格

**版本：v1.0**  
**状态：Implementation Baseline（可直接进入完整产品开发）**  
**发布日期：2026-07-12**  
**目标发布：V1.0 Stable**  
**文档角色：产品需求、UX 规格、技术设计、执行顺序、验收合同的唯一基线**

> **一句话产品定义**  
> 一款本地优先、任务原生、可观察、可审查、可回滚的桌面 Agentic IDE。用户既可以像普通 IDE 一样编辑、搜索、运行和管理 Git，也可以把完整的软件工程任务交给 Pi Agent；系统负责限制权限、同步编辑器状态、展示执行轨迹、保存变更证据，并由用户决定接受、继续或回滚。

## 文档使用规则：交给 Claude Code 时必须遵守

本文件不是概念草案，也不是阶段 0 探针。它定义的是一个边界明确、能够安装和日常使用的 **V1.0 完整产品**。实现者必须从第 14 章的 Milestone 1 按依赖顺序推进到 Milestone 12，并通过第 16 章全部发布门槛后，才可以宣布产品完成。

1. **规范优先级**：验收标准 > 功能需求 > 状态机与数据约束 > 架构决策 > UI 示例。发生冲突时按此顺序处理，并在 `docs/DECISIONS.md` 记录。
2. **禁止缩水**：不得以“先做 demo”“先把 UI 画出来”替代完整实现。占位按钮、静态假数据、跳过权限、只写 happy path 均不算完成。
3. **逐片交付**：每个 Milestone 必须同时提交代码、自动化测试、迁移脚本、用户可见错误处理和对应文档；不能先堆完代码再补测试。
4. **保持可运行**：主分支始终能够安装、启动、打开测试仓库并运行测试。每次提交前执行格式化、类型检查、单元测试和受影响的集成测试。
5. **不暴露 Pi**：只有 `packages/agent-runtime-pi` 可以 import Pi 包。Renderer、UI 组件和业务域不得依赖 Pi 类型。
6. **不复制 Pi 源码**：V1.0 使用 Pi SDK、精确锁定版本；除非公开 API 无法满足已编号需求，并记录 ADR，才允许维护小型补丁。不得直接把 Pi 源码复制进产品仓库。
7. **安全不可省略**：Renderer 隔离、IPC schema 校验、路径边界、权限网关、凭据保护、日志脱敏属于 P0，不得后置为“发布前再做”。
8. **完成必须有证据**：每个任务、Milestone 和发布版本均保存测试输出、验收截图或机器可读报告。Agent 自述“已完成”不构成证据。
9. **维护状态文件**：实现期间持续更新 `IMPLEMENTATION_STATUS.md`，每项只能处于 `NOT_STARTED / IN_PROGRESS / BLOCKED / DONE / VERIFIED`；只有验收测试通过后才能标为 `VERIFIED`。
10. **不得跳过最终发布**：开发包能运行不等于产品完成。必须完成安装包、代码签名准备、升级迁移、崩溃恢复、隐私说明和 Stable 发布检查。

# 1. 执行摘要

## 1.1 产品目标

V1.0 要成为一款个人开发者能够连续日常使用的桌面 IDE，而不是 Pi 的聊天窗口。它必须同时具备两条完整能力链：

- **传统 IDE 链路**：打开仓库 → 浏览/搜索 → 编辑 → 代码智能 → 终端 → Git → 保存与恢复。
- **Agent 工程链路**：定义任务 → Agent 探索与计划 → 权限审批 → 修改代码 → 运行验证 → 审查 Diff → 接受或回滚 → 保存历史。

两条链路共享同一个 Workspace、Document Store、Git 状态和文件版本模型，避免“用户在编辑器中看到一份代码，Agent 在磁盘上处理另一份代码”。

## 1.2 V1.0 产品边界

V1.0 是一个**完整的个人本地产品**，不是 Cursor/VS Code 全功能替代。完整的含义是：定义范围内没有关键断链，用户可安装、配置模型、打开真实仓库、手工开发、交给 Agent 修改、验证、审查、恢复并持续使用。

### V1.0 必须交付

- macOS 与 Windows 可安装桌面包；Linux 提供可运行预览包。
- 文件树、标签页、编辑保存、查找替换、快速打开、全局搜索。
- TypeScript/JavaScript 的完整基础代码智能；Python 的基础 LSP 支持；其他文本文件可编辑。
- 多标签集成终端、命令输出与进程生命周期管理。
- Git 状态、Diff、暂存、取消暂存、丢弃、提交、分支切换和刷新。
- Pi SDK 驱动的 Ask/Edit/Auto 三种 Agent 模式。
- 自有 Tool Gateway、权限策略、结构化 Timeline、任务状态机。
- 文件快照、版本冲突保护、任务级 Diff、部分接受、完整回滚。
- 验证命令、测试结果、完成报告和“未验证”警示。
- 任务历史、崩溃恢复、Worker 重启、设置、模型认证、更新检查。
- 自动化测试、打包、发布清单、安全和性能门槛。

### V1.0 明确不做

- 内联 AI 自动补全、Tab completion。
- 完整图形化 Debugger。
- VS Code 扩展兼容层或扩展市场。
- 多 Agent 并行、云端 Agent、远程仓库执行。
- 实时多人协作、团队 RBAC、企业审计后台。
- Remote SSH、Dev Container、浏览器自动化 Agent。
- 完整操作系统级 sandbox；V1.0 提供应用层权限门，并明确风险。
- 自研模型或训练平台。

这些能力可以进入 V1.1/V2，不得挤占 V1.0 的可靠性与闭环。

# 2. 产品定位、用户与成功指标

## 2.1 目标用户

### Persona A：独立全栈开发者

日常在 1–5 个中小型仓库中工作，希望把 Bug、小功能、测试、重构交给 Agent，但不愿失去对文件、命令和成本的控制。

### Persona B：接手陌生代码库的维护者

需要快速理解模块、搜索调用链、修改多个文件、运行现有测试，并希望 Agent 的每个动作都有来源、Diff 和验证证据。

### Persona C：小团队中的高频开发者

仍通过 Git 与 PR 协作，但希望在本地完成“任务—修改—验证—提交”闭环；不要求 V1.0 提供团队后台。

## 2.2 核心 Job To Be Done

> 当我面对一个可以描述清楚的软件工程任务时，我希望在同一个 IDE 中把任务交给 Agent，并在不丢失手工控制权的前提下看到它读了什么、改了什么、运行了什么、是否验证成功，从而安全地接受、继续修改或全部回滚。

## 2.3 产品原则

1. **任务优先于聊天**：聊天是任务中的交互方式，不是一级数据模型。
2. **可观察而非暴露私有推理**：展示计划、搜索、工具、文件、输出和证据，不展示模型隐藏思维链。
3. **默认可逆**：所有 Agent 写入在执行前建立可恢复基线。
4. **最小权限**：模型只拥有 IDE 明确暴露的工具，权限由宿主决定。
5. **证据式完成**：完成报告必须区分已验证、验证失败、未验证和用户跳过。
6. **单一文档事实源**：编辑器 buffer、磁盘、Diff、Agent 读取共享版本标识。
7. **Runtime 可替换**：Pi 是第一实现，不是 UI 和业务层的永久耦合。
8. **Local-first**：代码、任务、Timeline、Diff 默认留在本机。
9. **失败可理解**：所有错误给出发生位置、影响、恢复动作和支持信息。
10. **性能服从工作流**：不追求原生 UI 的理论极限，但不得阻塞输入、滚动或任务控制。

## 2.4 成功指标

| 指标 | V1.0 发布目标 | 计算方式 |
| --- | --- | --- |
| 首次价值时间 | 安装后 10 分钟内完成首次只读问答或小型修改 | 首次启动至首个 `REVIEW_READY` 或 Ask 回答完成 |
| 固定任务成功率 | 20 个固定 JS/TS/Python 任务中至少 14 个无需人工改代码即可达到验收条件 | 离线固定仓库 + 固定任务集，允许模型波动重跑 3 次取中位 |
| 接受率 | 内部 Alpha 中至少 65% 的 Agent 任务最终被全量或部分接受 | Accepted 任务 / 进入 Review Ready 的任务 |
| 数据安全 | 全部回滚基准用例字节级恢复 100% | 快照前后哈希、文件存在性和权限位比较 |
| 稳定性 | 连续 50 次 E2E 任务无窗口崩溃、文件丢失或不可恢复数据库损坏 | 自动化 soak test |
| Crash-free session | 内部 Beta ≥ 99% | 无主窗口崩溃的应用会话占比 |
| 权限合规 | 高风险动作未批准执行次数为 0 | 审计事件 + 故障注入 |
| 交互性能 | 编辑输入 p95 < 50ms；Timeline 事件可见延迟 p95 < 150ms | 参考机器上的自动测量 |

# 3. 核心用户场景

V1.0 必须完整支持以下场景；任何一个场景只能通过手工绕路完成，都视为范围未闭环。

1. **首次启动**：选择模型 Provider、完成认证、选择默认模型、打开本地仓库、确认项目信任。
2. **普通编辑**：打开文件、编辑、撤销/重做、保存、关闭并恢复标签页。
3. **仓库导航**：快速打开文件、全局搜索、查看符号、跳转定义、查找引用。
4. **本地运行**：创建多个终端、运行开发服务器和测试、调整终端大小、停止进程。
5. **Git 工作流**：查看状态和 Diff、暂存、取消暂存、丢弃、输入消息并提交、切换已有分支。
6. **只读 Ask**：询问架构、调用链或 Bug 位置；Agent 不得写文件或执行有副作用命令。
7. **受控 Edit**：定义任务与验收条件，Agent 计划、读取、修改、运行验证；关键动作审批。
8. **Auto 模式**：在用户配置的低/中风险边界内自动执行，遇到高风险或不确定动作暂停。
9. **Full 模式（ADR-0012）**：R1–R3 全部免审批执行，完成后自动应用变更；R4/路径越界仍由 Tool Gateway 硬性拦截，用户的永久 deny 规则依然生效；验证失败/合并冲突降级回人工审查；事后可回滚。
9. **手工与 Agent 交错**：用户可在 Agent 暂停时修改文件；Agent 继续前检测版本变化并重新读取。
10. **权限拒绝**：用户拒绝安装依赖或删除文件；Agent 获得结构化拒绝并调整方案。
11. **冲突处理**：Agent 基于旧版本提交 patch 时不得覆盖用户的新编辑；界面提供重新读取、三方比较或放弃。
12. **审查交付**：按文件/区块查看 Diff，接受全部、接受部分、要求继续修改或回滚全部。
13. **验证失败**：测试失败时 Timeline 保留日志；Agent 可继续修复，用户也可停止并审查当前状态。
14. **崩溃恢复**：关闭应用、Worker 崩溃或系统重启后，任务、Timeline、Diff、未完成状态和可恢复动作仍存在。
15. **切换模型**：在新任务开始前切换 Provider/模型；现有任务记录原模型，不能悄悄改写历史。
16. **导出支持包**：用户可导出已脱敏的诊断信息、版本、错误和日志，而不包含代码与密钥。

# 4. 产品信息架构与主界面

## 4.1 顶层对象

```text
Application
 ├─ Workspace
 │   ├─ Documents / Buffers
 │   ├─ Search / Symbols / Diagnostics
 │   ├─ Terminals
 │   ├─ Git Repository
 │   └─ Tasks
 │       ├─ Goal & Acceptance Criteria
 │       ├─ Agent Session / Runs
 │       ├─ Plan
 │       ├─ Timeline Events
 │       ├─ Permission Decisions
 │       ├─ File Changes / Checkpoints
 │       └─ Verification Runs / Final Report
 ├─ Settings
 ├─ Model Providers & Secrets
 └─ Diagnostics / Updates
```

## 4.2 主窗口布局

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Title Bar / Workspace / Branch / Model / Task Status / Command Palette     │
├──────────────┬──────────────────────────────────────┬──────────────────────┤
│ Activity Bar │ Editor Area                          │ Agent / Task Panel   │
│              │ Tabs · Breadcrumbs · Monaco          │ Goal · Plan          │
│ Explorer     │ Normal / Diff / Conflict             │ Timeline             │
│ Search       │ Optional split editor                │ Permission cards     │
│ Source Ctrl  │                                      │ Completion report    │
│ Tasks        │                                      │                      │
├──────────────┴──────────────────────────────────────┴──────────────────────┤
│ Bottom Panel: Problems · Output · Terminal · Tests · Agent Logs            │
├────────────────────────────────────────────────────────────────────────────┤
│ Status Bar: line/column · language · encoding · Git · diagnostics · Agent  │
└────────────────────────────────────────────────────────────────────────────┘
```

布局要求：

- 左侧 Activity Bar 可切换 Explorer、Search、Source Control、Tasks。
- 中央 Editor Area 至少支持一个主编辑器和一次水平/垂直拆分。
- 右侧 Agent Panel 可隐藏、调整宽度；运行中显示任务状态和停止按钮。
- Bottom Panel 可拖动高度、最大化、切换标签。
- 面板宽高、打开标签、选中视图、窗口尺寸按 Workspace 恢复。
- 1280×720 为最低可用尺寸；低于此尺寸可折叠右侧栏，不允许核心按钮溢出。

## 4.3 页面与视图

| 视图 | 必须包含 | 关键状态 |
| --- | --- | --- |
| 欢迎/最近项目 | 打开文件夹、最近 Workspace、版本、文档入口、恢复上次会话 | 首次启动、无最近项目、项目不可访问 |
| 首次设置向导 | Provider、认证、默认模型、隐私与更新、项目信任说明 | 认证成功/失败、无可用模型、跳过 |
| Explorer | 文件树、新建/重命名/删除、刷新、折叠、忽略项提示 | 加载、权限不足、外部变化 |
| Search | 关键词、大小写/正则/全词、包含/排除、结果分组、替换预览 | 无结果、取消、错误 |
| Source Control | 状态分组、Diff、stage/unstage/discard、commit、分支 | 非 Git、冲突、Git 不可用 |
| Tasks | 新任务、进行中、待审查、历史、筛选 | 空状态、恢复中、失败 |
| Agent Panel | 目标、验收条件、模式、模型、计划、输入框、Timeline、停止/继续 | 探索、审批、执行、验证、审查 |
| Review | 文件清单、增删行、区块接受/拒绝、验证摘要、接受/回滚 | 冲突、已部分接受、未验证 |
| Settings | General、Editor、Agent、Models、Permissions、Privacy、Updates、About | 未保存、验证错误、需要重启 |
| Diagnostics | 应用/Runtime/LSP/Git 状态、日志级别、支持包 | 脱敏预览、导出成功/失败 |

## 4.4 默认快捷键

| 动作 | macOS | Windows/Linux |
| --- | --- | --- |
| 命令面板 | Cmd+Shift+P | Ctrl+Shift+P |
| 快速打开 | Cmd+P | Ctrl+P |
| 全局搜索 | Cmd+Shift+F | Ctrl+Shift+F |
| 保存 | Cmd+S | Ctrl+S |
| 全部保存 | Cmd+Alt+S | Ctrl+K S |
| 新建任务 | Cmd+Shift+I | Ctrl+Shift+I |
| 切换 Agent Panel | Cmd+L | Ctrl+L |
| 停止 Agent | Cmd+Esc | Ctrl+Esc |
| 打开终端 | Ctrl+` | Ctrl+` |
| 切换 Bottom Panel | Cmd+J | Ctrl+J |
| 打开 Source Control | Ctrl+Shift+G | Ctrl+Shift+G |
| 跳转定义 | F12 | F12 |
| 查找引用 | Shift+F12 | Shift+F12 |
| 重命名符号 | F2 | F2 |

# 5. 端到端用户流程

## 5.1 首次启动与认证

1. 应用展示欢迎页，不自动读取任意目录。
2. 用户选择“配置模型”，进入 Provider 列表。
3. Provider 由 Pi `ModelRegistry` 暴露，经产品 Adapter 转为统一展示模型；界面不直接消费 Pi 类型。
4. 用户完成 OAuth 或 API Key 配置。密钥只进入 Main/Agent Worker 的 Secret Store，不进入 Renderer、URL、localStorage、普通日志或崩溃报告。
5. 应用调用最小模型探测请求；成功后保存 Provider 引用、默认模型和思考等级，不保存探测内容。
6. 用户打开目录，应用解析真实路径、检查权限、Git、项目规模和 `.pi`/`.agents` 本地资源。
7. 如仓库含可执行项目资源，必须显示项目信任对话框。默认“不加载项目本地 Pi 扩展/包/技能”，直到用户明确允许。
8. Workspace 打开后，恢复上次布局或显示 Explorer 空闲状态。

## 5.2 新建 Agent 任务

任务表单字段：

- 标题：必填，可从目标自动生成但用户可编辑。
- 目标：必填，支持多行 Markdown。
- 验收条件：至少一项；用户可选择“暂不填写”，但 UI 持续显示风险提示。
- 模式：Ask / Edit / Auto。
- 模型与思考等级：默认继承 Workspace，可按任务覆盖。
- 验证命令：可选多项；支持从 `package.json`、Python 配置或上次运行建议中选择。
- 范围提示：可选路径、文件、符号或当前选区。

创建后：

- Ask 模式直接进入 `EXPLORING`，工具集为只读。
- Edit/Auto 模式进入 `EXPLORING`，首次写入前必须生成结构化计划；Edit 默认等待计划批准，Auto 可按设置自动批准低风险计划。
- Task ID、Workspace ID、模型、初始 Git HEAD/状态和文件快照清单立即持久化。

## 5.3 Agent 执行与交互

- Timeline 按实际时间顺序显示：用户消息、Agent 可见回复、计划、工具请求、权限、工具结果、文件变更、验证、错误和系统恢复事件。
- 流式文本可以增量渲染，但落库时合并为稳定消息，并保留原始事件序号。
- 用户可在运行时发送 `steer` 指令；“下一轮再做”的内容作为 `followUp` 排队。
- 用户点击停止时，Runtime 进入 `ABORTING`，停止继续发起工具；正在运行的命令先发送终止信号，超时后强制结束进程树。
- 中止不自动回滚；任务进入 `INTERRUPTED`，用户可审查、继续或回滚。

## 5.4 修改、审查与接受

1. 所有写操作经 `ChangeService`，不能由 Pi 直接使用任意文件 API。
2. 第一次触碰文件前保存基线：路径、存在性、原始字节、哈希、权限位、换行符和编码。
3. patch 包含 `baseRevision/baseHash`；不匹配时拒绝并产生冲突事件。
4. 成功修改后同步 Monaco model、磁盘、文件监听器和 Git 状态。
5. Agent 宣布任务完成时只进入 `VERIFYING` 或 `REVIEW_READY`，不会自动接受。（ADR-0012 修订：用户显式选择的 Full 模式例外 —— 完成后由系统自动 accept（actor=system:full-auto）；验证失败或合并冲突时仍停在 REVIEW_READY；快照保留，ACCEPTED 后可回滚。）
6. Review 页面展示任务级文件清单、增删统计、每个 hunk、验证结果、风险提示和未解决诊断。
7. 用户可以接受全部、逐文件接受、逐 hunk 接受、要求继续修改或完整回滚。
8. `ACCEPTED` 只表示用户接受当前工作区变化，不等于已 Git commit；提交是单独动作。
9. 回滚恢复任务首次修改前的字节状态，同时保护任务开始后由用户或外部进程产生且无法归属的变化；出现歧义时进入冲突界面，绝不静默覆盖。

## 5.5 崩溃与恢复

- 主窗口重启时扫描处于运行中、审批中、验证中或中断中的任务。
- 由于进程已终止，原运行标记为 `INTERRUPTED_BY_RESTART`，不伪装成继续运行。
- 恢复页显示最后安全事件、未完成工具、文件快照完整性、当前磁盘差异和可选动作：恢复 Agent、仅审查、回滚、放弃任务。
- Pi Session 可恢复时从保存的 session 引用继续；不可恢复时创建新 Pi Session，并注入结构化恢复摘要，原历史保持只读。

# 6. 状态机与业务规则

## 6.1 Task 状态

| 状态 | 含义 | 允许进入 | 允许离开 |
| --- | --- | --- | --- |
| DRAFT | 任务表单尚未启动 | 新建 | READY、CANCELLED |
| READY | 任务已持久化，等待运行 | DRAFT、INTERRUPTED | EXPLORING、CANCELLED |
| EXPLORING | Agent 只读探索与理解 | READY、IN_PROGRESS | PLANNING、IN_PROGRESS、FAILED、INTERRUPTED |
| PLANNING | 形成结构化计划 | EXPLORING、IN_PROGRESS | AWAITING_PLAN_APPROVAL、IN_PROGRESS、FAILED |
| AWAITING_PLAN_APPROVAL | 等待用户批准/编辑计划 | PLANNING | IN_PROGRESS、CANCELLED |
| IN_PROGRESS | 执行工具与修改 | EXPLORING、AWAITING_PLAN_APPROVAL、AWAITING_PERMISSION、INTERRUPTED | AWAITING_PERMISSION、VERIFYING、REVIEW_READY、FAILED、INTERRUPTED |
| AWAITING_PERMISSION | 一个或多个工具等待决定 | IN_PROGRESS | IN_PROGRESS、INTERRUPTED、FAILED |
| VERIFYING | 运行测试/构建/检查 | IN_PROGRESS | IN_PROGRESS、REVIEW_READY、FAILED、INTERRUPTED |
| REVIEW_READY | Agent 已停止，等待用户审查 | IN_PROGRESS、VERIFYING、INTERRUPTED | IN_PROGRESS、ACCEPTED、ROLLED_BACK |
| ACCEPTED | 用户（或 Full 模式系统）接受全部或选定变更 | REVIEW_READY | ARCHIVED、ROLLED_BACK（ADR-0012） |
| ROLLED_BACK | 任务创建的变更已恢复 | REVIEW_READY、INTERRUPTED、FAILED | ARCHIVED |
| INTERRUPTED | 用户停止、应用退出或 Worker 崩溃 | 任意运行态 | READY、IN_PROGRESS、REVIEW_READY、ROLLED_BACK |
| FAILED | 不可自动继续的运行错误 | 任意运行态 | IN_PROGRESS、REVIEW_READY、ROLLED_BACK |
| CANCELLED | 未执行或用户放弃 | DRAFT、READY、AWAITING_PLAN_APPROVAL | ARCHIVED |
| ARCHIVED | 只读历史状态 | ACCEPTED、ROLLED_BACK、CANCELLED | 无 |

### Task 状态约束

- 任何时刻一个 Task 最多有一个 active Agent run。
- `REVIEW_READY` 前若存在未结束高风险工具调用，状态转换必须失败。
- `ACCEPTED` 前必须生成 Final Report；验证可被用户跳过，但报告必须标记 `UNVERIFIED_BY_USER`。
- `ROLLED_BACK` 前必须运行回滚预检；有无法安全恢复的外部变化时进入冲突流程，不能直接标记成功。
- 所有状态转换写入不可变事件，数据库中的当前状态只是事件投影。

## 6.2 Agent Run 状态

`CREATED → STARTING → STREAMING ↔ WAITING_TOOL/WAITING_PERMISSION → COMPLETING → COMPLETED`；任何运行态可进入 `ABORTING → ABORTED` 或 `ERROR`。Agent Worker 退出时尚未终结的 Run 统一转为 `ERROR_WORKER_EXIT`。

## 6.3 Tool Call 状态

`PROPOSED → POLICY_EVALUATED → WAITING_PERMISSION / QUEUED → RUNNING → SUCCEEDED / FAILED / DENIED / CANCELLED / TIMED_OUT`。

规则：

- 每个 Tool Call 有全局唯一 ID、Task/Run ID、工具版本、输入摘要、完整结构化输入、风险等级和时间戳。
- `DENIED` 是正常业务结果，不是系统异常；返回给 Agent 的结果必须可解释且不可伪装成成功。
- `RUNNING` 前再次验证路径、工作区、当前权限与 base revision，防止审批到执行之间的状态变化。
- 工具输出设大小上限；超限内容落到受控附件并返回摘要与引用。

## 6.4 Document 状态

每个打开文件维护：`diskRevision`、`bufferRevision`、`savedRevision`、`contentHash`、`dirty`、`externalChangeState`。

- Agent `read_file` 返回当前 Document Store 的逻辑内容，不是盲读磁盘。
- Agent patch 必须声明读取时获得的 revision/hash。
- 用户未保存修改与 Agent patch 能无冲突应用时，结果进入 buffer 并自动原子保存；无法安全应用时进入 `VERSION_CONFLICT`。
- 文件监听器发现外部修改时，如果 buffer 干净则自动刷新；buffer 脏则显示 Reload/Compare/Keep 三选项。

# 7. 功能需求

本章所有 `P0` 均为 V1.0 发布必需；`P1` 是 V1.0 内应实现的增强项，只有在不影响 P0 时可降级；没有标记的需求默认 P0。

## 7.1 应用生命周期与窗口（APP）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| APP-001 | 应用可在 macOS 与 Windows 从安装包启动；Linux 预览包可从归档或包管理格式启动。 | P0 |
| APP-002 | 单实例运行；第二次启动把打开目录/文件请求转交给已有实例。 | P0 |
| APP-003 | 窗口尺寸、位置、最大化状态、面板布局和最近 Workspace 持久化；超出当前显示器范围时自动纠正。 | P0 |
| APP-004 | 主进程启动失败、数据库迁移失败、Renderer 加载失败都有可恢复错误页和日志路径。 | P0 |
| APP-005 | 关闭窗口时检查未保存文件、运行中的 Agent、运行中的终端任务，并分别给出保存/停止/后台不可用说明。 | P0 |
| APP-006 | 应用支持浅色、深色和跟随系统；切换不需要重启。 | P0 |
| APP-007 | 提供命令面板、菜单和快捷键；关键动作均可通过键盘完成。 | P0 |
| APP-008 | 窗口崩溃后 Main 保持运行并提供重载 Renderer；Agent Worker 不因 Renderer 崩溃自动获得额外权限。 | P0 |
| APP-009 | About 页面显示应用版本、Electron/Node/Pi adapter 版本、提交 SHA、许可证和更新通道。 | P0 |
| APP-010 | 所有外部 URL 经白名单确认后由系统浏览器打开，禁止在应用 WebView 中加载任意远程页面。 | P0 |

## 7.2 Onboarding、模型与认证（ONB/MOD）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| ONB-001 | 首次启动向导可跳过认证进入只读 IDE，但启动 Agent 前必须完成可用模型配置。 | P0 |
| ONB-002 | Provider/模型列表由 `ModelProviderService` 提供；UI 不依赖 Pi 原始类型和字段。 | P0 |
| ONB-003 | 支持 Pi SDK 当前可用的 API Key 与 OAuth Provider；具体可用项按锁定 Pi 版本暴露。 | P0 |
| ONB-004 | 凭据只存入 Secret Store；Renderer 仅获得 `configured: boolean` 和脱敏标识。 | P0 |
| ONB-005 | 认证测试有超时、取消和错误分类：无效凭据、网络、额度、模型不存在、Provider 服务异常。 | P0 |
| ONB-006 | 用户可配置默认模型、任务级模型、思考等级和最大任务预算警告。 | P0 |
| ONB-007 | 切换模型不改变已完成运行的模型元数据；恢复旧任务时提示原模型是否仍可用。 | P0 |
| ONB-008 | 删除 Provider 凭据前说明受影响任务；删除后立即使新请求失效。 | P0 |
| ONB-009 | 支持导入现有 Pi 用户认证/设置时必须先预览，不自动信任项目级配置。 | P1 |
| MOD-001 | 记录每次 Run 的 provider/model/api、thinking level、token usage、停止原因和可用成本字段。 | P0 |
| MOD-002 | 成本/Token 统计只展示模型返回的真实值；未知时显示 Unknown，不估造精确金额。 | P0 |

## 7.3 Workspace 与文件系统（WS）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| WS-001 | 通过系统目录选择器打开 Workspace，并保存 canonical real path。 | P0 |
| WS-002 | 拒绝打开不存在、不可读或被策略禁止的目录，并给出可操作错误。 | P0 |
| WS-003 | 文件树支持展开、折叠、刷新、新建文件/目录、重命名、移动到回收站、复制相对路径。 | P0 |
| WS-004 | 默认忽略 `.git`、依赖、构建产物和用户配置的 glob；用户可以临时显示已忽略项。 | P0 |
| WS-005 | 大型目录采用懒加载和虚拟列表，不在 Renderer 一次性传输完整文件内容。 | P0 |
| WS-006 | 文件读取识别文本/二进制、常见编码、换行符和大文件；二进制只提供元数据或系统打开。 | P0 |
| WS-007 | 文件写入使用同目录临时文件 + fsync/rename 的原子策略；失败时保留原文件。 | P0 |
| WS-008 | 监听外部新增、修改、删除、重命名，并更新树、编辑器、Git 和 Agent 上下文。 | P0 |
| WS-009 | 未保存 buffer 与外部/Agent 修改发生冲突时绝不静默覆盖。 | P0 |
| WS-010 | 所有文件工具在 canonical path 和最终 real path 两层校验 Workspace 边界，防止 `..` 与符号链接逃逸。 | P0 |
| WS-011 | 支持最近 Workspace、固定、移除、路径失效提示。 | P0 |
| WS-012 | 关闭 Workspace 前处理脏文件、活动任务、终端和数据库 flush。 | P0 |
| WS-013 | 非 Git 仓库可使用编辑器和 Agent；Git 相关功能显示初始化入口，不强制初始化。 | P0 |
| WS-014 | Workspace 设置与全局设置分层，Workspace 覆盖项明确标识并可重置。 | P0 |
| WS-015 | 项目含 `.pi`、项目扩展或技能时显示信任状态；未信任默认不加载可执行资源。 | P0 |
| WS-016 | 支持至少 100,000 文件仓库的树浏览和搜索，不扫描被忽略目录内容。 | P1 |

## 7.4 编辑器与文档（ED）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| ED-001 | Monaco 支持多标签、关闭、关闭其他、关闭已保存、固定标签和最近使用顺序。 | P0 |
| ED-002 | 支持一次水平或垂直拆分，同一文件可在两个视图中共享 model。 | P0 |
| ED-003 | 支持撤销/重做、选择、多光标、缩进、注释、括号匹配、代码折叠。 | P0 |
| ED-004 | 支持文件内查找/替换、正则、大小写、全词和结果计数。 | P0 |
| ED-005 | 支持 Go to Line、Quick Open、Breadcrumb、最近文件。 | P0 |
| ED-006 | 保存、全部保存、自动保存（off/afterDelay/onFocusChange）可配置。 | P0 |
| ED-007 | 脏标签有清晰标识；关闭脏文件必须保存/不保存/取消。 | P0 |
| ED-008 | 显示语言、编码、换行符、缩进和光标位置；允许修改编码/换行符后保存。 | P0 |
| ED-009 | 大文件超过阈值进入降级模式，关闭高成本语义功能并提示。 | P0 |
| ED-010 | 只读文件、权限错误、删除文件和二进制文件都有专用状态。 | P0 |
| ED-011 | Agent 修改打开文件后保留光标/选区尽可能稳定，并显示短暂变更标记。 | P0 |
| ED-012 | Diff Editor 支持 side-by-side/inline、逐个变更跳转、折叠未变化区域。 | P0 |
| ED-013 | 冲突视图展示 Base/Current/Proposed，允许接受当前、接受提议或手工合并。 | P0 |
| ED-014 | 编辑器内容不得通过普通日志、遥测或错误上报发送。 | P0 |
| ED-015 | 支持设置字体、字号、行高、tab size、word wrap、minimap、空白显示。 | P0 |

## 7.5 搜索、导航与代码智能（SRCH/LSP）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| SRCH-001 | Quick Open 按文件名模糊搜索，支持最近项优先和路径高亮。 | P0 |
| SRCH-002 | 全局文本搜索支持普通、正则、大小写、全词、include/exclude glob。 | P0 |
| SRCH-003 | 结果按文件分组，点击定位并高亮；搜索可取消，后续新搜索取消旧请求。 | P0 |
| SRCH-004 | 替换必须先显示预览，可逐项排除；执行前重新验证文件版本。 | P0 |
| SRCH-005 | 搜索默认使用受控 ripgrep 子进程或等价实现，参数不经过 shell 拼接。 | P0 |
| LSP-001 | 提供 LanguageServiceRegistry，按语言启动、复用、停止 LSP 子进程。 | P0 |
| LSP-002 | TypeScript/JavaScript 支持 diagnostics、completion、hover、definition、references、rename、document symbols。 | P0 |
| LSP-003 | Python 支持 diagnostics、completion、hover、definition 和 symbols；若缺少 server，提供安装/路径说明。 | P0 |
| LSP-004 | JSON/HTML/CSS/Markdown 至少有语法高亮、基本 completion/validation 或清晰降级。 | P0 |
| LSP-005 | Problems 面板按文件/严重性聚合，点击跳转；状态栏显示数量。 | P0 |
| LSP-006 | LSP 崩溃不影响编辑；自动重启有退避，连续失败后提示诊断。 | P0 |
| LSP-007 | Agent 可通过受控 `get_symbols`/`get_diagnostics` 工具查询 LSP，不能直接控制语言服务器进程。 | P1 |
| LSP-008 | 重命名与 Workspace Edit 在应用前预览，并经过 Document Store 版本校验。 | P0 |

## 7.6 集成终端与命令执行（TERM/CMD）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| TERM-001 | Bottom Panel 支持多个终端标签、重命名、拆分、关闭、清空和新建。 | P0 |
| TERM-002 | xterm.js 与 PTY 正确处理 resize、颜色、Unicode、复制/粘贴、链接和滚动。 | P0 |
| TERM-003 | 终端 shell 使用用户默认 shell，可按 Workspace 覆盖；启动环境可诊断。 | P0 |
| TERM-004 | 关闭含运行前台进程的终端时确认；应用退出时终止完整进程树。 | P0 |
| TERM-005 | 用户终端与 Agent 命令是不同安全域和不同会话；用户手工命令不需要 Agent 权限审批。 | P0 |
| TERM-006 | Agent 命令输出进入专用 Output/Test 视图，不伪装成人工终端输入。 | P0 |
| CMD-001 | Agent 默认使用 executable + args 的结构化 spawn，不通过 shell 字符串。 | P0 |
| CMD-002 | 确需 shell 语法时标为高风险，展示完整命令、cwd、环境变更和副作用提示。 | P0 |
| CMD-003 | 命令支持超时、取消、输出截断、完整日志附件和退出码。 | P0 |
| CMD-004 | 停止命令先发送温和信号，再在超时后终止进程树；状态必须真实反映是否停止。 | P0 |
| CMD-005 | 环境变量采用最小继承与显式 allow/deny；常见密钥值在 UI 和日志中脱敏。 | P0 |
| CMD-006 | 命令并发按 Task 限制；默认同一 Task 最多一个写性命令和两个只读验证进程。 | P0 |

## 7.7 Git（GIT）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| GIT-001 | 检测 Git 可用性、仓库根目录、HEAD、分支、detached HEAD 和工作区状态。 | P0 |
| GIT-002 | Source Control 按 Staged/Changes/Untracked/Conflicts 分组并可刷新。 | P0 |
| GIT-003 | 点击文件打开工作区 Diff；支持 stage、unstage、discard，危险操作二次确认。 | P0 |
| GIT-004 | 支持输入提交消息并 commit；空消息、hooks 失败、签名失败有清晰错误。 | P0 |
| GIT-005 | 支持查看并切换已有本地分支；脏工作区导致失败时不自动 stash。 | P0 |
| GIT-006 | 支持创建新分支；删除、rebase、merge、push 不属于 Agent 自动工具。 | P0 |
| GIT-007 | 用户可手工执行 push，但必须通过用户触发的显式动作；Agent V1.0 工具层永不提供 git push。 | P0 |
| GIT-008 | Git 操作通过参数数组调用 git CLI，不拼接 shell；输出与错误码结构化。 | P0 |
| GIT-009 | 任务创建时记录 HEAD、分支和初始 status；Final Report 显示任务期间 HEAD 是否变化。 | P0 |
| GIT-010 | 任务 Diff 不能只依赖 Git，因为必须支持未跟踪文件和非 Git 仓库。 | P0 |
| GIT-011 | 发现冲突标记时 Problems/Source Control 提示，Agent 不得在未授权下自动解决并提交。 | P0 |
| GIT-012 | Git hooks 正常运行；输出归入 Git 操作记录，不允许隐藏失败。 | P0 |

## 7.8 Task 与 Agent 体验（TASK/AG）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| TASK-001 | 任务有标题、目标、验收条件、模式、模型、范围、验证命令、状态、创建/更新时间。 | P0 |
| TASK-002 | 任务创建即持久化，应用崩溃不丢失输入。 | P0 |
| TASK-003 | 任务列表按进行中、待审查、已完成、失败/中断分类并支持筛选。 | P0 |
| TASK-004 | 一个 Workspace 同时最多运行一个写性 Agent Task；Ask 可排队，不并发修改文件。 | P0 |
| TASK-005 | 任务目标和验收条件在运行中可补充，修改记录为用户事件。 | P0 |
| TASK-006 | 删除任务默认进入回收/归档，不删除其快照前先确认。 | P0 |
| AG-001 | 提供 Ask、Edit、Auto 三模式；每种模式工具白名单和审批默认值不同。 | P0 |
| AG-002 | Pi Runtime 在独立 utility process/child process 中运行，崩溃不带崩窗口。 | P0 |
| AG-003 | 支持创建 Session、prompt、steer、followUp、abort、subscribe 和恢复引用。 | P0 |
| AG-004 | 所有 Pi 事件映射为产品 `AgentEvent`，带 sequence、timestamp、runId 和 schemaVersion。 | P0 |
| AG-005 | 流式文本、工具开始/进度/结果、usage、停止原因和错误均可观察。 | P0 |
| AG-006 | （ADR-0011 修订）模型思维链以独立、默认折叠的展示通道呈现（可在设置中关闭）；思维链永不进入证据体系（计划/报告/验证），也不作为动作行。 | P0 |
| AG-007 | Edit/Auto 首次写入前必须存在计划对象；计划项有 ID、状态、描述、受影响区域和验证方法。 | P0 |
| AG-008 | 用户可批准、编辑或拒绝计划；编辑后的计划作为新用户消息送入 Runtime。 | P0 |
| AG-009 | 停止按钮始终可见；停止后不再发起新工具，最终状态不冒充成功。 | P0 |
| AG-010 | 模型上下文压缩发生时记录系统事件和摘要元数据，但不泄露内部不可见内容。 | P0 |
| AG-011 | Runtime 断连、Provider 限流、配额、上下文过长、无效工具参数分别处理。 | P0 |
| AG-012 | 支持 mock Runtime，使所有 UI、状态机和 E2E 不依赖真实模型。 | P0 |
| AG-013 | Pi 版本精确锁定；启动时记录版本，适配层有 contract tests。 | P0 |
| AG-014 | 默认不加载未信任项目的 Pi 扩展、包、技能和提示；加载行为必须可审计。 | P0 |

## 7.9 Tool Gateway 与权限（TOOL/PERM）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| TOOL-001 | Pi 只能调用产品注册的结构化工具；V1.0 不直接暴露无限制 `bash/edit/write` 作为最终边界。 | P0 |
| TOOL-002 | 工具注册包含 name、version、description、JSON schema、risk evaluator、executor 和 result normalizer。 | P0 |
| TOOL-003 | 必需工具：list_directory、read_file、search_text、get_symbols、get_diagnostics、apply_patch、create_file、delete_file、run_command、git_status、git_diff、run_verification、ask_user。 | P0 |
| TOOL-004 | 输入在 Pi 侧之后、执行侧之前再次以 schema 校验；未知字段按策略拒绝。 | P0 |
| TOOL-005 | 所有路径先相对 Workspace 解析，再 canonicalize；不允许 NUL、设备路径或越界。 | P0 |
| TOOL-006 | 工具结果有 `ok/code/summary/data/attachments/retryable`，错误不能只返回非结构化字符串。 | P0 |
| TOOL-007 | 工具输出默认最大 1 MiB；超限保存附件并返回截断摘要。 | P0 |
| TOOL-008 | 读工具不改变 atime/权限等可避免的元数据；写工具使用 ChangeService。 | P0 |
| TOOL-009 | 工具支持 AbortSignal；取消后结果明确为 CANCELLED。 | P0 |
| TOOL-010 | 同一文件写工具串行；命令与写操作按 Resource Lock 协调。 | P0 |
| PERM-001 | 风险分级：R0 只读、R1 工作区写、R2 本地执行、R3 外部/不可逆、R4 禁止。 | P0 |
| PERM-002 | 权限决定支持：允许一次、允许本任务、允许本 Workspace 同类操作、拒绝一次、始终拒绝。 | P0 |
| PERM-003 | Workspace 级持久允许不能覆盖 R3/R4 的强制确认/禁止规则。 | P0 |
| PERM-004 | 审批卡展示工具、原因、精确目标、命令/cwd、文件差异预览、风险和预计副作用。 | P0 |
| PERM-005 | 审批有请求时状态进入 AWAITING_PERMISSION；用户可批量处理同类低风险请求。 | P0 |
| PERM-006 | 拒绝后工具绝不执行，Agent 收到 `PERMISSION_DENIED` 及用户可选理由。 | P0 |
| PERM-007 | 审批到执行之间若参数或目标变化，原审批失效并重新请求。 | P0 |
| PERM-008 | 默认禁止 sudo、Workspace 外写、git push、读取常见凭据路径、破坏性根目录命令。 | P0 |
| PERM-009 | 网络访问默认 R3；Provider API 流量由 Runtime 自身配置，不等同于 Agent 命令获准联网。 | P0 |
| PERM-010 | 权限决策写入审计事件，不保存密钥或完整敏感环境变量。 | P0 |

## 7.10 变更、Diff、Checkpoint 与回滚（CHG）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| CHG-001 | 任务首次改动文件前保存原始字节、哈希、存在性、权限位、编码和换行符。 | P0 |
| CHG-002 | 每次 patch 保存 base/after hash、unified diff、toolCallId、时间和作者类型。 | P0 |
| CHG-003 | apply_patch 仅在 base revision 匹配时直接执行；否则返回冲突。 | P0 |
| CHG-004 | 新建、修改、删除和重命名均进入任务 ChangeSet。 | P0 |
| CHG-005 | 任务级 Review 展示所有当前净变化，不重复累计已被后续修改抵消的中间 Diff。 | P0 |
| CHG-006 | Timeline 保留中间变更历史，Review 使用当前投影。 | P0 |
| CHG-007 | 支持逐文件和逐 hunk 接受；接受只改变任务归属/审查状态，不自动 commit。 | P0 |
| CHG-008 | 拒绝单个 hunk 时安全反向应用；若工作区已变化则进入冲突。 | P0 |
| CHG-009 | 完整回滚能恢复修改、删除、新建、重命名文件到任务基线。 | P0 |
| CHG-010 | 回滚不能破坏任务外变化；无法区分时必须停止并要求用户处理。 | P0 |
| CHG-011 | 快照存放在应用数据目录，不默认污染仓库；崩溃后可校验。 | P0 |
| CHG-012 | 回滚成功后逐文件计算哈希并生成报告；失败保留快照。 | P0 |
| CHG-013 | 用户可从 Timeline 打开任一修改时刻的只读 Diff。 | P1 |
| CHG-014 | 大文件或二进制写入默认不允许 Agent 修改；用户明确批准后仍需完整快照。 | P0 |

## 7.11 验证与完成报告（VER）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| VER-001 | 任务可配置一个或多个验证命令，包含 label、executable/args、cwd、timeout。 | P0 |
| VER-002 | 可从项目元数据建议 test/typecheck/lint/build，但执行前由用户确认或策略允许。 | P0 |
| VER-003 | 每次验证保存开始/结束时间、退出码、stdout/stderr、是否超时/取消、关联代码 revision。 | P0 |
| VER-004 | 测试结果面板区分通过、失败、跳过、未运行；日志可搜索和复制。 | P0 |
| VER-005 | 验证失败时 Agent 可继续修复；旧失败记录不能被覆盖，只标记为 superseded。 | P0 |
| VER-006 | 进入 REVIEW_READY 前生成 Final Report：目标摘要、计划完成度、变更文件、验证、未解决风险、模型/usage。 | P0 |
| VER-007 | 没有验证命令或用户跳过时显著显示 Unverified；仍允许用户接受。 | P0 |
| VER-008 | 验证运行期间代码再变更时，之前结果标为 stale。 | P0 |
| VER-009 | Problems 中存在新增 error 级诊断时 Final Report 提示，不自动判定绝对失败。 | P0 |
| VER-010 | 用户可重新运行单项或全部验证，不需要重新启动 Agent。 | P0 |

## 7.12 历史、恢复与诊断（HIST/REL）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| HIST-001 | 任务、事件、工具、权限、变更和验证持久化到版本化本地数据库。 | P0 |
| HIST-002 | 任务详情重启后可完整重建 Timeline 和 Review。 | P0 |
| HIST-003 | Pi session 文件/ID 只作为 Runtime 恢复引用；产品历史不能只依赖 Pi session。 | P0 |
| HIST-004 | 支持搜索任务标题、目标、状态和日期；默认不索引代码内容到全局历史。 | P0 |
| HIST-005 | 用户可归档/删除任务；删除快照和附件前确认，支持保留元数据。 | P0 |
| REL-001 | Main、Renderer、Agent Worker、LSP、PTY、Git 子进程均有独立健康状态。 | P0 |
| REL-002 | Agent Worker 崩溃自动标记运行中任务中断，并可按退避重启，不自动重放有副作用工具。 | P0 |
| REL-003 | 数据库使用事务、WAL/等价机制和 schema migration；迁移前备份。 | P0 |
| REL-004 | 事件写入有单调 sequence；重复消息可幂等处理。 | P0 |
| REL-005 | 应用提供诊断页面、日志级别、组件版本、数据库检查和支持包导出。 | P0 |
| REL-006 | 支持包默认排除代码、提示正文、密钥、完整环境变量和文件内容；导出前显示清单。 | P0 |
| REL-007 | 发生不可恢复错误时仍允许导出诊断、打开数据目录和安全退出。 | P0 |
| REL-008 | 长任务期间防止系统挂起可配置，退出后可靠释放。 | P1 |

## 7.13 设置、隐私、更新与可访问性（SET/PRIV/UPD/A11Y）

| ID | 需求 | 优先级 |
| --- | --- | --- |
| SET-001 | 设置分 General、Editor、Terminal、Agent、Models、Permissions、Privacy、Updates、About。 | P0 |
| SET-002 | 设置有默认值、类型/schema 校验、即时生效或“需要重启”标记。 | P0 |
| SET-003 | 支持导出非敏感设置和恢复默认值；不导出密钥。 | P0 |
| PRIV-001 | 默认关闭产品分析；开启前列出字段，绝不发送代码、Prompt、Diff、路径或命令输出。 | P0 |
| PRIV-002 | 崩溃上报独立 opt-in，可预览脱敏内容。 | P0 |
| PRIV-003 | 提供本地数据位置、保留策略和一键删除历史/缓存。 | P0 |
| UPD-001 | macOS/Windows 支持 Stable/Beta 更新通道、手动检查、下载进度、重启安装和失败回退说明。 | P0 |
| UPD-002 | Linux 预览包显示更新提示与下载入口，不声称应用内自动更新。 | P0 |
| UPD-003 | 更新包必须签名/校验，发布元数据与应用版本一致。 | P0 |
| UPD-004 | 数据库迁移与应用更新兼容；失败时恢复备份并进入只读诊断模式。 | P0 |
| A11Y-001 | 主要控件有可访问名称、角色、焦点样式；键盘可完成主要流程。 | P0 |
| A11Y-002 | 颜色不作为唯一状态信号；错误、风险、成功同时有文字/图标。 | P0 |
| A11Y-003 | 支持 80%–200% UI 缩放，关键内容不裁切。 | P0 |
| A11Y-004 | Agent 流式更新使用适度 live region，不逐 token 干扰屏幕阅读器。 | P0 |
| A11Y-005 | Diff 提供可访问文本模式和逐变更导航。 | P0 |

# 8. Pi Runtime 集成规格

Pi 官方 SDK用于嵌入自定义桌面 UI，提供 `createAgentSession`、`AgentSession`、事件订阅、prompt/steer/followUp/abort、模型与 Session 管理。V1.0 以 SDK 为底座，但将所有依赖封装在 Adapter 中。

## 8.1 依赖边界

```text
Renderer / UI / Domain
        │ only product contracts
        ▼
@product/agent-contract
        │
        ▼
@product/agent-runtime-pi
        │ only package allowed to import Pi
        ▼
@earendil-works/pi-coding-agent
```

禁止：

- Renderer import Pi。
- 把 `AgentSessionEvent` 直接写进数据库或 IPC。
- 用 Pi session 文件替代产品 Event Store。
- 无审计地加载项目本地 Pi 扩展。
- UI 根据某个 Pi Provider 的特殊字段写条件分支。

## 8.2 产品 Runtime 接口

```ts
export interface AgentRuntime {
  initialize(input: RuntimeInit): Promise<RuntimeInfo>;
  createSession(input: CreateSessionInput): Promise<RuntimeSessionRef>;
  resumeSession(ref: RuntimeSessionRef): Promise<RuntimeSessionRef>;
  startRun(input: StartRunInput): AsyncIterable<AgentEvent>;
  steer(runId: string, text: string): Promise<void>;
  followUp(runId: string, text: string): Promise<void>;
  abort(runId: string, reason: AbortReason): Promise<void>;
  listModels(): Promise<ModelDescriptor[]>;
  validateCredential(providerId: string): Promise<CredentialCheck>;
  dispose(): Promise<void>;
}
```

`AgentEvent` 至少包括：

```ts
type AgentEvent =
  | { type: 'run.started'; sequence: number; runId: string; at: string }
  | { type: 'message.delta'; sequence: number; messageId: string; text: string }
  | { type: 'message.completed'; sequence: number; message: VisibleMessage }
  | { type: 'plan.proposed'; sequence: number; plan: TaskPlan }
  | { type: 'tool.proposed'; sequence: number; call: ToolCallProposal }
  | { type: 'tool.started'; sequence: number; callId: string }
  | { type: 'tool.progress'; sequence: number; callId: string; summary: string }
  | { type: 'tool.completed'; sequence: number; callId: string; result: ToolResult }
  | { type: 'usage.updated'; sequence: number; usage: ModelUsage }
  | { type: 'context.compacted'; sequence: number; metadata: CompactionMetadata }
  | { type: 'run.completed'; sequence: number; stopReason: string }
  | { type: 'run.failed'; sequence: number; error: ProductError }
  | { type: 'run.aborted'; sequence: number; reason: string };
```

## 8.3 Pi 事件映射规则

- Pi 流式 `message_update` 转换为 `message.delta`，但数据库以 message ID 聚合并保存最终可见文本。
- 工具事件先进入 Tool Gateway；只有产品生成的工具状态可以显示为已执行。
- Pi 返回的 usage、provider、model、stop reason 逐项保留；缺失字段为 null，不伪造。
- Adapter 未识别事件记录为 `runtime.unknown_event` 诊断，不导致进程崩溃。
- 事件 schema 有版本，升级时提供迁移或向后读取。

## 8.4 Session 与上下文

- 产品保存 Pi `sessionId/sessionFile` 作为引用，以及所属 Workspace、Task、Runtime 版本。
- 新任务默认新 Session；同一任务恢复使用原 Session，若不兼容则创建恢复 Session。
- 系统 Prompt 由产品模板生成，包含工具边界、任务目标、验收条件、Workspace 规则和“不得声称未经验证的完成”。
- 当前打开文件、选区、Problems、Git 状态作为显式上下文附件注入，而不是悄悄永久加入 Session。
- Compaction 后必须保留任务目标、验收条件、计划状态、未解决权限/冲突和当前变更摘要。

## 8.5 Pi 版本策略

1. `package.json` 精确版本，不使用 `^`/`~`。
2. lockfile 纳入版本控制。
3. 每次升级先在分支运行 Adapter contract、固定任务和回滚测试。
4. 只在 SDK 阻断已编号 P0 需求时考虑 patch；补丁附上原因、上游 issue/PR 和删除条件。
5. 连续多个版本存在 3 个以上核心补丁时再评估正式 fork；fork 仍与 IDE 仓库隔离。

# 9. 技术架构

## 9.1 技术选型

| 层 | 默认实现 | 决策理由 |
| --- | --- | --- |
| 桌面壳 | Electron + TypeScript | 与 Pi/Node 生态直接集成、成熟跨平台 IDE 路线 |
| 前端 | React + TypeScript + Vite | 组件化、类型共享、生态成熟 |
| 编辑器 | Monaco Editor | VS Code 编辑器核心、内置普通与 Diff 编辑器 |
| 终端 | xterm.js + node-pty 或等价 PTY | 桌面终端渲染与真实 shell 会话 |
| Agent Runtime | Pi Coding Agent SDK | 复用 Agent loop、模型、Session 与事件 |
| 搜索 | ripgrep 子进程 + JS fallback | 大仓库性能、参数化调用 |
| 代码智能 | Monaco Language Client + Language Server Manager | 统一 LSP 边界 |
| 持久化 | SQLite + 文件附件存储 | 事务、查询、迁移和大量事件可靠性 |
| schema | Zod 或等价运行时 schema | IPC、DB、工具输入的统一验证 |
| 状态管理 | 轻量 store + domain services | UI 状态与持久业务状态分离 |
| 测试 | Vitest + Playwright Electron + fixture repos | 单元、集成和桌面 E2E |
| 打包 | Electron 打包工具 + 平台签名 | 安装、更新和原生依赖重建 |

具体第三方包版本在首次实现时选择当前稳定版并精确锁定。任何 native module 必须在三平台 CI 进行安装与打包 smoke test。

## 9.2 进程模型

```text
┌──────────────────────────────────────────────────────────────┐
│ Electron Renderer                                            │
│ React · Monaco · xterm · Timeline · Settings                 │
│ 无 Node、无文件系统、无密钥                                  │
└───────────────────────┬──────────────────────────────────────┘
                        │ contextBridge + typed IPC
┌───────────────────────▼──────────────────────────────────────┐
│ Preload                                                      │
│ 仅暴露版本化、白名单、最小能力 API                            │
└───────────────────────┬──────────────────────────────────────┘
                        │ ipcRenderer/ipcMain
┌───────────────────────▼──────────────────────────────────────┐
│ Electron Main                                                │
│ 窗口 · 菜单 · Secret Store · Update · IPC Router · 进程监管  │
└───────────────┬──────────────────────┬───────────────────────┘
                │ MessagePort/IPC      │ managed child processes
┌───────────────▼────────────────┐  ┌──▼──────────────────────┐
│ Agent Utility Process          │  │ Service Processes       │
│ Pi Adapter · Task Engine       │  │ PTY · LSP · Search      │
│ Tool Gateway · DB · Git        │  │ 可独立重启               │
└────────────────────────────────┘  └─────────────────────────┘
```

### 进程责任

- **Renderer**：纯呈现、短期 UI 状态、Monaco models、用户输入。不得访问 `fs/process/child_process`。
- **Preload**：将少量 `window.product.*` API 映射到 IPC；不暴露通用 `invoke(channel, payload)`。
- **Main**：窗口、协议、外部链接、Secret Store、更新、进程监督和系统对话框。
- **Agent Process**：任务状态机、Pi、Tool Gateway、数据库投影、文件/Git/验证服务。长任务不阻塞 Main。
- **Service Processes**：PTY/LSP/搜索可由 Agent Process 管理或独立；崩溃可恢复，输出有背压。

## 9.3 IPC 规范

- 所有 request/response/event 以 schema 校验，包含 `protocolVersion`、`requestId`、`workspaceId` 和必要的 `taskId`。
- IPC channel 使用固定枚举，不允许 Renderer 指定任意方法名、路径或命令。
- 对大文件和终端流使用 MessagePort/分块流，禁止在单个 IPC payload 中发送超大字符串。
- Renderer 销毁时自动取消订阅；Main/Worker 不向已失效 WebContents 发送事件。
- 所有可变请求支持幂等 key 或乐观版本，以避免双击/重试重复执行。

示例：

```ts
interface IpcRequest<T> {
  protocolVersion: 1;
  requestId: string;
  workspaceId?: string;
  payload: T;
}

interface IpcResponse<T> {
  requestId: string;
  ok: boolean;
  data?: T;
  error?: ProductError;
}
```

## 9.4 Domain 服务

- `WorkspaceService`：打开/关闭、文件树、真实路径、监听。
- `DocumentService`：buffer/disk revision、保存、冲突、atomic write。
- `SearchService`：文件和文本搜索、取消、结果流。
- `LanguageServiceManager`：LSP 生命周期和 Monaco bridge。
- `TerminalService`：PTY 会话、resize、process tree。
- `GitService`：status/diff/stage/commit/branch。
- `TaskService`：任务状态机、事件、投影。
- `AgentRuntimeService`：Runtime 生命周期与事件映射。
- `ToolGateway`：schema、风险、权限、执行和结果。
- `PermissionService`：规则、请求、持久决定和审计。
- `ChangeService`：快照、patch、ChangeSet、accept/reject/rollback。
- `VerificationService`：验证配置与运行。
- `SecretService`：凭据加密与 Provider 引用。
- `UpdateService`：渠道、检查、下载、安装状态。
- `DiagnosticsService`：日志、健康、支持包。

## 9.5 依赖规则

```text
apps/desktop-renderer  -> ui, domain-contracts only
apps/desktop-main      -> ipc-contracts, platform services
apps/agent-worker      -> domain services, runtime adapter
packages/agent-runtime-pi -> Pi SDK only
packages/domain-*      -> no Electron, no Pi, no React
packages/ipc-contracts -> no implementation dependencies
```

通过 lint rule/tsconfig references 阻止违反依赖方向。

# 10. Tool Gateway 详细规格

## 10.1 工具合同

```ts
interface ProductTool<I, O> {
  readonly name: string;
  readonly version: number;
  readonly inputSchema: Schema<I>;
  evaluateRisk(input: I, ctx: ToolContext): Promise<RiskAssessment>;
  preview(input: I, ctx: ToolContext): Promise<ToolPreview>;
  execute(input: I, ctx: ToolContext, signal: AbortSignal): Promise<ToolResult<O>>;
}
```

`ToolContext` 必须包含 Workspace canonical root、Task/Run/Call ID、当前权限、Document revisions、环境策略、日志接口和 Resource Lock。

## 10.2 默认风险策略

| 等级 | 示例 | 默认 |
| --- | --- | --- |
| R0 只读 | 列目录、读项目文本、搜索、Git status/diff、读取 diagnostics | Ask/Edit/Auto 自动允许 |
| R1 可逆工作区写 | apply patch、新建普通文本文件、格式化单文件 | Edit 询问或计划批准后允许；Auto 任务内允许 |
| R2 本地执行 | test、lint、typecheck、build、启动短时脚本 | 已识别验证命令可允许；未知命令询问 |
| R3 外部或难逆 | 安装依赖、网络命令、删除文件、commit、修改配置、shell 字符串 | 每次显式确认，不能 Workspace 永久放行 |
| R4 禁止 | sudo、git push、Workspace 外写、读取凭据目录、根目录破坏性命令 | 产品层拒绝，不提供“仍然运行”按钮 |

## 10.3 核心工具语义

### `read_file`

输入：相对路径、可选行范围、期望 revision。输出：逻辑内容、编码、换行符、revision/hash、是否来自未保存 buffer。二进制或超限时返回受控错误。

### `search_text`

输入：query、isRegex、caseSensitive、include/exclude、maxResults。结果流按文件分组；到达上限标记 truncated。

### `apply_patch`

输入：路径、unified patch 或结构化 edits、baseRevision/baseHash、reason。执行流程：schema → path → snapshot → revision → patch preview → permission → lock → recheck → apply → atomic save → hash → event。

### `create_file/delete_file`

创建要求父目录在 Workspace，默认不覆盖；删除为 R3，先快照并尽可能进入应用管理的恢复区。目录递归删除 V1.0 禁止 Agent 使用。

### `run_command`

输入优先为：

```ts
{
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  purpose: 'test' | 'lint' | 'build' | 'inspect' | 'other';
  env?: Record<string, string>;
  requiresShell?: boolean;
}
```

执行前解析 executable、cwd、环境、网络特征与副作用。禁止把模型提供的字符串直接传入 `exec`。

### `ask_user`

用于获取需求澄清、选择方案或风险决定，不应被滥用为绕过结构化权限。用户回答进入 Timeline 并恢复 Run。

## 10.4 命令策略最小集

- 自动允许的已识别命令由项目探测生成，例如 `npm test -- ...`、`npm run lint`、`npx tsc --noEmit`、`pytest`，但仍展示。
- `npm install`、`pip install`、`curl`、`wget`、包管理器系统安装、Git commit 均 R3。
- 管道、重定向、命令替换、`&&/||/;`、shell glob 仅在 `requiresShell=true` 时使用并升级风险。
- 输出中匹配凭据模式的值在界面与日志副本中脱敏；原始子进程内存不持久化。
- 命令退出后记录实际 executable、args、cwd、exitCode、signal、duration、truncated。

# 11. 数据模型与持久化

## 11.1 存储布局

```text
<AppData>/
  app.db
  app.db-wal
  settings.json              # 仅非敏感启动设置
  secrets/                   # 加密 blob 或 OS credential references
  workspaces/<workspaceId>/
    checkpoints/<taskId>/
      manifest.json
      blobs/<sha256>
    attachments/<taskId>/
    logs/
  runtime/
    pi-session-references.json
  backups/
```

代码仓库内默认不写产品元数据；用户明确启用 Workspace 配置时，才可写一个不含密钥的配置文件。

## 11.2 核心表

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| schema_migrations | version, applied_at, checksum | 迁移记录 |
| workspaces | id, canonical_path, display_name, trust_state, last_opened_at | Workspace 元数据 |
| tasks | id, workspace_id, title, goal_md, acceptance_json, mode, state, model_ref, version | 当前任务投影 |
| task_events | id, task_id, sequence, type, schema_version, payload_json, created_at | 不可变业务事件 |
| agent_sessions | id, task_id, runtime, runtime_version, external_session_id, external_session_file | Pi 引用 |
| agent_runs | id, task_id, state, provider, model, usage_json, started_at, ended_at | 一次运行 |
| tool_calls | id, run_id, name, version, risk, state, input_json, result_json, timestamps | 工具审计 |
| permission_requests | id, tool_call_id, state, preview_json, expires_at | 权限请求 |
| permission_decisions | id, request_id, decision, scope, actor, reason, created_at | 权限决定 |
| file_baselines | task_id, relative_path, blob_hash, existed, mode, encoding, eol | 任务前基线 |
| file_changes | id, task_id, tool_call_id, path, kind, before_hash, after_hash, patch, review_state | 变更历史 |
| verification_runs | id, task_id, label, command_json, code_revision, state, exit_code, output_ref | 验证 |
| ui_workspace_state | workspace_id, layout_json, open_tabs_json, updated_at | 布局恢复 |
| app_errors | id, component, code, severity, sanitized_context, created_at | 本地诊断 |

## 11.3 一致性规则

- `task_events.sequence` 在 Task 内唯一、单调递增。
- 状态转换、工具结果、变更写入使用同一数据库事务或 Outbox，避免 UI 显示成功但未落库。
- 大输出、原始快照和二进制内容采用内容寻址 blob；数据库只存 hash/reference。
- 快照 blob 去重，但删除前按引用计数或 mark-and-sweep 清理。
- 敏感凭据不进入数据库。
- DB schema 每次变更必须提供 up migration、兼容读取测试和失败恢复策略。

## 11.4 保留策略

默认保留任务与事件，缓存日志 30 天，未引用附件 7 天后清理。用户可配置保留时长或立即清除。已归档任务的 checkpoint 只有在明确删除后才能回收。

# 12. 安全、隐私与威胁模型

Pi 官方明确说明本身不提供文件系统、进程、网络或凭据的内建权限隔离。因此 V1.0 的安全边界是 Electron 隔离 + 自有工具网关 + 最小权限策略；不得把“项目信任”误称为 sandbox。

## 12.1 信任边界

- 不可信：仓库文件、README/注释中的提示、模型输出、工具参数、终端输出、LSP 输出、远程链接。
- 半可信：Renderer 代码（可能受 XSS/依赖问题影响），只能调用白名单 IPC。
- 高信任：Main/Agent Worker 的经校验服务；仍需最小权限和审计。
- 秘密边界：Secret Store 与 Provider 调用，不向 Renderer 暴露明文。

## 12.2 主要威胁与控制

| 威胁 | 控制 |
| --- | --- |
| 路径遍历/符号链接逃逸 | canonical root、realpath、执行前二次校验、禁止设备路径、竞态测试 |
| 命令注入 | spawn executable+args、shell 默认关闭、schema、风险升级、无字符串拼接 |
| 恶意仓库提示注入 | Repository 内容永不改变工具政策；系统提示明确边界；高风险仍需宿主批准 |
| 恶意 `.pi` 扩展/技能 | 未信任不加载；信任对话框列出来源和能力；决定可撤销 |
| 密钥泄露 | Main/Worker Secret Store、日志脱敏、Renderer 无明文、支持包预览 |
| Renderer XSS 获取 Node | nodeIntegration=false、contextIsolation=true、sandbox=true、严格 CSP、无远程内容 |
| 任意 IPC 调用 | preload 白名单、schema、权限上下文、无通用 channel passthrough |
| 更新供应链 | 代码签名、更新签名/哈希、固定渠道、依赖锁定、SBOM/许可证清单 |
| 回滚覆盖用户工作 | 任务基线 + revision/hash + 外部变化归属检查 + 冲突而非强制覆盖 |
| 日志暴露代码 | 默认事件摘要；文件内容、Prompt、Diff、命令完整输出不进入普通日志 |
| 资源耗尽 | 输出/文件/搜索上限、背压、子进程并发限制、内存监控、取消 |

## 12.3 Electron 必须配置

```ts
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  preload: PRELOAD_PATH,
  webSecurity: true,
  allowRunningInsecureContent: false,
}
```

同时：

- 生产 Renderer 只加载本地打包内容或自定义安全协议。
- CSP 至少禁止任意脚本与对象；开发模式例外不进入发行包。
- 禁止 `webview`、远程模块、`eval` 和任意导航。
- 所有 `window.open`/navigation 事件拒绝或转系统浏览器白名单流程。
- Main 和 Pi SDK 保持安全更新节奏，升级前跑回归。

## 12.4 隐私

- 默认 Local-first，不创建产品云账户。
- 模型请求必然将用户选择的上下文发送给对应 Provider；首次使用与设置页必须明确说明。
- Timeline 可展示“本轮发送了哪些文件/片段的元数据摘要”，不必默认展示完整 Prompt。
- 遥测默认关闭；开启后只允许版本、平台、匿名功能计数、延迟和错误码，不允许内容数据。
- 支持一键删除产品历史、缓存与凭据引用。

# 13. UX 组件行为规格

## 13.1 Agent Timeline 卡片

每类卡片有统一头部：图标、类型、摘要、状态、开始时间、耗时、展开按钮。类型包括：

- User message
- Agent visible message
- Plan proposed/updated
- File read/search
- Permission request/decision
- Command started/output/completed
- File change
- Verification run
- Warning/error
- Recovery/system event
- Final report

卡片要求：

- 默认折叠冗长参数和输出，但关键风险不得折叠隐藏。
- 展开后可复制结构化详情；敏感值保持脱敏。
- 文件路径点击打开文件，行范围定位；命令可复制但不能一键重跑高风险命令。
- 失败卡片显示错误码、用户可读说明、重试/修复动作和诊断链接。
- Timeline 虚拟化；10,000 个事件仍可滚动。

## 13.2 计划组件

计划是结构化对象：

```ts
interface TaskPlan {
  version: number;
  summary: string;
  steps: Array<{
    id: string;
    title: string;
    description?: string;
    status: 'pending' | 'in_progress' | 'done' | 'skipped' | 'blocked';
    expectedFiles?: string[];
    verification?: string;
  }>;
}
```

用户可编辑文字与顺序；运行后删除已完成步骤需要确认。Agent 更新状态时记录 delta，不覆盖历史版本。

## 13.3 权限卡片

必须同时展示：

- Agent 为什么请求。
- 工具名称与风险等级。
- 精确文件/命令/cwd/网络目标。
- 对现有文件的 Diff 预览或“尚无 Diff”的解释。
- 决定按钮及作用域说明。
- “查看策略”入口。

## 13.4 完成报告

```text
Outcome: Completed / Partially completed / Failed / Interrupted
Acceptance criteria: 3/4 satisfied
Changed: 5 files, +120 / -34
Verification: 2 passed, 1 failed, 0 skipped
Diagnostics: 0 new errors, 2 warnings
Unresolved risks: ...
Model/usage: provider, model, tokens, cost if available
Next actions: Review changes / Continue / Accept / Roll back
```

Agent 自述和系统证据分开显示。系统证据来自 ChangeService、VerificationService、Problems 和权限记录。

## 13.5 错误文案规则

错误必须回答四件事：发生了什么、影响了什么、数据是否安全、用户下一步做什么。避免仅显示 stack trace 或“Unknown error”。技术详情可折叠并包含稳定错误码。

# 14. 完整执行计划

下面是从空仓库到 Stable 产品的完整顺序。**Milestone 1 不是最终目标；只有 Milestone 1–12 全部 VERIFIED 才完成。** 每个 Milestone 必须形成可运行的纵向切片，并满足退出条件。

## Milestone 1：工程基线与产品合同

交付：monorepo、Electron/React 启动、严格 TypeScript、lint/format/test、CI、领域与 IPC contracts、mock Runtime、ADR/状态模板。  
退出：生产配置下 Renderer 隔离生效；单元测试与打包 smoke test 通过；依赖边界 lint 可拦截 Renderer import Pi。

## Milestone 2：应用壳、设置与持久化

交付：窗口/菜单/命令面板、布局框架、主题、SQLite migration、设置系统、日志与错误页。  
退出：重启恢复布局；迁移失败进入安全诊断；设置 schema 与 IPC 测试通过。

## Milestone 3：Workspace 与完整编辑器

交付：打开/最近 Workspace、文件树、Document Store、Monaco tabs/split、保存/自动保存、外部变化、冲突、Diff Editor。  
退出：手工编辑工作流完整；未保存 buffer 不被外部变化覆盖；10k 文件 fixture 可用。

## Milestone 4：搜索、代码智能与终端

交付：Quick Open、全局搜索/替换预览、LSP Manager、JS/TS 与 Python 基础能力、Problems、xterm/PTy 多终端。  
退出：导航、rename、diagnostics、终端进程树和取消 E2E 通过。

## Milestone 5：Git 与变更基础设施

交付：Git status/diff/stage/unstage/discard/commit/branch；ChangeService、blob store、baseline/hash、rollback engine。  
退出：Git 与非 Git fixture 均可审查；30 组创建/修改/删除/重命名回滚字节一致。

## Milestone 6：Pi Runtime 与只读 Agent

交付：独立 Agent Worker、Pi Adapter、模型/认证、Ask 模式、事件映射、Timeline、abort/steer/followUp、mock/real contract。  
退出：Ask 不可访问写工具；Worker 崩溃窗口不崩；任务历史重启可读。

## Milestone 7：Tool Gateway 与权限系统

交付：工具注册、schema、路径边界、风险评估、权限卡、命令策略、审计事件。  
退出：路径/符号链接逃逸全部阻止；拒绝后 0 次执行；R3/R4 规则故障注入通过。

## Milestone 8：Agent 写入、计划与审查

交付：Edit/Auto、结构化计划、apply/create/delete、Document revision 协调、任务级 Diff、逐文件/hunk 接受、冲突视图。  
退出：Agent 可完成真实跨文件任务；用户与 Agent 并发编辑不丢数据；Review 完整。

## Milestone 9：验证、完成报告与任务历史

交付：验证配置/探测、测试输出、stale 语义、Final Report、任务筛选/归档、继续修改。  
退出：通过/失败/超时/取消/无验证五类状态 E2E；Agent 完成不直接 Accepted。

## Milestone 10：恢复、可靠性与诊断

交付：主进程/Renderer/Worker/LSP/PTy 故障恢复、未完成任务恢复、DB 备份、支持包、soak tests。  
退出：50 次连续任务、强制杀 Worker、杀 Renderer、磁盘写失败、数据库迁移回滚均达到验收。

## Milestone 11：安全、性能、隐私与可访问性硬化

交付：CSP、导航拦截、Secret Store、日志脱敏、隐私设置、性能分析、虚拟化、键盘与屏幕阅读器检查。  
退出：安全测试矩阵 100% 通过；参考工作负载达到性能门槛；核心流程仅键盘可完成。

## Milestone 12：安装、更新、Beta 与 Stable 发布

交付：macOS/Windows 安装包、Linux 预览、签名准备、更新通道、发布说明、许可证/SBOM、迁移演练、Beta 修复。  
退出：第 16 章全部 Release Gates 通过；干净机器安装/升级/卸载验证；Stable 版本可复现构建。

## 14.1 执行纪律

- 每个 Milestone 分成 1–3 天可验证任务；禁止一次性大分支。
- 优先使用 mock Runtime 完成确定性 UI/E2E，再用真实 Pi 运行固定任务。
- 每个 P0 需求至少映射一个自动化或明确手工验收项。
- 发现需求歧义时记录 ADR，不自行删除要求。
- 功能开关仅用于未完成开发；Stable 中不能保留用户可触达的半成品。

# 15. 仓库结构与工程规范

```text
/
├─ apps/
│  ├─ desktop-main/
│  ├─ desktop-preload/
│  ├─ desktop-renderer/
│  └─ agent-worker/
├─ packages/
│  ├─ agent-contract/
│  ├─ agent-runtime-pi/
│  ├─ app-domain/
│  ├─ task-engine/
│  ├─ tool-gateway/
│  ├─ permission-engine/
│  ├─ workspace-service/
│  ├─ document-service/
│  ├─ search-service/
│  ├─ language-service/
│  ├─ terminal-service/
│  ├─ git-service/
│  ├─ change-service/
│  ├─ verification-service/
│  ├─ persistence/
│  ├─ ipc-contracts/
│  ├─ ui-components/
│  └─ test-fixtures/
├─ docs/
│  ├─ PRODUCT_ENGINEERING_SPEC.md
│  ├─ IMPLEMENTATION_STATUS.md
│  ├─ DECISIONS.md
│  ├─ SECURITY.md
│  ├─ PRIVACY.md
│  ├─ RELEASE_CHECKLIST.md
│  └─ TEST_REPORT.md
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ e2e/
│  ├─ security/
│  └─ performance/
├─ fixtures/
│  ├─ ts-small/
│  ├─ ts-large/
│  ├─ python-small/
│  ├─ non-git/
│  ├─ symlink-escape/
│  └─ rollback-matrix/
├─ CLAUDE.md
└─ package.json
```

## 15.1 代码规则

- TypeScript `strict`，禁止无解释 `any`。
- Domain error 使用稳定 code + user message + technical context；不以异常字符串作为协议。
- 所有 I/O 接口接收 AbortSignal 和 logger context。
- 时间、UUID、文件系统、进程执行在测试中可注入。
- UI 组件不直接读数据库或调用 Pi。
- 业务状态机使用显式 transition 函数，非法转换抛出 typed error。
- 每个 IPC、Tool、DB payload 有 schemaVersion。
- 新依赖需记录用途、许可证、native/build 风险；精确锁版本。
- 代码评审重点：路径安全、取消、幂等、崩溃恢复、错误路径和数据迁移。

## 15.2 必需脚本

```text
npm run dev
npm run build
npm run check          # format/lint/typecheck
npm run test           # unit + integration
npm run test:e2e
npm run test:security
npm run test:perf
npm run package
npm run release:verify
```

所有脚本在 CI 和本地行为一致；需要 API Key 的真实模型测试单独标记，不阻塞普通 PR，但阻塞 Runtime 升级与 Stable 发布。

# 16. 验收标准与发布门槛

## 16.1 全局 Definition of Done

一个功能只有同时满足以下条件才算 Done：

1. 正常路径与关键失败路径实现。
2. UI 有 loading、empty、error、disabled 状态。
3. 数据重启后仍一致，或明确为非持久临时数据。
4. 权限、日志、遥测和安全边界已评估。
5. 有自动化测试；无法自动化的有可重复手工步骤和证据。
6. 文档、快捷键、设置和错误码同步更新。
7. 不含静态占位、TODO 核心逻辑或跳过验收的 feature flag。

## 16.2 关键 E2E 验收用例

| ID | 场景 | 通过条件 |
| --- | --- | --- |
| E2E-001 | 首次启动与模型配置 | 干净用户目录启动，配置一个可用 Provider，打开 fixture；重启后凭据可用且 Renderer 无明文。 |
| E2E-002 | 普通编辑与恢复 | 打开两个文件、拆分、修改保存、关闭重启；标签、布局和内容正确。 |
| E2E-003 | 未保存 buffer 冲突 | 用户修改未保存，同时外部进程改磁盘；出现 Compare/Reload/Keep，任何选择都不静默丢失。 |
| E2E-004 | 搜索与替换 | 正则搜索多文件，取消部分结果，预览替换；版本变化的文件不被盲改。 |
| E2E-005 | JS/TS 代码智能 | completion、diagnostics、definition、references、rename 在 fixture 中工作。 |
| E2E-006 | Python 基础 LSP | 打开 Python fixture，diagnostics/completion/definition 工作或给出缺失 server 的明确安装步骤。 |
| E2E-007 | 终端生命周期 | 新建两个终端，运行长进程、resize、停止；退出应用后无孤儿进程。 |
| E2E-008 | Git 基础流程 | 修改文件，查看 Diff，stage/unstage，commit；状态与 git CLI 一致。 |
| E2E-009 | Ask 模式只读 | 询问架构；Tool Gateway 拒绝所有写/执行副作用工具，回答与 Timeline 完整。 |
| E2E-010 | Edit 完整任务 | Agent 修改至少 3 个文件并运行测试，进入 REVIEW_READY，用户接受后状态 ACCEPTED。 |
| E2E-011 | 计划拒绝与编辑 | 首次计划出现，用户编辑并批准；后续 Agent 遵循新计划且历史保留。 |
| E2E-012 | 权限拒绝 | Agent 请求安装依赖，用户拒绝；命令未启动，Agent 收到拒绝并提出替代。 |
| E2E-013 | 高风险命令 | 模型尝试 sudo/git push/Workspace 外写；产品拒绝，0 副作用。 |
| E2E-014 | Agent/用户并发编辑 | Agent 读文件后用户修改；旧 patch 返回 VERSION_CONFLICT，不覆盖用户内容。 |
| E2E-015 | 逐 hunk 审查 | Agent 产生多个 hunk；接受一个、拒绝一个，最终文件与 UI 状态一致。 |
| E2E-016 | 完整回滚 | 任务创建/修改/删除/重命名文件后回滚；字节、存在性、权限位恢复。 |
| E2E-017 | 验证失败再修复 | 第一次测试失败，Agent 修改后第二次通过；两次记录均保留，旧结果 stale/superseded。 |
| E2E-018 | 无验证接受 | 用户跳过验证；Final Report 明确 Unverified，接受需二次确认。 |
| E2E-019 | Worker 崩溃恢复 | 运行中强杀 Agent Worker；窗口可用，任务 INTERRUPTED，重启后可审查/恢复。 |
| E2E-020 | 应用崩溃恢复 | 在写入和等待权限时分别强制退出；重启后数据库、快照和状态一致，无重复执行。 |
| E2E-021 | 符号链接逃逸 | fixture 将路径链接到 Workspace 外；读写工具拒绝且记录稳定错误码。 |
| E2E-022 | 支持包脱敏 | 生成包含错误、命令与 Provider 状态的支持包；不含密钥、代码、Prompt、绝对用户路径。 |
| E2E-023 | 升级与迁移 | 从上一 Beta 安装含旧 DB 的版本升级；迁移成功且任务可读，故障注入时恢复备份。 |
| E2E-024 | 干净机器安装 | macOS/Windows 干净环境安装、启动、卸载；签名/警告符合发布策略。 |

## 16.3 数据完整性门槛

- 50 组回滚矩阵（文本编码、LF/CRLF、新建、删除、重命名、权限位、非 Git）100% 哈希一致。
- 强制终止进程、磁盘写满、权限撤销、DB 事务失败时，不产生“成功但未落盘”的状态。
- 同一 IPC/事件重复投递不会重复执行写工具。
- 迁移前备份可用于恢复；至少演练最近两个 schema 版本升级。

## 16.4 安全门槛

- Renderer：`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`，CSP 测试通过。
- 路径遍历、编码绕过、符号链接/联接、TOCTOU fixture 全部阻止越界。
- R3 未批准执行次数 0；R4 执行次数 0。
- API Key 在 Renderer heap snapshot、localStorage、普通日志、支持包中均不可检出。
- 外部导航、未知协议、恶意 Markdown 链接无法在应用内执行脚本或本地命令。
- 依赖与许可证扫描无未处置的 Critical/High 发布阻断问题。

## 16.5 性能门槛

参考机器：16 GB RAM、4+ 性能核心、SSD；fixture：50k 文件、1 GB 文本、10k Timeline 事件。

- 冷启动至欢迎页 p95 ≤ 5 秒；恢复最近小型 Workspace p95 ≤ 7 秒。
- 编辑输入事件到绘制 p95 < 50 ms；滚动无持续主线程长任务 > 100 ms。
- Quick Open 首批结果 ≤ 300 ms；全局搜索首批结果 ≤ 1 秒，可取消。
- Timeline 新事件显示 p95 < 150 ms；10k 事件滚动可用。
- 空闲小型 Workspace 总内存目标 < 900 MB；超过必须有分析和已知原因，不以此单项否决但需发布评审。
- Agent/搜索/LSP 的大输出不能冻结 Renderer 超过 500 ms。

## 16.6 可靠性门槛

- 50 次连续固定任务无主窗口崩溃、文件丢失、不可恢复数据库损坏。
- Agent Worker、LSP、PTY 各进行 20 次强制崩溃故障注入，主窗口保持可操作。
- 运行中网络断开、Provider 429/5xx、上下文过长、工具超时均给出可恢复状态。
- 应用退出后无遗留 Agent、LSP、PTY 子进程。

## 16.7 产品发布门槛

Stable 发布必须同时满足：

1. 全部 P0 需求实现并追踪到测试。
2. E2E-001 至 E2E-024 全部通过；平台专属项在对应平台通过。
3. 固定 20 个真实任务至少 14 个达到验收，且失败有完整证据。
4. 回滚、安全、可靠性门槛全部通过。
5. macOS、Windows 安装包完成签名/公证或有明确发布阻断记录；Linux 预览不标 Stable。
6. 隐私说明、第三方许可证、变更日志、已知限制和恢复指南完成。
7. 从 Beta 的真实用户数据升级演练成功。
8. 没有 P0/P1 blocker、数据丢失问题或未经批准的高风险动作。

# 17. 测试策略

## 17.1 测试层级

- **Unit**：状态机、path policy、command classifier、patch、revision、event reducer、schema。
- **Contract**：Renderer↔Preload↔Main、Main↔Worker、Product Runtime↔Pi Adapter、Tool schema。
- **Integration**：真实临时文件系统、Git repo、SQLite、PTY/LSP mock/real。
- **E2E**：Playwright 驱动 Electron，使用 deterministic mock Runtime；关键路径另跑真实 Pi smoke。
- **Security**：路径逃逸、恶意 IPC、XSS/导航、命令注入、Secret scanning。
- **Resilience**：kill process、disk full、permission denied、network fault、duplicate events。
- **Performance**：large repo、large file、Timeline、terminal output、search cancellation。

## 17.2 固定任务评估集

至少 20 个版本固定的仓库任务：

- 4 个代码理解/定位。
- 6 个 Bug 修复（含回归测试）。
- 4 个小功能。
- 3 个测试补充。
- 2 个小型重构。
- 1 个失败/权限冲突任务。

每项定义输入 commit、任务文本、验收命令、允许文件范围、预期风险和最大运行预算。报告记录成功、人工介入、工具次数、Token、时间、验证和回滚结果。

## 17.3 覆盖率与质量

- Domain/安全/ChangeService 分支覆盖率 ≥ 90%。
- 其他核心 package 行覆盖率 ≥ 80%。
- UI 组件不以覆盖率替代 E2E；关键状态均有交互测试。
- 禁止通过排除关键文件、空断言或重试掩盖 flaky test。
- E2E flaky 率连续 10 次运行 < 2%；出现 flaky 必须归因。

# 18. CI/CD、发布与运维

## 18.1 CI Pipeline

每个 PR：依赖校验 → format/lint/typecheck → unit → integration → Electron build → 安全扫描。  
主分支每日：三平台 package smoke、E2E、性能抽样、依赖审计。  
Release candidate：全矩阵、真实 Pi 固定任务、签名、SBOM/许可证、升级演练。

## 18.2 发布通道

- `nightly`：开发者内部，不保证迁移。
- `beta`：可升级、收集 opt-in 崩溃与性能数据。
- `stable`：只从通过全部门槛的 Beta 候选提升。

版本采用 SemVer；数据库 schema 与产品版本分别编号。发布说明列出用户可见变化、迁移、已知限制和安全修复。

## 18.3 更新

macOS/Windows 使用应用更新机制，下载前验证发布元数据，安装前保存数据库备份和未完成任务状态。Linux 预览显示新版本但使用包/下载方式更新。更新失败不得破坏当前安装与数据。

## 18.4 日志

- 组件日志：Main、Renderer、Agent、Tool、LSP、PTY、Git、Update。
- 默认 INFO，文件轮转和大小上限。
- 任何内容字段先经过 redaction；生产默认不记录 Prompt、文件正文、Diff 和完整命令输出。
- 每个 Task/Run/Tool 使用 correlation IDs。

# 19. 风险、约束与后续路线

## 19.1 主要风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Pi SDK 快速变化 | Adapter 破坏、恢复格式变化 | 精确锁版本、contract test、升级分支、最小补丁 |
| 应用层权限不等于 OS sandbox | 恶意命令仍有宿主权限风险 | 工具白名单、结构化 spawn、R3/R4、明确告知、未来容器模式 |
| Electron/native modules 打包 | 三平台 PTY/SQLite/LSP 差异 | CI 矩阵、尽早 package smoke、减少 native 依赖 |
| 编辑器与磁盘双状态 | 覆盖用户修改 | Document Store 单一版本模型、revision/hash、冲突流程 |
| 模型行为波动 | 同任务结果不稳定 | 固定评估、证据式验收、Runtime 可替换 |
| 范围膨胀到 VS Code 全功能 | 无法发布 | 严格 V1 非目标、以闭环和可靠性为优先 |
| 大仓库性能 | UI 卡顿、上下文过大 | 懒加载、ripgrep、虚拟化、输出限制、Worker |
| 更新/迁移损坏数据 | 历史和快照丢失 | 备份、事务、迁移演练、只读恢复模式 |

## 19.2 V1.1/V2 候选（不阻塞 V1.0）

- 可选 Docker/OpenShell/微型 VM 强隔离模式。
- Git worktree 任务隔离与多 Agent 并行。
- 浏览器自动化验证和截图证据。
- Remote SSH/Dev Container。
- 插件 API 与自定义 Agent Timeline 组件。
- 云端任务、团队共享、PR 与 Issue 工作流。
- 内联补全、编辑器内生成和更丰富的重构。

## 19.3 仍需产品 Owner 最终选择，但有默认值

- 产品正式名称：默认保留占位名，代码使用中性 package scope。
- Stable 首发平台：默认 macOS + Windows，Linux Preview。
- 默认 Provider/模型：不硬编码品牌默认，首次向导选择。
- 遥测：默认关闭。
- 项目本地 Pi 资源：默认不信任。
- Auto 模式：默认只自动 R0，用户开启后可扩到 R1/已识别 R2。

# 20. 需求追踪与交付检查表

Claude Code 应在实现仓库中生成机器可维护的追踪表，至少包含：Requirement ID、实现 PR/commit、测试 ID、平台、状态、证据链接。以下检查表是发布前最低人工确认：

- [ ] 传统 IDE 链路从打开仓库到 Git commit 无断点。
- [ ] Agent 链路从任务到 Review/Accept/Rollback 无断点。
- [ ] Pi 仅存在于 Adapter；mock Runtime 可运行全部 UI E2E。
- [ ] 高风险工具未经批准不能执行。
- [ ] 文件快照与回滚通过字节级矩阵。
- [ ] 未保存 buffer、外部变化、Agent patch 三方冲突不会丢数据。
- [ ] 验证证据与代码 revision 对应；过期结果有 stale 标识。
- [ ] 崩溃后任务和变更可恢复。
- [ ] 密钥不进入 Renderer、日志、数据库和支持包。
- [ ] macOS/Windows 安装与升级完成，Linux 预览可启动。
- [ ] 全部 E2E、security、resilience、performance gates 有报告。
- [ ] 用户文档、隐私、许可证、已知限制和发布说明齐全。

# 21. 技术事实与参考基线

本规格基于以下官方能力边界：

1. Pi SDK 明确用于把 Agent 能力嵌入桌面/自定义 UI，并提供 AgentSession、事件、prompt/steer/followUp/abort 等能力。
2. Pi 将 coding agent、agent core 与多 Provider API 分包，适合通过 Adapter 隔离。
3. Pi 官方说明默认继承启动进程权限，不内建文件、进程、网络或凭据限制，因此产品必须自建 Tool Gateway 或使用额外容器化。
4. Pi Session 采用 JSONL 树结构，但产品仍需独立 Event Store 与业务投影。
5. Electron 官方进程模型支持 Main/Renderer/Preload 分离；安全基线要求 Context Isolation、Sandbox 和受控 preload。
6. Monaco 是 VS Code 使用的编辑器核心，提供普通与 Diff 编辑器 API。
7. xterm.js 提供终端公共 API；真实 PTY 和进程管理仍由桌面后端负责。

实现时应把锁定版本对应的官方文档快照加入 `docs/vendor-baselines/`，防止“latest”文档与实际依赖不一致。

---

**最终完成定义**：用户能在干净机器上安装 V1.0，配置一个模型，打开真实仓库，像普通 IDE 一样编辑/搜索/运行/Git，也能把任务交给 Pi，在受控权限下完成跨文件修改和验证，审查并接受或字节级回滚；应用在崩溃、冲突和升级后仍保护用户数据。只有达到这个定义和第 16 章发布门槛，产品才算完成。
