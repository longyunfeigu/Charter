const PRESETS = {
  conversation: { pct: 64, label: '对话优先' },
  balanced: { pct: 56, label: '均衡' },
  tools: { pct: 40, label: '工具优先' },
};

const stage = document.getElementById('stage');
const workspace = document.getElementById('workspace');
const handle = document.getElementById('split-handle');
const menuButton = document.getElementById('layout-button');
const menuButtonLabel = document.getElementById('layout-button-label');
const menu = document.getElementById('layout-menu');
const focusButton = document.getElementById('focus-button');
const returnSplit = document.getElementById('return-split');
const returnLayoutLabel = document.getElementById('return-layout-label');
const ratioChip = document.getElementById('ratio-chip');
const studyReadout = document.getElementById('study-readout');
const studyReset = document.getElementById('study-reset');
const scenarioButtons = [...document.querySelectorAll('.scenario-button')];
const presetButtons = [...document.querySelectorAll('[data-layout]')];

let pct = PRESETS.balanced.pct;
let selected = 'balanced';
let dragging = false;
let focused = false;
let scenarioManuallyChosen = false;
let chipTimer;

function bounds() {
  const width = workspace.clientWidth;
  const divider = handle.offsetWidth || 12;
  const available = Math.max(width - divider, 1);
  return {
    min: Math.max(34, (380 / available) * 100),
    max: Math.min(66, 100 - (360 / available) * 100),
  };
}

function clamp(next) {
  const { min, max } = bounds();
  const clamped = Math.min(Math.max(next, min), max);
  handle.classList.toggle('at-limit', Math.abs(clamped - next) > 0.01);
  return clamped;
}

function positionChip() {
  const width = workspace.clientWidth;
  ratioChip.style.left = `${(width * pct) / 100}px`;
}

function describeMode() {
  if (selected === 'custom') return `自定义 · 对话 ${Math.round(pct)} / 工具 ${Math.round(100 - pct)}`;
  const preset = PRESETS[selected];
  return `${preset.label} · 对话 ${Math.round(pct)} / 工具 ${Math.round(100 - pct)}`;
}

function paint(next, { mode = selected, announce = false } = {}) {
  pct = clamp(next);
  selected = mode;
  workspace.style.setProperty('--conversation-width', `${pct}%`);
  handle.setAttribute('aria-valuenow', String(Math.round(pct)));
  handle.setAttribute('aria-valuemin', String(Math.round(bounds().min)));
  handle.setAttribute('aria-valuemax', String(Math.round(bounds().max)));
  menuButtonLabel.textContent = selected === 'custom' ? '自定义' : PRESETS[selected].label;
  studyReadout.textContent = describeMode();
  returnLayoutLabel.textContent = `恢复${selected === 'custom' ? '自定义' : PRESETS[selected].label} · ${Math.round(pct)} / ${Math.round(100 - pct)}`;
  positionChip();

  ratioChip.querySelector('strong').textContent =
    selected === 'custom' ? '自定义布局' : PRESETS[selected].label;
  ratioChip.querySelector('span').textContent =
    `对话 ${Math.round(pct)} / 工具 ${Math.round(100 - pct)}`;

  presetButtons.forEach((button) => {
    const key = button.dataset.layout;
    if (!PRESETS[key]) return;
    button.setAttribute('aria-checked', String(key === selected));
  });

  if (announce) flashChip();
}

function flashChip() {
  ratioChip.classList.add('visible');
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => ratioChip.classList.remove('visible'), 1300);
}

function openMenu() {
  menu.hidden = false;
  menuButton.setAttribute('aria-expanded', 'true');
  const active = menu.querySelector('[aria-checked="true"]') || menu.querySelector('button');
  active.focus();
}

function closeMenu({ restoreFocus = false } = {}) {
  menu.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
  if (restoreFocus) menuButton.focus();
}

function applyPreset(key, { announce = true } = {}) {
  const preset = PRESETS[key];
  if (!preset) return;
  paint(preset.pct, { mode: key, announce });
  closeMenu({ restoreFocus: true });
}

function setFocusMode(next) {
  const wasFocused = focused;
  focused = next;
  workspace.classList.toggle('focused', focused);
  focusButton.setAttribute('aria-pressed', String(focused));
  returnSplit.hidden = !focused;
  ratioChip.classList.remove('visible');
  clearTimeout(chipTimer);
  closeMenu();
  if (!focused && wasFocused) {
    paint(pct);
    if (!stage.classList.contains('narrow')) handle.focus();
  }
}

function resetDemo() {
  scenarioManuallyChosen = false;
  setFocusMode(false);
  paint(PRESETS.balanced.pct, { mode: 'balanced', announce: true });
  setScenario(window.innerWidth <= 1050 ? 'narrow' : 'desktop');
}

function setScenario(name) {
  const isNarrow = name === 'narrow';
  stage.classList.toggle('narrow', isNarrow);
  scenarioButtons.forEach((candidate) => {
    candidate.classList.toggle('active', candidate.dataset.scenario === name);
  });
  ratioChip.classList.remove('visible');
  clearTimeout(chipTimer);
  closeMenu();
  setFocusMode(false);
  requestAnimationFrame(() => {
    if (!isNarrow) paint(pct);
    studyReadout.textContent = isNarrow
      ? '窄窗口 · 上下堆叠，保持两侧上下文'
      : describeMode();
  });
}

menuButton.addEventListener('click', () => {
  if (menu.hidden) openMenu();
  else closeMenu();
});

menu.addEventListener('keydown', (event) => {
  const items = [...menu.querySelectorAll('button')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu({ restoreFocus: true });
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + delta + items.length) % items.length].focus();
  }
});

presetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const key = button.dataset.layout;
    if (key === 'reset') applyPreset('balanced');
    else applyPreset(key);
  });
});

document.addEventListener('pointerdown', (event) => {
  if (menu.hidden) return;
  if (event.target.closest('.layout-control')) return;
  closeMenu();
});

handle.addEventListener('pointerdown', (event) => {
  if (focused || stage.classList.contains('narrow')) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  dragging = true;
  handle.classList.add('dragging');
  ratioChip.classList.add('visible');
  clearTimeout(chipTimer);
});

handle.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const rect = workspace.getBoundingClientRect();
  paint(((event.clientX - rect.left) / rect.width) * 100, { mode: 'custom' });
});

function endDrag(event) {
  if (!dragging) return;
  dragging = false;
  if (event && handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  handle.classList.remove('dragging');
  flashChip();
}

handle.addEventListener('pointerup', endDrag);
handle.addEventListener('pointercancel', endDrag);

handle.addEventListener('dblclick', () => applyPreset('balanced'));

handle.addEventListener('keydown', (event) => {
  if (event.key === 'Home') {
    event.preventDefault();
    applyPreset('conversation');
    return;
  }
  if (event.key === 'End') {
    event.preventDefault();
    applyPreset('tools');
    return;
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const step = event.shiftKey ? 8 : 2;
  const delta = event.key === 'ArrowLeft' ? -step : step;
  paint(pct + delta, { mode: 'custom', announce: true });
});

focusButton.addEventListener('click', () => setFocusMode(true));
returnSplit.addEventListener('click', () => setFocusMode(false));
studyReset.addEventListener('click', resetDemo);

scenarioButtons.forEach((button) => {
  button.addEventListener('click', () => {
    scenarioManuallyChosen = true;
    setScenario(button.dataset.scenario);
  });
});

window.addEventListener('resize', () => {
  if (!scenarioManuallyChosen) setScenario(window.innerWidth <= 1050 ? 'narrow' : 'desktop');
  if (!focused && !stage.classList.contains('narrow')) paint(pct);
  positionChip();
});

paint(PRESETS.balanced.pct, { mode: 'balanced' });
setScenario(window.innerWidth <= 1050 ? 'narrow' : 'desktop');
