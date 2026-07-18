# Session 上下文附件 · 方案 D 混合终案 + 4 个来源方向(mock)

状态:**方案 D(混合终案)待用户拍板**(2026-07-18)。仅设计 mock,未写产品代码。

> 命名说明:用户把「A 抽屉 + C 落点」的混合态定名为**方案 D**(`d-hybrid.html`);
> 原方案 D「@ 内联引用」已更名为**方案 E**(`e-inline-mentions.html`,缓议)。

## 问题

Session 视图没有任何文件可见性:想把 `public/index.html`、一张设计稿截图或整个
`styles/` 目录交给代理时,无处可拖、无处可选,只能靠文字描述路径。用户明确要求:
能把**文件 / 图片 / 文件夹**拖进上下文。

## 现有基础(比预想的多 —— 四个方案的实质是"补齐 + 统一",不是从零)

规格里这件事叫 **context feeding**(`docs/UX_PIVOT_SPEC.md` PIVOT-015;图片标注/附件
= PIVOT-020),而且 **Home 侧已实现大半**;缺口集中在用户截图的 Session/Room 视图:

- **Home composer 已支持**:内部树拖拽 + **OS 文件拖放**(`HomeView.tsx:314-345`,
  `pathForDroppedFile`/webUtils 取路径 → `workspace.relativize`;工作区外文件跳过
  并 toast),落成可移除 chips(`refs: string[]`),提交时以 `Context files:\n- @path`
  并入 goal。
- **Home 侧栏已有可拖文件树** `HomeProjectTree.tsx`(行 draggable,经
  `views/dragRefs.ts`;内部 MIME `application/x-charter-ref`,与本目录 mock 所用一致,
  文件夹以尾随 `/` 区分)。
- **Session/Room 视图是缺口所在**:`TaskRoomView` 只接内部树引用、**不接 OS 拖放**
  (`dragHandlers`,TaskRoomView.tsx:635-650);引用被**插成行内 `@path` 纯文本**
  (TaskRoomView.tsx:614-628),与 Home 的 chips 是并存的两套模式;且该视图内没有
  任何文件树可作拖源 → 用户感知"拖不了、看不到目录"。
- **@ 按钮已存在**(`home-attach`/`room-attach`):`search.files` RPC 文件拾取
  popover,按当前聚焦项目过滤;Home 版还能引用会话;任务项目非聚焦 workspace 时禁用。
- **图片缩略图 chip 已有先例**:previewRefs(预览圈选截图,`<img thumbDataUrl>`
  chip,TaskRoomView.tsx:709-729)。通用"拖任意图片进来"尚不存在。
- 代码选区引用 `CodeContextAttachments`(max 6 / 48k 字符)、终端引用(max 4)、
  会话引用(Home,max 3)都在 `draftStore`(session 级,不持久化)。
- 另一个顺手可补的缺口:Editor surface 的 `ExplorerView` 行**不可拖**(无 onDragStart)。
- 规格依据:PIVOT-015(拖文件/文件夹到 composer 变路径引用 chips、@ 打开文件拾取器)、
  PIVOT-020(标注器"attach to task");`PRODUCT_ENGINEERING_SPEC.md` §IDE 集成(约
  663 行)要求上下文=**显式附件注入**,"而不是悄悄永久加入 Session"。
- 视觉:用户运行 **archive/light** skin(`theme.css:117-164`,赤陶色 accent
  `#b94e32`;注意产品默认 skin 是 studio、accent 近黑 —— mock 按用户实际使用的
  archive 做)+ Codicon 图标。

**由此,四个方向的实质:**

- A = 把现有 @ 拾取器升级成"树 + 搜索 + 拖拽 + 文件夹/图片"的抽屉;
- B = 把 Home 已有的可拖树搬进会话视图常驻(可顺手让 ExplorerView 也可拖);
- C = 把 Home 已有的 OS 拖放**补进 Room** 并升级为全窗靶区 + 新增"固定为项目上下文"作用域;
- D = 把 Room 现有的行内 `@path` 纯文本升级为原子富 token + 光标处菜单。

## 方案一览

| 方案 | 状态 | 文件 | 一句话本质 |
| --- | --- | --- | --- |
| **D 混合终案** | **推荐,待拍板** | `d-hybrid.html` | A 的抽屉 + C 的落点:@ 开文件抽屉;对话列整体接 Finder 拖放/粘贴截图;引用一律落 chips;项目外文件复制进任务附件;发送后引用随消息进时间线(页内可点「发送」看闭环) |
| A 文件抽屉 | 已并入 D | `a-composer-drawer.html` | 📎 在输入框上开悬浮目录树(树+搜索+会话改动),拖或点 ＋ 落成引用条 |
| B 会话内文件面板 | 建议不采用 | `b-session-explorer.html` | 左侧栏 Sessions/Files 双页签,树常驻。不采用理由:产品将同时存在三棵树(Home 树/Explorer/它),概念重复;挤掉 Sessions 列表;违反"会话视图不放第二 Explorer"约束;Files 视图已是"常看目录"的正式场所 |
| C 全窗拖放 + Context 页签 | 落点机制并入 D;"固定上下文"+Context 页签=第二期 | `c-drop-anywhere.html` | 拖进窗口任意处,浮层分流"这条消息 / 固定为项目上下文";右侧 Context 页签管理全部 |
| E @ 内联引用(原 D) | 缓议 | `e-inline-mentions.html` | 输入 @ 光标处模糊搜索,引用作为 token 嵌进句子。缓议理由:composer 需改 contenteditable,中文 IME × 原子 token 风险高;D 落地后仍想要句中语义再单独立项 |

入口:`index.html`(总览,D 置顶,含取舍说明)。

## 方案 D 的分期

- **第一期(拍板即做)**:Room 接 OS 拖放(复用 Home 链路)+ 对话列整体靶区 +
  @ 拾取器升级为文件抽屉 + 图片一等(拖/粘贴 → 缩略图 chip)+ 项目外文件复制进
  `attachments/<taskId>/` + 统一落 chips(Room 弃行内 @path 纯文本)+ 发送后引用进时间线
  + ExplorerView 行补 draggable。
- **第二期(单独 ADR,可不做)**:"固定为项目上下文"作用域 + 全窗双靶浮层 +
  右侧 Context 页签(形态见方案 C 页)。

## 怎么看

- 每页顶部深色条 = mock 场景控制器(非产品 UI),含「演示 / 重置」。
- 四页都接了**真实拖放**:从 Finder 拖文件 / 文件夹 / 图片进页面即可看落点行为
  (文件夹会递归数条目,图片出缩略图)。
- 方案 D 页额外有「演示:粘贴截图」「演示:发送」——发送后能看到引用随消息进时间线的闭环;
  真实剪贴板里的截图也可以直接 ⌘V 粘进输入框。

## 四个决策点 · 终案 D 的回答(待用户确认)

1. 方向 → **D 混合终案**(A 抽屉 + C 落点),B 不采用,E 缓议;
2. 统一命题 → **一律落 chips**,Room 弃行内 `@path` 纯文本;
3. "固定为项目上下文" → **进第二期**,单独 ADR,不阻塞第一期;
4. 项目外文件 → **复制进 `attachments/<taskId>/`**(spec 已有该存储路径;
   拖设计稿截图恰恰多来自项目外),不再像 Home 现状那样 toast + 跳过。

## 确认后的实现要点(预告)

- **补齐 Room 与 Home 的拖放对称性**:Room composer 接入 OS 拖放,复用
  `pathForDroppedFile`(bridge.ts,webUtils)+ `workspace.relativize` 既有链路,
  与现有 `dragHandlers`(内部 refs)合流。
- 扩展 `draftStore` 引用模型:在 refs/codeRefs/terminalRefs/previewRefs 之外统一
  file/folder/image 类型(走 ipc-contracts 版本化 schema;文件夹引用需大小/数量
  上限与忽略规则,参照 codeRefs 的 max 6 / 48k 先例)。
- 图片:通用图片引用 chip 复用 previewRefs 的 `thumbDataUrl` chip 先例;与
  PIVOT-020 标注器的 "attach to task" 汇合成同一条图片管道。
- 发送链路:引用随 prompt 注入(显式附件语义,对齐 spec §663),时间线沿用
  `SentCodeContext` 已确认样式;顺手给 `ExplorerView` 行补 draggable(走 dragRefs)。
- 项目外文件的权限边界(Tool Gateway / Permission Engine)按决策点 4 的结论定。
