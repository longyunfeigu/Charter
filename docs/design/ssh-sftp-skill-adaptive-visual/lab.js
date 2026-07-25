const directions = {
  heritage: {
    title: "A · Warm Archive",
    hypothesis: "假设：更温暖、舒展的桌面工具感，会让长时间文件操作更安静、更有记忆点。",
  },
  native: {
    title: "B · Mac Utility",
    hypothesis: "假设：系统字体、冷静中性色和更紧凑的密度，会提高扫描效率并降低学习成本。",
  },
  synthesis: {
    title: "C · Warm Precision",
    hypothesis: "假设：温暖表面、少量衬线锚点和适中密度，可以兼顾产品个性与操作清晰度。",
  },
};

const cards = [...document.querySelectorAll("[data-theme]")];
const frame = document.querySelector("#mock-frame");
const title = document.querySelector("#preview-title");
const hypothesis = document.querySelector("#preview-hypothesis");
const openFull = document.querySelector("#open-full");
const rejectionPanel = document.querySelector("#rejection-panel");

function sourceFor(theme) {
  return `../ssh-sftp-skill-user-first/index.html?theme=${theme}`;
}

function showDirection(theme) {
  const direction = directions[theme];
  cards.forEach((card) => {
    const active = card.dataset.theme === theme;
    card.classList.toggle("active", active);
    card.setAttribute("aria-pressed", String(active));
  });
  frame.src = sourceFor(theme);
  title.textContent = direction.title;
  hypothesis.textContent = direction.hypothesis;
  openFull.href = sourceFor(theme);
  rejectionPanel.hidden = true;
}

cards.forEach((card) => {
  card.addEventListener("click", () => showDirection(card.dataset.theme));
});

document.querySelector("#reset-frame").addEventListener("click", () => {
  frame.src = frame.src;
});

document.querySelector("#reject-all").addEventListener("click", () => {
  rejectionPanel.hidden = false;
  rejectionPanel.scrollIntoView({ behavior: "smooth", block: "center" });
});
