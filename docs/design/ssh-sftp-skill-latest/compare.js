const comparison = document.querySelector("#comparison");
const note = document.querySelector("#layout-note");
const frames = [
  document.querySelector("#previous-frame"),
  document.querySelector("#latest-frame"),
];

function setLayout(layout) {
  const stacked = layout === "stack";
  comparison.classList.toggle("stack", stacked);
  document.querySelectorAll("[data-layout]").forEach((button) => {
    const active = button.dataset.layout === layout;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  note.textContent = stacked
    ? "当前两版各占完整页面宽度，适合比较桌面信息层级；向下滚动查看最新版。"
    : "当前两列等宽，因此两边都会进入紧凑/窄窗布局；切到“上下看桌面”可比较完整桌面层级。";
}

document.querySelectorAll("[data-layout]").forEach((button) => {
  button.addEventListener("click", () => setLayout(button.dataset.layout));
});

document.querySelector("#reload-frames").addEventListener("click", () => {
  frames.forEach((frame) => {
    frame.src = frame.src;
  });
});

setLayout("side");
