const cases = {
  screenshot: {
    kind: "CASE A · ZERO TO ONE",
    title: "Screenshot：捕获到可复用上下文",
    job: "把失败截图从本地瞬时对象，安全地变成 Session 上下文；没有活动 Session 或稍后复用时也不能丢失。",
    beforeScore: "69",
    afterScore: "92",
    beforeTitle: "Boundary validation v1",
    afterTitle: "Parallel + recursive v2",
    before: "../mock-html-boundary-validation/screenshot-flow.html",
    after: "./screenshot/index.html",
    improvements: [
      "没有活动 Session 时，Send 真实禁用，直到用户选择目的地。",
      "asset_01K0X、标注层和 provenance tracer 跨 Capture、Composer、Assets 保持同一身份。",
      "Dismiss 进入可恢复 pending tray；Assets 未保存时展示真实空状态。",
    ],
    iterations: [
      "Pass 1：Reuse 回到 locked composer → 拆分当前 draft sent 与历史 everSent。",
      "Pass 1：Enter 同时触发 Dismiss 与全局 attach → 快捷键排除原生交互控件。",
      "Pass 2：静态 Assets 虚构 scope/annotation → 由真实 saved、session、annotated 状态渲染。",
    ],
  },
  memory: {
    kind: "CASE B · CORRECT DESIGN DEBT",
    title: "Memory：从配置库存转向实际生效因果链",
    job: "让开发者先看见当前项目真正生效的指令、冲突与 precedence，再安全编辑来源，并核对本次运行的不可变回执。",
    beforeScore: "63",
    afterScore: "92",
    beforeTitle: "Boundary validation v1",
    afterTitle: "Parallel + recursive v2",
    before: "../mock-html-boundary-validation/memory-system.html",
    after: "./memory/index.html",
    improvements: [
      "Resolve 不再只隐藏告警：实际编辑 .claude/CLAUDE.md，并同步重算 effective state。",
      "一轮 exclude 只影响该 run；发送后回执锁定，source 文件仍可为未来运行编辑。",
      "桌面与窄窗口都把 effective command、precedence 和冲突放在首屏因果顺序中。",
    ],
    iterations: [
      "Pass 1：CSS display 覆盖 DOM hidden，Draft 与 Sent 同时可见 → 增加全局 hidden integrity 规则和自动审计。",
      "Pass 1：发送后整个配置入口被错误冻结 → 把 immutable receipt 与未来 source config 分离。",
      "Pass 2：复验旧 receipt 在未来 source 保存后仍保持 source、exclusion、command 与 hash。",
    ],
  },
  artifact: {
    kind: "CASE C · EXTEND A HEALTHY MODEL",
    title: "Artifact：让反馈在版本变化后仍可信",
    job: "在 Session 结束后继续审查同一 artifact set；反馈必须绑定不可变版本与区域，regenerate 后显式 re-anchor 或保留在 v1。",
    beforeScore: "62",
    afterScore: "93",
    beforeTitle: "Boundary validation v1",
    afterTitle: "Parallel + recursive v2",
    before: "../mock-html-boundary-validation/artifact-lifecycle.html",
    after: "./artifact/index.html",
    improvements: [
      "artifact_set_01K1A 和 Q2-review.pdf 的版本、反馈 anchor、history return 使用统一身份。",
      "Regenerate 产生 v2，不静默迁移 v1 note；用户可查看原版本、re-anchor 或保留。",
      "Session completion 先呈现 outcome，再进入 primary artifact 与 supporting evidence。",
    ],
    iterations: [
      "Pass 1：严格旧版暴露 MD/CSV 不可浏览、re-anchor 后 History 仍停留 v1 等 blocker。",
      "Pass 1：新版把 artifact/version/region/author/feedback ID 写进同一 receipt，并让 History 精确恢复。",
    ],
  },
};

const $ = (selector) => document.querySelector(selector);

function fillList(selector, items) {
  const list = $(selector);
  list.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      return li;
    }),
  );
}

function showCase(name) {
  const item = cases[name];
  document.querySelectorAll("[data-case]").forEach((button) => {
    const active = button.dataset.case === name;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#case-kind").textContent = item.kind;
  $("#case-title").textContent = item.title;
  $("#case-job").textContent = item.job;
  $("#before-score").textContent = item.beforeScore;
  $("#after-score").textContent = item.afterScore;
  $("#after-unit").textContent = item.afterScore === "复验中" ? "" : "/100";
  $("#before-title").textContent = item.beforeTitle;
  $("#after-title").textContent = item.afterTitle;
  $("#before-link").href = item.before;
  $("#after-link").href = item.after;
  $("#before-frame").src = item.before;
  $("#after-frame").src = item.after;
  fillList("#improvements", item.improvements);
  fillList("#iterations", item.iterations);
}

document.querySelectorAll("[data-case]").forEach((button) => {
  button.addEventListener("click", () => showCase(button.dataset.case));
});

showCase("screenshot");
