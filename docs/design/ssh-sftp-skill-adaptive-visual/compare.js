const comparison = document.querySelector("#comparison");
const note = document.querySelector("#layout-note");
const previousFrame = document.querySelector("#previous-frame");
const latestFrame = document.querySelector("#latest-frame");
const latestTitle = document.querySelector("#latest-title");
const latestLink = document.querySelector("#latest-link");
const latestNote = document.querySelector("#latest-note");

const directions = {
  heritage: {
    title: "本轮 A · Warm Archive",
    note: "在保留双栏和第三栏的前提下，用温暖纸张感、衬线锚点和舒展密度测试长时间操作的舒适度。",
  },
  native: {
    title: "本轮 B · Mac Utility",
    note: "在保留双栏和第三栏的前提下，用系统字体、冷静中性色和紧凑密度测试原生熟悉感与扫描效率。",
  },
  synthesis: {
    title: "本轮 C · Warm Precision",
    note: "在保留双栏和第三栏的前提下，用暖中性表面、克制的衬线锚点和适中密度测试“个性 + 清晰度”的融合假设。",
  },
};

function sourceFor(theme) {
  return `../ssh-sftp-skill-user-first/index.html?theme=${theme}`;
}

function setLayout(layout) {
  const stacked = layout === "stack";
  comparison.classList.toggle("stack", stacked);
  document.querySelectorAll("[data-layout]").forEach((button) => {
    const active = button.dataset.layout === layout;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  note.textContent = stacked
    ? "当前两版各占完整页面宽度，适合比较桌面信息层级；向下滚动查看本轮重跑版本。"
    : "当前两列等宽，因此两边都会进入紧凑布局；适合直接比较窄窗适应，但不代表完整桌面密度。";
}

function setTheme(theme) {
  const direction = directions[theme];
  latestFrame.src = sourceFor(theme);
  latestLink.href = sourceFor(theme);
  latestTitle.textContent = direction.title;
  latestNote.textContent = direction.note;
  document.querySelectorAll("[data-theme]").forEach((button) => {
    const active = button.dataset.theme === theme;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

document.querySelectorAll("[data-layout]").forEach((button) => {
  button.addEventListener("click", () => setLayout(button.dataset.layout));
});

document.querySelectorAll("[data-theme]").forEach((button) => {
  button.addEventListener("click", () => setTheme(button.dataset.theme));
});

document.querySelector("#reload-frames").addEventListener("click", () => {
  previousFrame.src = previousFrame.src;
  latestFrame.src = latestFrame.src;
});

setLayout("stack");
setTheme("synthesis");
