/* Work capture directions — shared shell, icons, popovers, demo helpers.
 * Simulated data only. "AI parsing" in these mocks is front-end timers, not a model call. */
window.CM = (() => {
  const ICONS = {
    plus: 'M12 5v14M5 12h14',
    x: 'M18 6 6 18M6 6l12 12',
    search: 'M21 21l-4.35-4.35M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0z',
    layout: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5zM3 10h18M10 21V10',
    calendar: 'M16 3v4M8 3v4M4 7h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
    flag: 'M5 21V4M5 4h11l-2.2 4L16 12H5',
    tag: 'M12.6 3H5a2 2 0 0 0-2 2v7.6a2 2 0 0 0 .6 1.4l7.4 7.4a2 2 0 0 0 2.8 0l7.6-7.6a2 2 0 0 0 0-2.8L14 3.6A2 2 0 0 0 12.6 3zM8 8h.01',
    user: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21c0-3.9 3.6-6 8-6s8 2.1 8 6',
    link: 'M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L11.8 5.8M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4',
    sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2',
    check: 'M20 6 9 17l-5-5',
    chev: 'M6 9l6 6 6-6',
    dots: 'M5 12h.01M12 12h.01M19 12h.01',
    arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    bell: 'M6 9a6 6 0 0 1 12 0c0 5.4 2 6.6 2 6.6H4S6 14.4 6 9zM10 20a2.2 2.2 0 0 0 4 0',
    hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
    message: 'M21 14a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8z',
    zap: 'M13 2 3 14h8l-1 8 11-14h-8l0-6z',
    inbox: 'M22 13h-5.5l-2 3h-5l-2-3H2M4.7 5.6 2 13v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5l-2.7-7.4A2 2 0 0 0 17.4 4H6.6a2 2 0 0 0-1.9 1.6z',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    file: 'M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z',
    pen: 'M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z',
    circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  };
  function ic(name, size = 13) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name] || ''}"/></svg>`;
  }

  const COLUMNS = [
    { id: 'inbox', name: 'Inbox', color: '#64748b', icon: 'inbox' },
    { id: 'active', name: 'In progress', color: '#7c5cff', icon: 'zap' },
    { id: 'waiting', name: 'Waiting', color: '#d97706', icon: 'clock' },
    { id: 'review', name: 'Review', color: '#0891b2', icon: 'eye' },
    { id: 'done', name: 'Done', color: '#2f9e63', icon: 'check' },
  ];
  const TYPES = [
    { name: 'General', color: '#64748b' },
    { name: 'Product', color: '#7c5cff' },
    { name: 'Research', color: '#0891b2' },
    { name: 'Engineering', color: '#2f9e63' },
    { name: 'Content', color: '#b06f10' },
    { name: 'Approval', color: '#c4453d' },
  ];
  const PRIORITIES = [
    { id: 'none', label: 'No priority', color: 'var(--fg-faint)' },
    { id: 'low', label: 'Low', color: 'var(--info)' },
    { id: 'medium', label: 'Medium', color: 'var(--warning)' },
    { id: 'high', label: 'High', color: '#d9634a' },
    { id: 'urgent', label: 'Urgent', color: 'var(--danger)' },
  ];
  const DUE_QUICK = ['Today · 18:00', 'Tomorrow · 09:00', 'Fri Aug 14', 'Aug 20 · 09:00'];

  let refCounter = 42;
  const nextRef = () => `WRK-${refCounter++}`;

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function typeColor(name) {
    return (TYPES.find((t) => t.name === name) || TYPES[0]).color;
  }
  function priorityDef(id) {
    return PRIORITIES.find((p) => p.id === id) || PRIORITIES[0];
  }

  /* ── Card ──────────────────────────────────────────────────────────── */
  function cardEl(d) {
    const c = el(`<article class="work-card ${d.cls || ''}" tabindex="0"></article>`);
    c.appendChild(
      el(`<div class="work-card-top"><span class="work-card-reference">${d.ref || nextRef()}${
        d.ai ? ' <span class="ai-mark">✦</span>' : ''
      }</span></div>`),
    );
    c.appendChild(el(`<h3>${d.title}</h3>`));
    if (d.progress != null)
      c.appendChild(el(`<div class="work-card-progress"><span style="width:${d.progress}%"></span></div>`));
    const meta = el('<div class="work-card-meta"></div>');
    if (d.type)
      meta.appendChild(
        el(`<span class="work-type-pill" style="--work-type-color:${typeColor(d.type)}"><i></i>${d.type}</span>`),
      );
    if (d.priority && d.priority !== 'none')
      meta.appendChild(el(`<span class="work-meta-pill priority-${d.priority}">${priorityDef(d.priority).label}</span>`));
    if (d.due)
      meta.appendChild(
        el(`<span class="work-meta-pill ${d.dueTone ? 'due-' + d.dueTone : ''}">${ic('calendar', 9)}${d.due}</span>`),
      );
    (d.labels || []).forEach((l) => meta.appendChild(el(`<span class="work-meta-pill">${ic('tag', 8)}${l}</span>`)));
    if (d.source) meta.appendChild(el(`<span class="work-meta-pill">${ic('user', 8)}${d.source}</span>`));
    if (d.stat)
      meta.appendChild(
        el(`<span class="work-meta-stat ${d.statDone ? 'complete' : ''}">${ic('check', 9)}${d.stat}</span>`),
      );
    if (meta.children.length) c.appendChild(meta);
    return c;
  }

  const SAMPLE = {
    inbox: [
      { ref: 'WRK-38', title: 'Pick the venue shortlist for the September offsite', type: 'General', due: 'Aug 14', stat: '0/3' },
      { ref: 'WRK-41', title: 'Summarize the churned-account interviews', type: 'Research', priority: 'medium' },
    ],
    active: [
      { ref: 'WRK-33', title: 'Draft the launch announcement email', type: 'Content', priority: 'high', due: 'Aug 12', dueTone: 'soon', progress: 40 },
      { ref: 'WRK-29', title: 'Billing exports running on the new schema', type: 'Engineering', stat: '2/5' },
    ],
    waiting: [{ ref: 'WRK-27', title: 'Legal review of the DPA template', type: 'Approval', source: 'Legal' }],
    review: [{ ref: 'WRK-25', title: 'Q3 roadmap one-pager', type: 'Product', stat: '4/4', statDone: true }],
    done: [{ ref: 'WRK-21', title: 'Onboarding checklist refresh', type: 'General', stat: '2/2', statDone: true }],
  };

  /* ── Shell ─────────────────────────────────────────────────────────── */
  function mountShell(opts) {
    const nav = ['index', 'a', 'b', 'c', 'd']
      .map((k) => {
        const label = k === 'index' ? '总览' : k.toUpperCase();
        const href = k === 'index' ? 'index.html' : `${k}-${{ a: 'capture-ai', b: 'progressive-modal', c: 'inline-add', d: 'document-page' }[k]}.html`;
        return `<a href="${href}" class="${opts.current === k ? 'current' : ''}">${label}</a>`;
      })
      .join('');
    document.body.prepend(
      el(`<div class="mock-strip">
        <span class="ms-badge">MOCK</span>
        <span class="ms-title">${opts.title}</span>
        <span class="ms-note">${opts.note || '模拟数据 · AI 解析为前端定时器伪造'}</span>
        <nav>${nav}${opts.demo ? `<button class="ms-demo" id="msDemo">▶ 播放演示</button>` : ''}</nav>
      </div>`),
    );
    const shell = el(`<div class="shell">
      <div class="titlebar"><div class="traffic"><i></i><i></i><i></i></div><span>Charter — Work</span></div>
      <header class="work-header">
        <div class="work-header-nav">
          <h1>Work</h1>
          <span class="work-view-tab">${ic('layout', 13)} Board</span>
          <div class="work-summary"><div><strong>2</strong> <span>In progress</span></div><div><strong>1</strong> <span>Waiting</span></div><div><strong>1</strong> <span>Needs attention</span></div></div>
        </div>
        <div class="work-header-actions">
          <button class="btn">${ic('dots', 13)}</button>
          <button class="btn primary" id="btnNew">${ic('plus', 13)} <span>New work item</span></button>
        </div>
      </header>
      <div class="work-toolbar">
        <div class="work-search">${ic('search', 12)}<input placeholder="Search work items"></div>
        <select><option>All types</option></select>
        <select><option>All labels</option></select>
        <span class="work-save-state">Saved locally · just now</span>
      </div>
      <div class="work-board" id="board"></div>
    </div>`);
    document.body.appendChild(shell);
    const board = shell.querySelector('#board');
    const columns = {};
    COLUMNS.forEach((col) => {
      const colEl = el(`<section class="work-column" data-col="${col.id}">
        <header>
          <span class="work-column-icon" style="color:${col.color}">${ic(col.icon, 13)}</span>
          <h2>${col.name}</h2><span class="work-column-count">${(SAMPLE[col.id] || []).length}</span>
          <button class="work-column-add" data-add="${col.id}" title="Add to ${col.name}">${ic('plus', 13)}</button>
        </header>
        <div class="work-column-cards"></div>
      </section>`);
      const cards = colEl.querySelector('.work-column-cards');
      (SAMPLE[col.id] || []).forEach((d) => cards.appendChild(cardEl(d)));
      board.appendChild(colEl);
      columns[col.id] = cards;
    });
    const bump = (id, delta) => {
      const n = board.querySelector(`[data-col="${id}"] .work-column-count`);
      n.textContent = String(Number(n.textContent) + delta);
    };
    return { shell, board, columns, bump, newBtn: shell.querySelector('#btnNew'), demoBtn: document.getElementById('msDemo') };
  }

  /* ── Popover manager ───────────────────────────────────────────────── */
  let activePop = null;
  function closePop() {
    if (activePop) {
      activePop.remove();
      activePop = null;
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onDocKey, true);
    }
  }
  function onDocDown(e) {
    if (activePop && !activePop.contains(e.target)) closePop();
  }
  function onDocKey(e) {
    if (e.key === 'Escape') {
      closePop();
      e.stopPropagation();
    }
  }
  function popover(anchor, build) {
    closePop();
    const pop = el('<div class="pop"></div>');
    build(pop);
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    activePop = pop;
    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onDocKey, true);
    }, 0);
    return pop;
  }

  /* Shared field popovers */
  function popPriority(anchor, current, onPick) {
    return popover(anchor, (pop) => {
      pop.appendChild(el('<div class="pop-head">PRIORITY</div>'));
      PRIORITIES.forEach((p, i) => {
        const b = el(`<button type="button" class="pop-item ${p.id === current ? 'selected' : ''}">
          <span style="color:${p.color}">${ic('flag', 12)}</span>${p.label}<span class="pk">${i}</span></button>`);
        b.onclick = () => {
          closePop();
          onPick(p.id);
        };
        pop.appendChild(b);
      });
    });
  }
  function popType(anchor, current, onPick) {
    return popover(anchor, (pop) => {
      pop.appendChild(el('<div class="pop-head">WORK TYPE</div>'));
      TYPES.forEach((t) => {
        const b = el(`<button type="button" class="pop-item ${t.name === current ? 'selected' : ''}">
          <span class="dot" style="background:${t.color}"></span>${t.name}</button>`);
        b.onclick = () => {
          closePop();
          onPick(t.name);
        };
        pop.appendChild(b);
      });
    });
  }
  function popDue(anchor, onPick, head = 'DUE') {
    return popover(anchor, (pop) => {
      pop.appendChild(el(`<div class="pop-head">${head}</div>`));
      DUE_QUICK.forEach((d) => {
        const b = el(`<button type="button" class="pop-item">${ic('calendar', 12)}${d}</button>`);
        b.onclick = () => {
          closePop();
          onPick(d);
        };
        pop.appendChild(b);
      });
      pop.appendChild(el('<div class="pop-sep"></div>'));
      const input = el('<input class="pop-input" placeholder="Type a date — “next tue 3pm”, “sep 1”…">');
      input.onkeydown = (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          const v = input.value.trim();
          closePop();
          onPick(v);
        }
      };
      pop.appendChild(input);
      setTimeout(() => input.focus(), 30);
    });
  }
  function popLabels(anchor, labels, onChange) {
    return popover(anchor, (pop) => {
      pop.appendChild(el('<div class="pop-head">LABELS</div>'));
      const tokens = el('<div class="pop-tokens"></div>');
      const render = () => {
        tokens.innerHTML = '';
        labels.forEach((l, i) => {
          const t = el(`<button type="button" class="pop-token">${l}${ic('x', 9)}</button>`);
          t.onclick = () => {
            labels.splice(i, 1);
            render();
            onChange([...labels]);
          };
          tokens.appendChild(t);
        });
      };
      render();
      pop.appendChild(tokens);
      const input = el('<input class="pop-input" placeholder="Add a label and press ↩">');
      input.onkeydown = (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          labels.push(input.value.trim());
          input.value = '';
          render();
          onChange([...labels]);
        }
      };
      pop.appendChild(input);
      const sug = el('<div class="pop-suggest"></div>');
      ['launch', 'q3', 'customer'].forEach((s) => {
        const b = el(`<button type="button">${s}</button>`);
        b.onclick = () => {
          if (!labels.includes(s)) {
            labels.push(s);
            render();
            onChange([...labels]);
          }
        };
        sug.appendChild(b);
      });
      pop.appendChild(sug);
      setTimeout(() => input.focus(), 30);
    });
  }
  function popSource(anchor, src, onChange) {
    return popover(anchor, (pop) => {
      pop.style.minWidth = '250px';
      pop.appendChild(el('<div class="pop-head">SOURCE — WHO ASKED, WHERE</div>'));
      const form = el(`<div class="pop-form">
        <label>Person<input data-k="person" placeholder="e.g. Maya Chen"></label>
        <label>Channel<input data-k="channel" placeholder="e.g. Customer call / Slack #launch"></label>
        <label>Link<input data-k="url" placeholder="https://…"></label>
      </div>`);
      form.querySelectorAll('input').forEach((i) => {
        i.value = src[i.dataset.k] || '';
        i.oninput = () => {
          src[i.dataset.k] = i.value;
          onChange({ ...src });
        };
        i.onkeydown = (e) => {
          if (e.key === 'Enter') closePop();
        };
      });
      pop.appendChild(form);
      setTimeout(() => form.querySelector('input').focus(), 30);
    });
  }

  /* ── Typing / demo helpers ─────────────────────────────────────────── */
  async function typeInto(input, text, cps = 45) {
    input.focus();
    for (const ch of text) {
      input.value += ch;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(1000 / cps + Math.random() * 14);
    }
  }
  async function pasteInto(input, text) {
    input.focus();
    const chunk = 14;
    for (let i = 0; i < text.length; i += chunk) {
      input.value += text.slice(i, i + chunk);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(12);
    }
  }
  async function typeCE(node, text, cps = 40) {
    node.focus();
    for (const ch of text) {
      node.textContent += ch;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(1000 / cps + Math.random() * 12);
    }
  }

  let capEl = null;
  function caption(html) {
    if (!capEl) {
      capEl = el('<div class="demo-caption"></div>');
      document.body.appendChild(capEl);
    }
    capEl.innerHTML = html;
    capEl.style.opacity = '1';
  }
  function captionHide() {
    if (capEl) capEl.style.opacity = '0';
  }
  function toast(msg, ms = 3400) {
    const t = el(`<div class="toast">${ic('check', 13)}${msg}</div>`);
    document.body.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 400);
    }, ms);
  }
  function flash(node) {
    node.classList.add('pulse');
    setTimeout(() => node.classList.remove('pulse'), 1200);
  }
  function bindDemo(btn, fn) {
    if (!btn) return;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await fn();
      } finally {
        btn.disabled = false;
        captionHide();
      }
    };
  }

  return {
    ic, el, sleep, cardEl, mountShell, nextRef, typeColor, priorityDef,
    PRIORITIES, TYPES, COLUMNS, DUE_QUICK,
    popover, closePop, popPriority, popType, popDue, popLabels, popSource,
    typeInto, pasteInto, typeCE, caption, captionHide, toast, flash, bindDemo,
  };
})();
