import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RecentWorkspaceDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useDraftStore } from '../store/draftStore.js';
import { useQuickConsoleStore } from '../store/quickConsoleStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import {
  compactTerminalPath,
  mountTerminal,
  observeTerminalFit,
  terminalShareText,
  useTerminalStore,
  type TermInstance,
  type TerminalWorkingContext,
} from './TerminalPanel.js';
import { Ic } from './home-icons.js';
import '../styles/quick-console.css';

interface ContextChoice {
  key: string;
  request: TerminalWorkingContext;
  title: string;
  cwd: string;
  meta: string;
  worktree: boolean;
}

interface OutputMenuState {
  x: number;
  y: number;
  text: string;
}

function contextKey(item: TermInstance): string {
  if (item.contextKind === 'task') return `task:${item.contextTaskId ?? ''}`;
  if (item.contextKind === 'recent') return `recent:${item.projectPath ?? ''}`;
  return item.contextKind;
}

function contextTitle(item: TermInstance): string {
  if (item.contextKind === 'focused') return `聚焦项目 · ${item.projectName}`;
  if (item.contextKind === 'recent') return `最近项目 · ${item.projectName}`;
  if (item.contextKind === 'task') return `✳ ${item.contextLabel}`;
  return 'Scratch 目录';
}

function lineCount(text: string): number {
  return Math.max(1, text.split('\n').length);
}

function saveTextAttachment(text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `quick-console-output-${new Date().toISOString().replaceAll(':', '-')}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function QuickConsole(): React.JSX.Element {
  const open = useQuickConsoleStore((state) => state.open);
  const terminalId = useQuickConsoleStore((state) => state.terminalId);
  const workspace = useWorkspaceStore((state) => state.workspace);
  const tasks = useTaskStore((state) => state.tasks);
  const taskRoomTaskId = useAppStore((state) => state.taskRoomTaskId);
  const item = useTerminalStore((state) =>
    terminalId ? (state.items.find((entry) => entry.id === terminalId) ?? null) : null,
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [recent, setRecent] = useState<RecentWorkspaceDto[]>([]);
  const [outputMenu, setOutputMenu] = useState<OutputMenuState | null>(null);
  const [changingContext, setChangingContext] = useState(false);

  const contexts = useMemo<ContextChoice[]>(() => {
    const choices: ContextChoice[] = [];
    if (workspace) {
      choices.push({
        key: 'focused',
        request: { kind: 'focused' },
        title: `聚焦项目 · ${workspace.displayName}`,
        cwd: workspace.path,
        meta: '当前 Editor 项目',
        worktree: false,
      });
    }
    for (const project of recent
      .filter((entry) => entry.exists && entry.path !== workspace?.path)
      .slice(0, 3)) {
      choices.push({
        key: `recent:${project.path}`,
        request: { kind: 'recent', projectPath: project.path },
        title: `最近项目 · ${project.displayName}`,
        cwd: project.path,
        meta: '独立于 Editor 聚焦',
        worktree: false,
      });
    }
    for (const task of tasks
      .filter((entry) => entry.worktree && !entry.worktree.missing)
      .slice(0, 4)) {
      choices.push({
        key: `task:${task.id}`,
        request: { kind: 'task', taskId: task.id },
        title: `✳ ${task.title} 的 worktree`,
        cwd: task.worktree!.path,
        meta: 'WORKTREE · 隔离',
        worktree: true,
      });
    }
    choices.push({
      key: 'scratch',
      request: { kind: 'scratch' },
      title: 'Scratch 目录',
      cwd: 'Charter data/scratch/terminal-*',
      meta: '临时目录 · 不计入项目',
      worktree: false,
    });
    return choices;
  }, [recent, tasks, workspace]);

  // The shortcut is captured before Monaco/xterm/input handlers so the same
  // in-app gesture works from every surface without becoming a system hotkey.
  useEffect(() => {
    const toggle = (event: KeyboardEvent): void => {
      if (!event.altKey || event.code !== 'Space') return;
      event.preventDefault();
      event.stopPropagation();
      useQuickConsoleStore.getState().toggle();
    };
    window.addEventListener('keydown', toggle, true);
    return () => window.removeEventListener('keydown', toggle, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOutputMenu(null);
    void Promise.all([
      rpcResult('workspace.recent', {}).then((result) => {
        if (result.ok) setRecent(result.data.items);
      }),
      useTaskStore.getState().refreshTasks(),
    ]);

    const current = useTerminalStore
      .getState()
      .items.find((entry) => entry.id === useQuickConsoleStore.getState().terminalId);
    if (current) return;
    const context: TerminalWorkingContext = workspace ? { kind: 'focused' } : { kind: 'scratch' };
    void useTerminalStore
      .getState()
      .create({ context, quick: true, reveal: false, title: '⌥ quick' })
      .then((id) => {
        if (id) useQuickConsoleStore.getState().setTerminalId(id);
      });
  }, [open, workspace]);

  useEffect(() => {
    const host = hostRef.current;
    if (!open || !host || !item) return;
    mountTerminal(host, item, 'quick');
    return observeTerminalFit(host, item);
  }, [item, open]);

  useEffect(() => {
    if (open) return;
    setContextOpen(false);
    setOutputMenu(null);
    const active = document.activeElement;
    if (active && panelRef.current?.contains(active)) previousFocusRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (contextOpen || outputMenu) {
        event.preventDefault();
        event.stopPropagation();
        setContextOpen(false);
        setOutputMenu(null);
        item?.term.focus();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      useQuickConsoleStore.getState().setOpen(false);
    };
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (panelRef.current?.contains(event.target as Node)) return;
      useQuickConsoleStore.getState().setOpen(false);
    };
    const closeOnWindowBlur = (): void => useQuickConsoleStore.getState().setOpen(false);
    window.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    window.addEventListener('blur', closeOnWindowBlur);
    return () => {
      window.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      window.removeEventListener('blur', closeOnWindowBlur);
    };
  }, [contextOpen, item, open, outputMenu]);

  const chooseContext = async (choice: ContextChoice): Promise<void> => {
    if (!item || changingContext || choice.key === contextKey(item)) return;
    setChangingContext(true);
    try {
      const changed = await useTerminalStore.getState().setContext(item.id, choice.request);
      if (changed) {
        setContextOpen(false);
        useAppStore.getState().pushToast('success', `速召台已切到 ${choice.title}`);
        setTimeout(() => item.term.focus(), 0);
      }
    } finally {
      setChangingContext(false);
    }
  };

  const openOutputMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!item) return;
    event.preventDefault();
    const text = terminalShareText(item);
    if (!text) {
      useAppStore.getState().pushToast('info', '终端里还没有可发送的输出。');
      return;
    }
    const panel = panelRef.current?.getBoundingClientRect();
    if (!panel) return;
    setContextOpen(false);
    setOutputMenu({
      x: Math.min(event.clientX - panel.left, panel.width - 220),
      y: Math.min(event.clientY - panel.top, panel.height - 154),
      text,
    });
  };

  const sendToRoom = (): void => {
    if (!item || !outputMenu || !taskRoomTaskId) return;
    const count = lineCount(outputMenu.text);
    useDraftStore.getState().addTerminalRef(taskRoomTaskId, {
      id: `terminal-ref-${Date.now()}`,
      title: `速召台输出 · ${count} 行`,
      text: outputMenu.text,
      cwd: item.cwd,
      contextLabel: contextTitle(item),
      lineCount: count,
    });
    setOutputMenu(null);
    useQuickConsoleStore.getState().setOpen(false);
    useAppStore.getState().pushToast('success', `已把 ${count} 行终端输出放进当前 Room 回复。`);
    useAppStore.getState().focusComposer();
  };

  const rerun = (): void => {
    if (!item?.lastCommand) {
      useAppStore.getState().pushToast('info', '当前会话还没有可重跑的命令。');
      return;
    }
    void rpcResult('terminal.write', { id: item.id, data: `${item.lastCommand}\r` });
    setOutputMenu(null);
    item.term.focus();
  };

  const activeContext = item ? contextKey(item) : '';

  return (
    <div className={`quick-console-layer ${open ? 'open' : ''}`} aria-hidden={!open}>
      <section
        ref={panelRef}
        className="quick-console"
        data-testid="quick-console"
        aria-label="速召台"
      >
        <header className="quick-console-head">
          <span className="quick-console-key">⌥Space</span>
          <strong>速召台</strong>
          <button
            className={`quick-console-context ${item?.contextKind === 'task' ? 'worktree' : ''}`}
            data-testid="quick-console-context"
            aria-expanded={contextOpen}
            disabled={!item}
            onClick={() => {
              setOutputMenu(null);
              setContextOpen((value) => !value);
            }}
          >
            <span>{item ? contextTitle(item) : '正在准备会话…'}</span>
            {item?.contextKind === 'task' ? (
              <span className="quick-console-worktree">WORKTREE · 隔离</span>
            ) : null}
            <span className="quick-console-cwd" title={item?.cwd}>
              {item ? compactTerminalPath(item.cwd) : ''}
            </span>
            <Ic name="chevron" size={12} />
          </button>
          <span className="quick-console-hint">Esc 收回 · 失焦自动收 ✓ · 会话保持</span>
        </header>

        {contextOpen ? (
          <div className="quick-console-context-menu" data-testid="quick-console-context-menu">
            <div className="quick-console-menu-caption">
              工作上下文 · cwd 由主进程解析，不信任渲染器路径
            </div>
            {contexts.map((choice) => (
              <button
                key={choice.key}
                className={choice.key === activeContext ? 'selected' : ''}
                disabled={changingContext}
                data-testid={`quick-console-context-${choice.request.kind}`}
                onClick={() => void chooseContext(choice)}
              >
                <span className="quick-console-menu-icon">
                  {choice.key === activeContext ? <Ic name="check" size={12} /> : null}
                </span>
                <span className="quick-console-menu-copy">
                  <strong>{choice.title}</strong>
                  <small>{compactTerminalPath(choice.cwd)}</small>
                </span>
                <span className={choice.worktree ? 'worktree' : ''}>{choice.meta}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div
          ref={hostRef}
          className="quick-console-terminal"
          data-testid="quick-console-terminal"
          onContextMenu={openOutputMenu}
        >
          {!item ? (
            <div className="quick-console-loading">
              <span /> 正在连接持久 PTY…
            </div>
          ) : null}
        </div>

        {outputMenu ? (
          <div
            className="quick-console-output-menu"
            data-testid="quick-console-output-menu"
            style={{ left: outputMenu.x, top: outputMenu.y }}
          >
            <button
              onClick={() => {
                void navigator.clipboard.writeText(outputMenu.text);
                setOutputMenu(null);
                useAppStore.getState().pushToast('success', '终端输出已复制。');
              }}
            >
              <Ic name="clipboard" size={13} />
              复制输出
              <span>⌘C</span>
            </button>
            <button
              className="primary"
              data-testid="quick-console-send-room"
              disabled={!taskRoomTaskId}
              title={taskRoomTaskId ? '把输出引用放进当前 Room 的回复框' : '先进入一个 Task Room'}
              onClick={sendToRoom}
            >
              <Ic name="arrowUp" size={13} />
              发给当前 Room
            </button>
            <button
              onClick={() => {
                saveTextAttachment(outputMenu.text);
                setOutputMenu(null);
              }}
            >
              <Ic name="file" size={13} />
              存为附件
            </button>
            <button onClick={rerun} disabled={!item?.lastCommand}>
              <Ic name="refresh" size={13} />
              重跑上一条命令
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
