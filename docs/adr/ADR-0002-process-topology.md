# ADR-0002: 进程拓扑 —— 宿主服务在 Main，Agent Worker 只承载模型回路

- 状态：Accepted
- 日期：2026-07-12
- 关联需求：AG-002、REL-001/002、TOOL-001、§9.2

## 背景

规格 §9.2 示意图把 Task Engine、Tool Gateway、DB、Git 放进 Agent Utility Process。
实现评估发现该划分与若干验收约束冲突：Worker 崩溃时（E2E-019/020）主进程必须继续读写任务库、
标记 INTERRUPTED、驱动恢复页；DB 单写者原则也要求持久层不随 Worker 生命周期波动。

## 决策

- **Main 进程**：窗口、Secret Store、SQLite（node:sqlite）、Task Engine、Tool Gateway、Permission Engine、
  ChangeService、Workspace/Document/Git/Search/Verification/Terminal 服务。
- **Agent Utility Process**：仅承载 AgentRuntime（Pi Adapter / Mock）。工具调用经 MessagePort RPC 回到 Main 的
  Tool Gateway 执行；Worker 进程内没有任何文件/命令执行器，也没有密钥存储。
- 事件流：Worker → Main（持久化 + 投影）→ Renderer。

规格优先级条款（验收标准 > 架构决策）允许该偏离；本 ADR 记录之。

## 安全与数据影响

正向：模型回路（最接近不可信输入的代码）运行在能力最小的进程里；工具执行点与权限检查点合一。
风险：Main 承担更多工作 —— 所有 I/O 保持异步、哈希/大 blob 处理走流式，性能门槛测试覆盖。

## 验证证据

- E2E：强杀 Worker 后窗口可用、任务转 INTERRUPTED（M6/M10）。
- 单元：Tool Gateway 在 Main 侧强制 schema/权限/路径边界（M7）。
