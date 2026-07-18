# ADR-0027: M11 hardening implementation — fuses, secret verification, Room windowing, accessibility, privacy

- 状态：Accepted
- 日期：2026-07-18
- 关联需求：§16.4、§16.5、A11Y-001..005、PRIV-001..003；ADR-0025（M11 重定义）；ADR-0022（预览注入）
- 关联 mockup：`docs/design/m11-functional-mockups/`（用户确认的 UI 缩放 / 无障碍 Diff / 隐私设置三稿）

## 背景

ADR-0025 把 M11 重定义为对现状代码的差距收口。本 ADR 记录实现阶段的具体技术
决策与取舍（对应 backlog M11-01..07 + 报告 M11-06）。基线 `e81b72e`。

## 决策

### M11-01 Electron 硬化

- **Fuses 在 `afterPack` 翻转**，plan 抽成 `scripts/fuse-plan.cjs`（CJS，供打包
  钩子与安全单测共享同一对象）。`resetAdHocDarwinSignature: true` 因翻转会使
  arm64 ad-hoc 签名失效；发布签名（M12-02）在其上重签。
- **纯策略抽取**：`security-policy.ts`（导航/外链）与 `preview-security.ts`
  （iframe sandbox / pick 源）从 electron 依赖中剥离，使安全套件可直接钉死。
- **`test:security` 双入口恢复**：`vitest.security.config.ts` 显式聚合散落于普通
  套件的遍历/符号链接/风险级用例 + 仅本套件的策略钉死；playwright 半场跑真实
  Electron 的 CSP/导航矩阵。既有用例归拢而非重写。
- E2E 教训：被 `will-navigate` 拦截的顶帧导航会让 Playwright 卡在
  navigation-pending；改为主进程 spy 断言拦截 + `page.goto` 重同步。

### M11-02 秘密不可检出

- **四路验证走真实路径**：经 provider IPC 存哨兵 key → reload → CDP
  `HeapProfiler.takeHeapSnapshot` 扫 renderer 堆 + web storage + 磁盘日志 + 支持
  包。reload 是关键：证明「已配置的 key 不会再水合进 renderer」。
- **扫描器与 redact 同源**：`findSecrets()` 复用 redact 的 pattern；`.mjs` 扫描器
  因无法 import TS 源，副本由单测钉死标签一致，并对 `sk-` 加前置非字母边界避免
  匹配 `task-*` kebab id（redact 保持宽松——过度脱敏是安全方向）。
- repo 扫描进 `test:security` 作为 CI 闸。

### M11-03 性能基建

- `vitest.perf.config.ts` 单线程无隔离（避免 worker 争用扭曲计时）。
- 双档 fixture：默认档秒级可跑抓算法回归，`PI_IDE_PERF_FULL=1` 放大到 §16.5
  参考负载（50k 文件 / 1GiB 文本）。1GiB 文本流式写入，内存恒定。
- 大文件超过 SearchService 4MiB/文件上限被跳过——诚实边界断言（大输出不冻结）。

### M11-04 Room 窗口化（最大改动对象换位）

- **渐进窗口而非绝对定位虚拟滚动**：Room 有可变高 worklog 分组、milestone、
  卡片、置底跟随、滚动记忆——绝对定位虚拟化会与这些冲突。改为「只渲染尾部
  N=400 + load-earlier 分块」，`computeWindow`/`growWindow` 纯函数单测。
- 汇总统计（token/cost/action 数）仍遍历全 timeline（廉价数值循环），只有
  「建 React 节点」这一昂贵步骤限于窗口。与 repo-clean `7421d2e` 的分界：memo 化
  只消除逐 token 重建，不是窗口化。
- load-earlier 用 `useLayoutEffect` 锚定滚动，避免前插节点跳视口。
- **大输出冻结门**：流式 buffer 在 store 侧封顶 256KB（完成事件另带全文，截断
  无损）；渲染侧超 16KB 走 plain-text 尾巴而非每 token 重解析 markdown。
- 测试缝：`initialWindow()` 读 `globalThis.__PI_IDE_TIMELINE_WINDOW`，e2e 设小窗
  用既有多事件场景越过阈值，免于播种万级事件。

### M11-05 可访问性

- **UI 缩放用真窗口缩放**：`general.uiScale`（schema 已存在但此前仅 rem hack，
  不缩放 Monaco/终端）改由主进程 `webContents.setZoomFactor` 应用——Monaco 与
  xterm 一并缩放，满足 A11Y-003；rem hack 移除以免叠加。缩放梯 80–200% 抽成
  `ui-zoom.ts` 纯模块，菜单 ⌘±/⌘0 + Settings 段共享。`setVisualZoomLevelLimits(1,1)`
  关掉捏合缩放，使缩放只来自显式设置。
- **无障碍 Diff 文本模式**：既有 inline diff 加「Inline ⇄ Text mode」切换；文本模式
  把变更行 run 线性化为可聚焦卡片，F7/⇧F7 文档级监听（容器不可聚焦，故不用
  onKeyDown）。分组/播报文案抽成 `accessible-diff.ts` 纯模块单测。
- **A11Y-004 live region**：Room 活动条设 `role=status aria-live=polite`——标签本就
  按 action 粒度变（非逐 token），天然「适度」。

### M11-07 隐私（诚实降级是核心决策）

- 本 build **无任何遥测/崩溃上报传输**。按 CLAUDE.md 规则 9，不能呈现暗示「正在
  发送」的假开关：整卡显式声明「nothing is ever sent；开关只记录偏好」。
- **崩溃预览是真的**：`crashPreview` 从真实 app 状态 + 真实日志尾 经真实
  `redactText` 生成——证明脱敏，而非示意文案。
- **PRIV-003 删除是真的**：`clearHistory` 在一个事务里按子表优先顺序删除任务历史
  （FK 无 CASCADE）+ blobs + app_errors，再删附件目录与日志文件；保留 settings /
  provider keys / workspace 注册 / UI 布局。两步确认。

## 替代方案

- Room 绝对定位虚拟滚动——与可变高分组/置底跟随冲突，否决（见 M11-04）。
- 缩放沿用 rem hack——不缩放 Monaco/终端，不满足 A11Y-003，否决。
- 隐私假开关照搬 mock 上半——违反规则 9，改为 mock 自带的诚实降级分支。

## 安全与数据影响

安全面只增不减（fuses、四路验证、预览注入审计、repo 扫描闸）。新增一处真实
破坏性操作 `privacy.clearHistory`——两步确认 + 保留 settings/keys，删除范围含已
归档任务（ADR-0025 待确认点，按「包含」实现）。DOMPurify 中危经 monaco 传递，
CSP + 无 setConfig 调用已缓解，挂 M12。

## 迁移/回滚

无 schema 迁移。新增 IPC 通道 `privacy.dataSummary`/`crashPreview`/`clearHistory`
（versioned strict）。回滚 = revert 本批改动；fuses 仅在打包生效，dev 不受影响。

## 验证证据

见 `docs/M11_SECURITY_PERFORMANCE_REPORT.md`。摘要：`test:security` 137 vitest + 2
e2e 全绿；`test:perf` 6 全绿（50k FULL 验证）；524 单测；`npm run check` clean；
四张真机截图（无障碍 Diff、隐私面板、崩溃预览）在
`docs/design/m11-functional-mockups/impl-shots/`。
