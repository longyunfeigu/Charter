const body = document.body;
const stage = document.getElementById('stage');
const readout = document.getElementById('study-readout');
const initialMarkup = new Map();

document.querySelectorAll('[data-reset-snapshot]').forEach((element) => {
  initialMarkup.set(element, element.innerHTML);
});

function setViewport(mode, { manual = true } = {}) {
  if (!stage) return;
  stage.classList.toggle('compact', mode === 'compact');
  if (mode !== 'compact') document.querySelector('.context-rail')?.classList.remove('drawer-open');
  document.querySelectorAll('[data-viewport]').forEach((button) => {
    button.classList.toggle('active', button.dataset.viewport === mode);
  });
  if (manual) body.dataset.viewportManual = 'true';
}

document.querySelectorAll('[data-viewport]').forEach((button) => {
  button.addEventListener('click', () => setViewport(button.dataset.viewport));
});

function syncViewport() {
  if (body.dataset.viewportManual === 'true') return;
  setViewport(window.innerWidth <= 900 ? 'compact' : 'desktop', { manual: false });
}

window.addEventListener('resize', syncViewport);
syncViewport();

function trapDialog(dialog, returnTarget) {
  const focusable = [...dialog.querySelectorAll('button, input, select, textarea, [tabindex="0"]')];
  const first = focusable[0];
  const last = focusable.at(-1);

  function onKeydown(event) {
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function close() {
    dialog.classList.remove('open');
    dialog.removeEventListener('keydown', onKeydown);
    returnTarget?.focus();
  }

  dialog.querySelectorAll('[data-dialog-close]').forEach((button) => {
    button.onclick = close;
  });
  dialog.addEventListener('keydown', onKeydown);
  requestAnimationFrame(() => first?.focus());
  return close;
}

function initializeContextCase() {
  const chips = document.getElementById('context-chips');
  const shelf = document.getElementById('context-shelf');
  const count = document.getElementById('context-count');
  const inspectorCount = document.getElementById('inspector-message-count');
  const messages = document.getElementById('messages');
  const input = document.getElementById('composer-input');
  const overlay = document.getElementById('drop-overlay');
  const dropzone = document.getElementById('composer-dropzone');
  const filesTab = document.getElementById('files-tab');
  const sessionsTab = document.getElementById('sessions-tab');
  const filesPanel = document.getElementById('files-panel');
  const sessionsPanel = document.getElementById('sessions-panel');
  const contextRail = document.querySelector('.context-rail');
  const attachments = new Map();
  let dragDepth = 0;

  function updateContext() {
    const size = attachments.size;
    shelf.classList.toggle('empty', size === 0);
    count.textContent = `${size} 项`;
    inspectorCount.textContent = size ? `${size} 项将在下一次请求中发送` : '尚未选择';
    readout.textContent = size ? `本条消息 · ${size} 项 · 可移除` : '本条消息 · 尚未附加上下文';
  }

  function addAttachment(path, kind = 'FILE') {
    if (attachments.has(path)) return;
    attachments.set(path, kind);
    const chip = document.createElement('span');
    chip.className = 'context-chip';
    chip.dataset.path = path;
    chip.innerHTML = `
      <span class="chip-kind ${kind === 'IMG' ? 'image' : ''}">${kind}</span>
      <span class="chip-copy"><strong>${path}</strong><small>本条消息</small></span>
      <button class="chip-remove" type="button" aria-label="移除 ${path}">×</button>
    `;
    chip.querySelector('button').addEventListener('click', () => {
      attachments.delete(path);
      chip.remove();
      updateContext();
    });
    chips.append(chip);
    updateContext();
  }

  function clearContext() {
    attachments.clear();
    chips.replaceChildren();
    updateContext();
  }

  function selectTab(name) {
    const filesSelected = name === 'files';
    filesTab.setAttribute('aria-selected', String(filesSelected));
    sessionsTab.setAttribute('aria-selected', String(!filesSelected));
    filesPanel.hidden = !filesSelected;
    sessionsPanel.hidden = filesSelected;
  }

  filesTab.addEventListener('click', () => selectTab('files'));
  sessionsTab.addEventListener('click', () => selectTab('sessions'));

  document.querySelectorAll('[data-attach]').forEach((control) => {
    function attach(event) {
      event.stopPropagation();
      addAttachment(control.dataset.attach, control.dataset.kind);
    }
    control.addEventListener('click', attach);
    control.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        attach(event);
      }
    });
  });

  document.getElementById('clear-context').addEventListener('click', clearContext);
  document.getElementById('attach-menu-button').addEventListener('click', () => {
    selectTab('files');
    if (stage.classList.contains('compact') || window.innerWidth <= 760) {
      contextRail.classList.add('drawer-open');
      document.getElementById('file-search').focus();
    } else {
      filesTab.focus();
    }
  });
  document.getElementById('rail-close').addEventListener('click', () => {
    contextRail.classList.remove('drawer-open');
    document.getElementById('attach-menu-button').focus();
  });
  document.getElementById('demo-context').addEventListener('click', () => {
    addAttachment('public/index.html', 'HTML');
    addAttachment('assets/coupon-expired@2x.png', 'IMG');
    input.value = '请对照设计稿检查过期状态，并先给出修改计划。';
    input.focus();
  });

  document.getElementById('send-context').addEventListener('click', () => {
    const text = input.value.trim();
    if (!text && !attachments.size) {
      input.focus();
      return;
    }
    const message = document.createElement('article');
    message.className = 'message user';
    const copy = document.createElement('div');
    copy.textContent = text || '请检查这些上下文。';
    message.append(copy);
    if (attachments.size) {
      const sent = document.createElement('div');
      sent.className = 'sent-context';
      attachments.forEach((kind, path) => {
        const item = document.createElement('span');
        item.textContent = `${kind} · ${path}`;
        sent.append(item);
      });
      message.append(sent);
    }
    messages.append(message);
    messages.scrollTop = messages.scrollHeight;
    input.value = '';
    clearContext();
    readout.textContent = '已发送 · 上下文随消息留档';
  });

  dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    overlay.classList.add('visible');
  });
  dropzone.addEventListener('dragover', (event) => event.preventDefault());
  dropzone.addEventListener('dragleave', () => {
    dragDepth -= 1;
    if (dragDepth <= 0) overlay.classList.remove('visible');
  });
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    overlay.classList.remove('visible');
    const file = event.dataTransfer?.files?.[0];
    addAttachment(file?.name || 'dropped-design.png', file?.type?.startsWith('image/') ? 'IMG' : 'FILE');
  });

  document.querySelector('[data-reset]').addEventListener('click', () => {
    clearContext();
    input.value = '';
    selectTab('files');
    body.dataset.viewportManual = '';
    contextRail.classList.remove('drawer-open');
    syncViewport();
  });
}

function initializeSftpCase() {
  const selections = [...document.querySelectorAll('.transfer-select')];
  const summary = document.getElementById('transfer-summary');
  const localSelection = document.getElementById('local-selection');
  const uploadButton = document.getElementById('upload-button');
  const dialog = document.getElementById('transfer-dialog');
  const dialogTitle = document.getElementById('transfer-dialog-title');
  let closeDialog;
  let progressTimer;

  function selectedFiles() {
    return selections.filter((input) => input.checked);
  }

  function updateSelection() {
    const selected = selectedFiles();
    const total = selected.reduce((sum, input) => sum + Number(input.dataset.size || 0), 0);
    const totalLabel = total >= 1 ? `${total.toFixed(1)} MB` : `${Math.round(total * 1024)} KB`;
    document.querySelectorAll('.transfer-select').forEach((input) => {
      input.closest('.file-row').classList.toggle('selected', input.checked);
    });
    summary.innerHTML = `${selected.length} 项<br>${totalLabel}`;
    localSelection.textContent = `已选择 ${selected.length} 项 · ${totalLabel}`;
    uploadButton.disabled = selected.length === 0;
    uploadButton.setAttribute(
      'aria-label',
      `上传所选 ${selected.length} 项到远程 releases 文件夹`,
    );
    readout.textContent = selected.length
      ? `已选 ${selected.length} 项 → /home/deploy/releases`
      : '选择本机文件后上传';
  }

  function openPreflight() {
    const count = selectedFiles().length;
    if (!count) return;
    dialogTitle.textContent = `确认上传 ${count} 项`;
    dialog.classList.add('open');
    closeDialog = trapDialog(dialog, uploadButton);
  }

  selections.forEach((input) => input.addEventListener('change', updateSelection));
  uploadButton.addEventListener('click', openPreflight);
  document.getElementById('demo-transfer').addEventListener('click', openPreflight);

  document.getElementById('confirm-upload').addEventListener('click', () => {
    const policy = document.querySelector('input[name="conflict"]:checked').value;
    closeDialog?.();
    const list = document.getElementById('queue-list');
    const item = document.createElement('article');
    item.className = 'queue-item';
    item.innerHTML = `
      <div class="queue-item-head">
        <strong>charter-1.0.0.dmg + ${Math.max(selectedFiles().length - 1, 0)} item</strong>
        <small class="new-transfer-percent">0%</small>
      </div>
      <div class="progress-track" aria-label="上传进度 0%">
        <span class="new-transfer-progress" style="--progress: 0%"></span>
      </div>
      <small>上传 · 冲突策略：${policy === 'keep' ? '保留两者' : policy === 'replace' ? '替换' : '跳过'}</small>
    `;
    list.prepend(item);
    document.getElementById('queue-badge').textContent = '2 进行中';
    const percentNode = item.querySelector('.new-transfer-percent');
    const progressNode = item.querySelector('.new-transfer-progress');
    const progressTrack = item.querySelector('.progress-track');
    let progress = 0;
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      progress = Math.min(progress + 20, 100);
      percentNode.textContent = `${progress}%`;
      progressNode.style.setProperty('--progress', `${progress}%`);
      progressTrack.setAttribute('aria-label', `上传进度 ${progress}%`);
      if (progress === 100) {
        clearInterval(progressTimer);
        percentNode.className = 'badge green';
        percentNode.textContent = '完成';
        document.getElementById('queue-badge').textContent = '1 进行中';
        readout.textContent = '上传完成 · 目标目录已刷新';
      }
    }, 350);
  });

  document.getElementById('retry-transfer').addEventListener('click', (event) => {
    event.currentTarget.textContent = '正在重试…';
    event.currentTarget.disabled = true;
    readout.textContent = '已从断点恢复 nginx.access.log';
  });

  document.querySelector('[data-reset]').addEventListener('click', () => {
    clearInterval(progressTimer);
    selections.forEach((input, index) => {
      input.checked = index < 2;
    });
    document.getElementById('retry-transfer').textContent = '从断点重试';
    document.getElementById('retry-transfer').disabled = false;
    dialog.classList.remove('open');
    body.dataset.viewportManual = '';
    syncViewport();
    updateSelection();
  });

  updateSelection();
}

function initializeProjectsCase() {
  const addButton = document.getElementById('add-project-button');
  const menu = document.getElementById('add-project-menu');
  const projectList = document.getElementById('project-list');
  const empty = document.getElementById('project-empty');
  const searchWrap = document.getElementById('project-search-wrap');
  const search = document.getElementById('project-search');
  const count = document.getElementById('project-count');
  const populatedMain = document.getElementById('project-populated-main');
  const emptyMain = document.getElementById('project-empty-main');
  const dialog = document.getElementById('project-dialog');
  const title = document.getElementById('project-dialog-title');
  const repository = document.getElementById('repository-url');
  const location = document.getElementById('project-location');
  const note = document.getElementById('project-dialog-note');
  const submit = document.getElementById('create-project');
  let currentState = 'populated';
  let closeDialog;

  function closeMenu({ restore = false } = {}) {
    menu.classList.remove('open');
    addButton.setAttribute('aria-expanded', 'false');
    if (restore) addButton.focus();
  }

  function openMenu() {
    menu.classList.add('open');
    addButton.setAttribute('aria-expanded', 'true');
    menu.querySelector('.add-option')?.focus();
  }

  function setState(state) {
    currentState = state;
    const isEmpty = state === 'empty';
    projectList.hidden = isEmpty;
    empty.classList.toggle('visible', isEmpty);
    searchWrap.hidden = isEmpty;
    populatedMain.hidden = isEmpty;
    emptyMain.hidden = !isEmpty;
    count.textContent = isEmpty ? '0' : '3';
    document.querySelectorAll('[data-project-state]').forEach((button) => {
      button.classList.toggle('active', button.dataset.projectState === state);
    });
    readout.textContent = isEmpty
      ? '空态 · 直接呈现三个用户任务'
      : '已有项目 · Header 明确入口';
    closeMenu();
  }

  function openFlow(flow, returnTarget) {
    closeMenu();
    const config = {
      folder: {
        title: '打开现有文件夹',
        url: '',
        location: '~/git/storefront',
        note: '选择后会把该文件夹加入 Projects，不会移动原文件。',
        action: '选择并打开',
      },
      clone: {
        title: 'Clone Git repository',
        url: 'https://github.com/acme/storefront.git',
        location: '~/git/storefront',
        note: '将创建 storefront 并在完成后打开。',
        action: 'Clone and open',
      },
      blank: {
        title: '创建空白项目',
        url: '',
        location: '~/git/new-project',
        note: '将创建一个空文件夹和项目记录。',
        action: 'Create project',
      },
    }[flow];
    title.textContent = config.title;
    repository.closest('.field').hidden = flow !== 'clone';
    repository.value = config.url;
    location.value = config.location;
    note.textContent = config.note;
    submit.textContent = config.action;
    dialog.dataset.flow = flow;
    dialog.classList.add('open');
    closeDialog = trapDialog(dialog, returnTarget || addButton);
  }

  addButton.addEventListener('click', () => {
    if (menu.classList.contains('open')) closeMenu();
    else openMenu();
  });

  addButton.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openMenu();
    }
  });

  menu.addEventListener('keydown', (event) => {
    const options = [...menu.querySelectorAll('.add-option')];
    const index = options.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu({ restore: true });
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      options[(index + 1) % options.length].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      options[(index - 1 + options.length) % options.length].focus();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (!menu.contains(event.target) && event.target !== addButton) closeMenu();
  });

  document.querySelectorAll('.project-flow').forEach((button) => {
    button.addEventListener('click', () => openFlow(button.dataset.flow, button));
  });

  document.querySelectorAll('[data-project-state]').forEach((button) => {
    button.addEventListener('click', () => setState(button.dataset.projectState));
  });

  document.getElementById('demo-project').addEventListener('click', () => {
    if (currentState === 'empty') openFlow('folder', document.getElementById('demo-project'));
    else openMenu();
  });

  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    document.querySelectorAll('.project-row').forEach((row) => {
      row.hidden = !row.dataset.projectName.includes(query);
    });
  });

  submit.addEventListener('click', () => {
    submit.disabled = true;
    submit.textContent = dialog.dataset.flow === 'clone' ? 'Cloning…' : 'Opening…';
    setTimeout(() => {
      closeDialog?.();
      submit.disabled = false;
      setState('populated');
      readout.textContent = '项目已加入 · 原文件位置保持不变';
    }, 700);
  });

  document.querySelector('[data-reset]').addEventListener('click', () => {
    dialog.classList.remove('open');
    closeMenu();
    search.value = '';
    document.querySelectorAll('.project-row').forEach((row) => {
      row.hidden = false;
    });
    setState('populated');
  });

  setState('populated');
}

if (body.dataset.case === 'context') initializeContextCase();
if (body.dataset.case === 'sftp') initializeSftpCase();
if (body.dataset.case === 'projects') initializeProjectsCase();
