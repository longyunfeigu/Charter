# ADR-0015: 托管 Skills(SKILL.md)与信任模型

- 状态:Accepted
- 日期:2026-07-14
- 关联需求:AG-014、TOOL-001、PERM 系列;mockup `docs/design/skills-manager-mockup.html`(用户确认)

## 背景

用户要求引入 Agent Skills(SKILL.md 标准,同 Claude Code / Codex / pi CLI):可复用的
技能文件夹,模型按 description 自动调用,或用户显式 `/skill:name` 唤起,并有可视化
管理器(启用/禁用/审计/导入)。

AG-014(P0)规定:默认不加载未信任项目的扩展/技能/提示,**且加载行为必须可审计**。
本 ADR 是对 AG-014 的受控落地——不是放开,而是给技能一个满足其审计要求的加载通道。

## 决策

1. **托管库,绝不扫描项目目录。** 技能只能由用户从本地文件夹显式导入,复制进
   `userData/skills/<slug>/`(AppPaths.skillsDir)。项目内的 `.pi/`、`.agents/` 等目录
   永远不被发现或加载——AG-014 原语义完整保留,且比 Claude Code/Codex(默认扫描项目
   目录)更严格。
2. **两态开关 + 作者声明。** 每个技能 Off(完全不生效:不进提示、不进 "/" 选择器、
   不可加载)或 Auto(启用;导入默认 Auto)。SKILL.md frontmatter
   `disable-model-invocation: true` 被尊重:该技能即使启用也不进入系统提示(模型不会
   自动触发),仅 `/skill:name` 显式可用,UI 以 explicit-only 徽章提示。
3. **加载走网关工具 `load_skill`(R0),天然可审计。** pi 原生技能机制教模型"用内置
   read 工具读 SKILL.md"——本产品禁用全部 pi 内置工具(TOOL-001),且网关 read_file 只能
   读工作区文件。因此技能加载改为产品自己的网关工具:
   - `load_skill { name, file? }`:从托管库读 SKILL.md 或打包引用文件;路径穿越拒绝;
     R0 只读,各模式可用;**每次加载都进 tool audit 与任务时间线**——这正是 AG-014 要求
     的"加载可审计"。
   - 系统 preamble 注入 `<available_skills>`(仅启用且非 explicit-only 的 name+description),
     指示模型在任务匹配时先调 load_skill——渐进式披露,上下文成本 = 名称+描述。
4. **`/skill:name` 在产品侧展开(main),不在 runtime。** doLaunch 与 steer/follow-up
   把开头的 `/skill:name args` 展开为 `<skill>` 指令块(镜像 pi CLI 的展开格式)。
   时间线记录用户原文;mock runtime 同样生效(可测试)。
5. **脚本零特权。** 技能打包的脚本不会因被加载而执行;模型要跑它仍走 run_command →
   Permission Engine 正常分级审批。审计视图(Settings)在启用前可查看 SKILL.md 与全部
   打包文件,脚本高亮。
6. **不改 pi adapter / agent contract。** 方案完全在 main + 网关层;
   `packages/agent-runtime-pi` 边界不动,任何 runtime(含 mock)行为一致。

## 替代方案

- **pi DefaultResourceLoader(additionalSkillPaths)+ formatSkillsForPrompt**:被否。
  其注入被 `selectedTools.includes('read')` 门控,本产品永不满足;且把技能语义绑死在
  pi 上,mock/未来 runtime 不可用,加载(readFileSync)绕过审计。
- **把启用技能全文内联进 preamble**:被否。失去渐进披露,技能多时上下文成本失控。
- **市场/git 安装**:V1 范围外;托管库结构已为后续来源预留(source 字段)。

## 安全与数据影响

- 攻击面:导入的技能内容会进入模型上下文(提示注入向量)。缓解:显式导入 + 审计视图
  + 默认不信任项目目录 + 脚本执行仍全量走权限引擎 + load_skill 只读且路径受限。
- 导入校验:必须含 SKILL.md;>500 文件或 >20MB 拒绝;不允许从托管库自身导入。
- skills.read(审计)与 load_skill 均做路径穿越防护与二进制探测,内容截断上限。

## 验证证据

- 单元:`skill-store.test.ts`(frontmatter/导入校验/开关/展开/穿越防护)、
  `tools-skill.test.ts`(load_skill 未知技能/穿越/二进制/截断)。
- E2E:`skills.spec.ts` — 管理器列表/开关/审计;composer "/" 选择器只列启用技能;
  `/skill:` 任务经 mock runtime 跑通;Off 技能既不进 "/" 也不进 preamble。
