import React, { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { RecentWorkspaceDto } from '@pi-ide/ipc-contracts';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { onEvent, rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useExternalStore } from '../store/externalStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { Ic } from './home-icons.js';
import { useQuickConsoleStore } from '../store/quickConsoleStore.js';

export type TerminalLaunch = 'shell' | 'claude' | 'codex';
export type TerminalWorkingContext =
  | { kind: 'focused' }
  | { kind: 'recent'; projectPath: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'scratch' };

export interface TermInstance {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  exited: boolean;
  cwd: string;
  projectName: string;
  projectPath: string | null;
  contextKind: 'focused' | 'recent' | 'task' | 'scratch';
  contextLabel: string;
  contextTaskId: string | null;
  launch: TerminalLaunch;
  quick: boolean;
  currentInput: string;
  lastCommand: string;
  hidden: boolean;
}

interface CreateTerminalRequest {
  taskId?: string;
  title?: string;
  context?: TerminalWorkingContext;
  launch?: TerminalLaunch;
  quick?: boolean;
  reveal?: boolean;
}

interface TerminalStore {
  items: TermInstance[];
  active: string | null;
  pendingKill: string | null;
  initialized: boolean;
  undoCloseId: string | null;
  init(): void;
  create(options?: CreateTerminalRequest): Promise<string | null>;
  setContext(id: string, context: TerminalWorkingContext): Promise<boolean>;
  setActive(id: string): void;
  requestKill(id: string): Promise<void>;
  finalizeHidden(id: string): Promise<void>;
  undoClose(): void;
  confirmKill(id: string, confirmed: boolean): Promise<void>;
  rename(id: string, title: string): void;
  clearActive(): void;
}

export interface TerminalAppearance {
  fontFamily: string;
  theme: ITheme;
}

const QUICK_CLOSE_GRACE_MS = 5000;
const quickCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function terminalAppearance(): TerminalAppearance {
  const skin = document.documentElement.dataset.skin ?? 'studio';
  const dark = document.documentElement.dataset.theme === 'dark';
  if (skin === 'studio') {
    return {
      fontFamily: "Menlo, Monaco, 'SF Mono', monospace",
      theme: dark
        ? { background: '#181818', foreground: '#cccccc' }
        : { background: '#ffffff', foreground: '#333333', cursor: '#333333' },
    };
  }
  if (skin === 'terminal') {
    return {
      fontFamily: "'Berkeley Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
      theme: dark
        ? {
            background: '#0d120f',
            foreground: '#b9f6c8',
            cursor: '#52ff78',
            cursorAccent: '#071009',
            selectionBackground: '#245b32',
            black: '#071009',
            red: '#ff6677',
            green: '#52ff78',
            yellow: '#e7c75f',
            blue: '#5c9cff',
            magenta: '#c793ff',
            cyan: '#5ce1d4',
            white: '#dfffe7',
            brightBlack: '#52705a',
            brightRed: '#ff8b98',
            brightGreen: '#8dffa6',
            brightYellow: '#ffe68f',
            brightBlue: '#8cbbff',
            brightMagenta: '#ddb9ff',
            brightCyan: '#91fff5',
            brightWhite: '#ffffff',
          }
        : {
            background: '#f0f6f1',
            foreground: '#102417',
            cursor: '#087c32',
            cursorAccent: '#f0f6f1',
            selectionBackground: '#b9dcc2',
            black: '#102417',
            red: '#a9343d',
            green: '#087c32',
            yellow: '#8a5b0a',
            blue: '#225cab',
            magenta: '#7642a0',
            cyan: '#126b67',
            white: '#e7efe8',
            brightBlack: '#5f7f67',
            brightRed: '#c74f59',
            brightGreen: '#199947',
            brightYellow: '#a97819',
            brightBlue: '#3e76c6',
            brightMagenta: '#925db8',
            brightCyan: '#29837e',
            brightWhite: '#ffffff',
          },
    };
  }
  if (skin === 'index') {
    return {
      fontFamily: "'IBM Plex Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
      theme: dark
        ? {
            background: '#070707',
            foreground: '#f5f5f2',
            cursor: '#ff304f',
            cursorAccent: '#070707',
            selectionBackground: '#5a1521',
            black: '#070707',
            red: '#ff405c',
            green: '#5ec986',
            yellow: '#e8b34c',
            blue: '#76a9ed',
            magenta: '#d47cff',
            cyan: '#5ed0d0',
            white: '#d8d8d4',
            brightBlack: '#6f6f6c',
            brightRed: '#ff7890',
            brightGreen: '#83e0a4',
            brightYellow: '#f4ce7a',
            brightBlue: '#9bc2f5',
            brightMagenta: '#e5a3ff',
            brightCyan: '#86e5e5',
            brightWhite: '#ffffff',
          }
        : {
            background: '#ffffff',
            foreground: '#0b0b0b',
            cursor: '#d20f2f',
            cursorAccent: '#ffffff',
            selectionBackground: '#f3cbd2',
            black: '#0b0b0b',
            red: '#d20f2f',
            green: '#176d3a',
            yellow: '#8b5b00',
            blue: '#1c4f8f',
            magenta: '#7a2d91',
            cyan: '#176c70',
            white: '#e5e5e2',
            brightBlack: '#777773',
            brightRed: '#ef3855',
            brightGreen: '#2e8b50',
            brightYellow: '#a67513',
            brightBlue: '#3d70ad',
            brightMagenta: '#9650a9',
            brightCyan: '#34868a',
            brightWhite: '#ffffff',
          },
    };
  }
  return {
    fontFamily: "'Courier Prime', 'American Typewriter', 'SFMono-Regular', Menlo, monospace",
    theme: dark
      ? {
          background: '#291f19',
          foreground: '#f0dfbd',
          cursor: '#ef7b57',
          cursorAccent: '#291f19',
          selectionBackground: '#664434',
          black: '#291f19',
          red: '#f17b67',
          green: '#8fb37d',
          yellow: '#e0ab65',
          blue: '#86aeb7',
          magenta: '#d697b5',
          cyan: '#8ac0b9',
          white: '#dfcfb1',
          brightBlack: '#927962',
          brightRed: '#ff9d89',
          brightGreen: '#b0d19e',
          brightYellow: '#f1c98c',
          brightBlue: '#aacbd1',
          brightMagenta: '#e8b8cd',
          brightCyan: '#addbd5',
          brightWhite: '#fff4dc',
        }
      : {
          background: '#fbf2df',
          foreground: '#392a21',
          cursor: '#b94e32',
          cursorAccent: '#fbf2df',
          selectionBackground: '#e8cbb2',
          black: '#392a21',
          red: '#a43129',
          green: '#4f754d',
          yellow: '#9a602d',
          blue: '#3f6674',
          magenta: '#8b506d',
          cyan: '#42756e',
          white: '#eadbc1',
          brightBlack: '#9b7965',
          brightRed: '#bd5138',
          brightGreen: '#668b62',
          brightYellow: '#b4773e',
          brightBlue: '#5a7d89',
          brightMagenta: '#a66a83',
          brightCyan: '#5e8e87',
          brightWhite: '#fffaf0',
        },
  };
}

/**
 * Mount an existing xterm into a host element. xterm 6's `open()` only
 * attaches on the FIRST call (re-open is a window-bookkeeping no-op), so every
 * re-mount — dock tab switch, side panel, room, surface round-trip — must move
 * the live element itself (ADR-0017 rev.2 substrate fix).
 */
export function mountTerminal(
  host: HTMLElement,
  item: Pick<TermInstance, 'term' | 'fit'>,
  appearance: 'normal' | 'quick' = 'normal',
): void {
  applyTerminalAppearance(item, appearance);
  const bottomPanelBody = host.closest<HTMLElement>('.bp-body');
  const el = item.term.element;
  if (!el) {
    host.replaceChildren();
    item.term.open(host);
  } else if (el.parentElement !== host) {
    host.replaceChildren(el);
  }
  try {
    item.fit.fit();
    item.term.refresh(0, item.term.rows - 1);
  } catch {
    // fit/refresh races during teardown are harmless
  }
  item.term.focus();
  // Reparenting and the right-rail layout update can settle in different
  // frames. Fit once more after layout so a terminal that came from the wider
  // side slot cannot keep drawing underneath the dock session list.
  requestAnimationFrame(() => {
    if (!host.isConnected || item.term.element?.parentElement !== host) return;
    try {
      item.fit.fit();
      item.term.refresh(0, item.term.rows - 1);
    } catch {
      // fit/refresh races during teardown are harmless
    }
  });
  // Chromium may scroll an overflow ancestor to reveal xterm's hidden input,
  // which used to lift the 34px context bar and New Terminal row out of view.
  // Keep the Bottom Panel chrome pinned while preserving keyboard focus.
  if (bottomPanelBody) {
    bottomPanelBody.scrollTop = 0;
    bottomPanelBody.scrollLeft = 0;
    requestAnimationFrame(() => {
      bottomPanelBody.scrollTop = 0;
      bottomPanelBody.scrollLeft = 0;
    });
  }
}

const QUICK_TERMINAL_APPEARANCE: TerminalAppearance = {
  fontFamily: "'SF Mono', Menlo, Monaco, Consolas, monospace",
  theme: {
    background: '#24231f',
    foreground: '#dcd7cd',
    cursor: '#dcd7cd',
    cursorAccent: '#24231f',
    selectionBackground: '#48566e',
    black: '#14130f',
    red: '#e08a80',
    green: '#7fce9e',
    yellow: '#e8b96b',
    blue: '#8fb0e8',
    magenta: '#c99ae8',
    cyan: '#78c6c2',
    white: '#dcd7cd',
    brightBlack: '#8f8a7f',
    brightRed: '#f2a69e',
    brightGreen: '#9adbb2',
    brightYellow: '#ffd28a',
    brightBlue: '#acc7f4',
    brightMagenta: '#ddb3f3',
    brightCyan: '#9addd9',
    brightWhite: '#f6f2e9',
  },
};

export function applyTerminalAppearance(
  item: Pick<TermInstance, 'term'>,
  mode: 'normal' | 'quick',
): void {
  const appearance = mode === 'quick' ? QUICK_TERMINAL_APPEARANCE : terminalAppearance();
  item.term.options.fontFamily = appearance.fontFamily;
  item.term.options.theme = appearance.theme;
}

/** Selection wins; otherwise capture the most recent visible non-empty output. */
export function terminalShareText(item: Pick<TermInstance, 'term'>): string {
  const selection = item.term.getSelection().trim();
  if (selection) return selection;
  const buffer = item.term.buffer.active;
  const end = Math.min(buffer.length, buffer.baseY + buffer.cursorY + 1);
  const start = Math.max(0, end - 24);
  const lines: string[] = [];
  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index)?.translateToString(true) ?? '';
    if (line.length > 0 || lines.length > 0) lines.push(line);
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n').trim().slice(-16_000);
}

/** Keep a mounted xterm fitted to its actual host, including flex/grid changes
 * caused by opening the side focus slot or compacting the terminal list. */
export function observeTerminalFit(
  host: HTMLElement,
  item: Pick<TermInstance, 'term' | 'fit'>,
): () => void {
  let frame = 0;
  const scheduleFit = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!host.isConnected || item.term.element?.parentElement !== host) return;
      try {
        item.fit.fit();
      } catch {
        // fit races during teardown are harmless
      }
    });
  };
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(host);
  scheduleFit();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}

function makeTerm(fontSize: number, scrollback: number): { term: Terminal; fit: FitAddon } {
  const appearance = terminalAppearance();
  const term = new Terminal({
    fontSize,
    fontFamily: appearance.fontFamily,
    scrollback,
    cursorBlink: true,
    allowProposedApi: true,
    theme: appearance.theme,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  return { term, fit };
}

export function compactTerminalPath(path: string): string {
  const unixHome = path.match(/^\/Users\/[^/]+|^\/home\/[^/]+/)?.[0];
  if (unixHome) return `~${path.slice(unixHome.length)}`;
  const windowsHome = path.match(/^[A-Za-z]:\\Users\\[^\\]+/)?.[0];
  if (windowsHome) return `~${path.slice(windowsHome.length)}`;
  return path;
}

function agentDisplayName(agent: string): string {
  if (agent === 'claude') return 'Claude Code';
  if (agent === 'codex') return 'Codex';
  return agent;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  items: [],
  active: null,
  pendingKill: null,
  initialized: false,
  undoCloseId: null,

  init() {
    if (get().initialized) return;
    set({ initialized: true });
    const appearanceObserver = new MutationObserver(() => {
      for (const item of get().items) {
        applyTerminalAppearance(item, item.quick ? 'quick' : 'normal');
        item.term.refresh(0, item.term.rows - 1);
      }
    });
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-skin'],
    });
    onEvent('terminal.data', ({ id, data }) => {
      get()
        .items.find((t) => t.id === id)
        ?.term.write(data);
    });
    onEvent('terminal.exit', ({ id, exitCode }) => {
      const item = get().items.find((t) => t.id === id);
      if (item) {
        item.exited = true;
        item.term.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
      }
    });
    // ADR-0017: closing summary line when an external agent session ends —
    // display-buffer only (never written to the PTY).
    onEvent('terminal.agentState', ({ id, agent, taskId }) => {
      if (agent !== null || !taskId) return;
      const item = get().items.find((t) => t.id === id);
      if (!item) return;
      const files = useExternalStore.getState().sessions[taskId]?.files.length ?? 0;
      item.term.write(
        `\r\n\x1b[90m✻ session ended — ${files} file${files === 1 ? '' : 's'} changed, tracked for review\x1b[0m\r\n`,
      );
    });
    // Focused-workspace changes leave global terminals intact. Their PTYs and
    // renderer xterm instances are owned by the context recorded on each row.
  },

  async create(options) {
    const settings = useAppStore.getState().settings;
    const launch = options?.launch ?? 'shell';
    const res = await rpcResult('terminal.create', {
      ...(options?.taskId ? { taskId: options.taskId } : {}),
      ...(options?.context ? { context: options.context } : {}),
      launch,
    });
    if (!res.ok) {
      useAppStore.getState().pushToast('error', res.error.userMessage);
      return null;
    }
    const { term, fit } = makeTerm(
      settings?.terminal.fontSize ?? 12,
      settings?.terminal.scrollback ?? 5000,
    );
    term.onData((data) => {
      void rpcResult('terminal.write', { id: res.data.id, data });
    });
    term.onResize(({ cols, rows }) => {
      void rpcResult('terminal.resize', { id: res.data.id, cols, rows });
    });
    const item: TermInstance = {
      id: res.data.id,
      title: options?.title ?? (options?.quick ? '⌥ quick' : res.data.title),
      term,
      fit,
      exited: false,
      cwd: res.data.cwd,
      projectName: res.data.projectName,
      projectPath: res.data.projectPath,
      contextKind: res.data.contextKind,
      contextLabel: res.data.contextLabel,
      contextTaskId: res.data.contextTaskId,
      launch: res.data.launch,
      quick: options?.quick ?? false,
      currentInput: '',
      lastCommand: '',
      hidden: false,
    };
    term.onData((data) => {
      if (data === '\r') {
        item.lastCommand = item.currentInput.trim();
        item.currentInput = '';
      } else if (data === '\u007f') {
        item.currentInput = item.currentInput.slice(0, -1);
      } else if (!data.startsWith('\u001b') && data >= ' ') {
        item.currentInput += data;
      }
    });
    set({ items: [...get().items, item], active: item.id });
    if (options?.reveal !== false) useAppStore.getState().showBottomTab('terminal');
    return item.id;
  },

  async setContext(id, context) {
    const res = await rpcResult('terminal.setContext', { id, context });
    if (!res.ok) {
      useAppStore.getState().pushToast('warning', res.error.userMessage);
      return false;
    }
    set({
      items: get().items.map((item) =>
        item.id === id
          ? {
              ...item,
              cwd: res.data.cwd,
              projectName: res.data.projectName,
              projectPath: res.data.projectPath,
              contextKind: res.data.contextKind,
              contextLabel: res.data.contextLabel,
              contextTaskId: res.data.contextTaskId,
            }
          : item,
      ),
    });
    return true;
  },

  setActive(id) {
    set({ active: id });
  },

  async requestKill(id) {
    const item = get().items.find((entry) => entry.id === id);
    if (item?.quick && !item.hidden) {
      const previous = get().undoCloseId;
      if (previous && previous !== id) {
        const previousTimer = quickCloseTimers.get(previous);
        if (previousTimer) clearTimeout(previousTimer);
        quickCloseTimers.delete(previous);
        void get().finalizeHidden(previous);
      }
      const items = get().items.map((entry) =>
        entry.id === id ? { ...entry, hidden: true } : entry,
      );
      const next = items.filter((entry) => !entry.hidden).at(-1);
      set({ items, active: next?.id ?? null, undoCloseId: id });
      useQuickConsoleStore.setState({ terminalId: null, open: false });
      quickCloseTimers.set(
        id,
        setTimeout(() => {
          quickCloseTimers.delete(id);
          void get().finalizeHidden(id);
        }, QUICK_CLOSE_GRACE_MS),
      );
      useAppStore.getState().pushToast('info', '「⌥ quick」已关闭并保活 5 秒 · 按 ⌘Z 原样恢复');
      return;
    }
    const res = await rpcResult('terminal.kill', { id, force: false });
    if (!res.ok) return;
    if (res.data.needsConfirm) {
      set({ pendingKill: id });
      return;
    }
    get()
      .items.find((t) => t.id === id)
      ?.term.dispose();
    const items = get().items.filter((t) => t.id !== id);
    set({ items, active: items.at(-1)?.id ?? null, pendingKill: null });
    if (useQuickConsoleStore.getState().terminalId === id) {
      useQuickConsoleStore.setState({ terminalId: null, open: false });
    }
    useExternalStore.getState().handleTerminalClosed(id);
  },

  async finalizeHidden(id) {
    const item = get().items.find((entry) => entry.id === id);
    if (!item?.hidden) return;
    const res = await rpcResult('terminal.kill', { id, force: false });
    if (!res.ok) return;
    const stillUndoable = get().undoCloseId === id;
    if (res.data.needsConfirm) {
      set({
        items: get().items.map((entry) => (entry.id === id ? { ...entry, hidden: false } : entry)),
        active: id,
        pendingKill: id,
        ...(stillUndoable ? { undoCloseId: null } : {}),
      });
      useAppStore.getState().showBottomTab('terminal');
      return;
    }
    item.term.dispose();
    useExternalStore.getState().handleTerminalClosed(id);
    set({
      items: get().items.filter((entry) => entry.id !== id),
      ...(stillUndoable ? { undoCloseId: null } : {}),
    });
  },

  undoClose() {
    const id = get().undoCloseId;
    if (!id) return;
    const timer = quickCloseTimers.get(id);
    if (timer) clearTimeout(timer);
    quickCloseTimers.delete(id);
    const item = get().items.find((entry) => entry.id === id && entry.hidden);
    if (!item) {
      set({ undoCloseId: null });
      return;
    }
    set({
      items: get().items.map((entry) => (entry.id === id ? { ...entry, hidden: false } : entry)),
      active: id,
      undoCloseId: null,
    });
    useQuickConsoleStore.getState().setTerminalId(id);
    useAppStore.getState().pushToast('success', '「⌥ quick」已恢复 · 会话与滚动缓冲保持不变');
  },

  async confirmKill(id, confirmed) {
    if (!confirmed) {
      set({ pendingKill: null });
      return;
    }
    await rpcResult('terminal.kill', { id, force: true });
    get()
      .items.find((t) => t.id === id)
      ?.term.dispose();
    const items = get().items.filter((t) => t.id !== id);
    set({ items, active: items.at(-1)?.id ?? null, pendingKill: null });
    if (useQuickConsoleStore.getState().terminalId === id) {
      useQuickConsoleStore.setState({ terminalId: null, open: false });
    }
    useExternalStore.getState().handleTerminalClosed(id);
  },

  rename(id, title) {
    set({ items: get().items.map((t) => (t.id === id ? { ...t, title } : t)) });
  },

  clearActive() {
    const active = get().items.find((t) => t.id === get().active);
    active?.term.clear();
  },
}));

/**
 * ADR-0017 rev.2 — the in-place session bar. All UI consequences of detection
 * land here (badge, snapshot chip, live file counter, actions); the terminal
 * itself never moves on detection. Ended sessions keep the bar (green state,
 * Review entry) until the terminal closes or a new session replaces it.
 */
export function SessionBar({ terminalId }: { terminalId: string }): React.JSX.Element | null {
  const item = useTerminalStore((s) => s.items.find((terminal) => terminal.id === terminalId));
  const taskId = useExternalStore((s) => s.taskByTerminal[terminalId]);
  const cli = useExternalStore((s) => s.agentByTerminal[terminalId] ?? null);
  const session = useExternalStore((s) => (taskId ? s.sessions[taskId] : undefined));
  const promoted = useExternalStore((s) => s.promoted);
  const task = useTaskStore((s) => (taskId ? s.tasks.find((entry) => entry.id === taskId) : null));
  if (!item) return null;
  const context = `${item.projectName} · ${compactTerminalPath(item.cwd)}`;
  if (!taskId) {
    return (
      <div className="term-session-bar shell" data-testid="terminal-context-bar">
        <Ic name="terminal" size={13} />
        <span className="tsb-shell-name">{item.title}</span>
        <span className="tsb-context" title={item.cwd}>
          {context}
        </span>
        <span className="tsb-sp" />
        <span className="tsb-pty-state">PTY {item.exited ? 'ended' : 'live'}</span>
      </div>
    );
  }
  const live = session ? session.status === 'active' : cli !== null;
  const files = session?.files.length ?? 0;
  const name = cli ?? session?.cli ?? 'agent';
  const slotTaken = promoted !== null && promoted.terminalId !== terminalId;
  const openRoom = (): void => useAppStore.getState().openTaskRoom(taskId);
  return (
    <div className={`term-session-bar ${live ? '' : 'ended'}`} data-testid="terminal-session-bar">
      <span className="tsb-dot" />
      <span className="tsb-cli">✳ {agentDisplayName(name)}</span>
      <span
        className="term-agent-ext"
        title="External agent session — unmanaged (outside the Tool Gateway); tracked & reviewable"
      >
        EXT · unmanaged
      </span>
      <span className="tsb-context" title={item.cwd}>
        {context}
      </span>
      {live ? (
        <span key={files} className="tsb-files" data-testid="session-bar-files">
          <b>{files}</b> file{files === 1 ? '' : 's'}
        </span>
      ) : (
        <span className="tsb-ended" data-testid="session-bar-ended">
          ✻ ended · {files} file{files === 1 ? '' : 's'}
        </span>
      )}
      <span className="tsb-sp" />
      {!live ? (
        <button
          className="tsb-btn"
          data-testid="session-bar-resume"
          disabled={!task?.external}
          title="Resume this CLI in the same recorded working context"
          onClick={() => task && void useExternalStore.getState().resumeTask(task)}
        >
          Resume
        </button>
      ) : null}
      {!live ? (
        <button
          className="tsb-btn review"
          data-testid="session-bar-review"
          title="Review this session's changes (accept or roll back byte-exactly)"
          onClick={openRoom}
        >
          Review
        </button>
      ) : null}
      <button
        className="tsb-btn"
        data-testid="session-bar-room"
        title="Open this session's Task Room — live changes, peek and review around this terminal"
        onClick={openRoom}
      >
        ⤢ Room
      </button>
      {live ? (
        <button
          className="tsb-btn primary"
          data-testid="session-bar-promote"
          title={
            slotTaken
              ? 'Atomically replace the terminal in the side focus slot'
              : 'Move this session terminal to the right side panel (return anytime)'
          }
          onClick={() => useExternalStore.getState().promote(terminalId)}
        >
          {slotTaken ? '⇄ Replace' : '⇥ Move side'}
        </button>
      ) : null}
    </div>
  );
}

interface TerminalContextChoice {
  key: string;
  request: TerminalWorkingContext;
  title: string;
  cwd: string;
  kindLabel: string;
  owner: string;
  accounting: string;
  projectPath: string | null;
}

function NewTerminalDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose(): void;
}): React.JSX.Element | null {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const tasks = useTaskStore((s) => s.tasks);
  const [recent, setRecent] = useState<RecentWorkspaceDto[]>([]);
  const [launch, setLaunch] = useState<TerminalLaunch>('shell');
  const [selectedKey, setSelectedKey] = useState('focused');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    void rpcResult('workspace.recent', {}).then((result) => {
      if (result.ok) setRecent(result.data.items);
    });
    void useTaskStore.getState().refreshTasks();
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [open, onClose]);

  const contexts = useMemo<TerminalContextChoice[]>(() => {
    const choices: TerminalContextChoice[] = [];
    if (workspace) {
      choices.push({
        key: 'focused',
        request: { kind: 'focused' },
        title: workspace.displayName,
        cwd: workspace.path,
        kindLabel: 'FOCUSED',
        owner: `project: ${workspace.displayName}`,
        accounting: 'snapshot + watcher · external unmanaged',
        projectPath: workspace.path,
      });
    }
    for (const project of recent
      .filter((entry) => entry.exists && entry.path !== workspace?.path)
      .slice(0, 3)) {
      choices.push({
        key: `recent:${project.path}`,
        request: { kind: 'recent', projectPath: project.path },
        title: project.displayName,
        cwd: project.path,
        kindLabel: 'RECENT PROJECT',
        owner: `project: ${project.displayName}`,
        accounting: 'snapshot + watcher · external unmanaged',
        projectPath: project.path,
      });
    }
    for (const task of tasks
      .filter((entry) => entry.worktree && !entry.worktree.missing)
      .slice(0, 3)) {
      choices.push({
        key: `task:${task.id}`,
        request: { kind: 'task', taskId: task.id },
        title: `Task worktree · ${task.title}`,
        cwd: task.worktree!.path,
        kindLabel: 'ISOLATED',
        owner: `task worktree: ${task.title}`,
        accounting: 'isolated worktree · task-owned',
        projectPath: task.projectPath,
      });
    }
    choices.push({
      key: 'scratch',
      request: { kind: 'scratch' },
      title: 'Scratch',
      cwd: 'Charter data/scratch/terminal-*',
      kindLabel: 'TEMPORARY',
      owner: 'scratch context',
      accounting: 'no project accounting',
      projectPath: null,
    });
    return choices;
  }, [recent, tasks, workspace]);

  useEffect(() => {
    if (contexts.some((context) => context.key === selectedKey)) return;
    setSelectedKey(contexts[0]?.key ?? 'scratch');
  }, [contexts, selectedKey]);

  if (!open) return null;
  const selected = contexts.find((context) => context.key === selectedKey) ?? contexts[0];
  if (!selected) return null;
  const sameTree = useTerminalStore
    .getState()
    .items.some(
      (item) =>
        (selected.request.kind === 'task' && item.cwd === selected.cwd) ||
        (selected.projectPath !== null && item.projectPath === selected.projectPath),
    );
  const launchLabel = launch === 'shell' ? 'Shell' : launch === 'claude' ? 'Claude Code' : 'Codex';
  const createSelected = async (): Promise<void> => {
    setCreating(true);
    try {
      const id = await useTerminalStore.getState().create({
        context: selected.request,
        launch,
        title: launch === 'shell' ? undefined : launchLabel,
      });
      if (id) onClose();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="terminal-create-backdrop"
      data-testid="terminal-create-dialog"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="terminal-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-create-title"
      >
        <header className="terminal-create-head">
          <div>
            <h2 id="terminal-create-title">New Terminal</h2>
            <p>创建一个普通 Terminal session；类型只决定可选的启动命令。</p>
          </div>
          <button className="terminal-icon-button" aria-label="Close" onClick={onClose}>
            <Ic name="x" size={16} />
          </button>
        </header>
        <div className="terminal-create-body">
          <section className="terminal-form-section">
            <div className="terminal-form-label">
              01 · 类型 <span>仍然是真实 shell + PTY</span>
            </div>
            <div className="terminal-type-grid">
              {(
                [
                  ['shell', 'Shell', '打开默认 shell'],
                  ['claude', 'Claude Code', '创建后运行 claude'],
                  ['codex', 'Codex', '创建后运行 codex'],
                ] as const
              ).map(([value, title, detail]) => (
                <button
                  key={value}
                  className={`terminal-type-option ${launch === value ? 'selected' : ''}`}
                  data-testid={`terminal-type-${value}`}
                  onClick={() => setLaunch(value)}
                >
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </button>
              ))}
            </div>
          </section>
          <section className="terminal-form-section">
            <div className="terminal-form-label">
              02 · Working context <span>不改变 Editor focus</span>
            </div>
            <div className="terminal-context-list">
              {contexts.map((context) => (
                <button
                  key={context.key}
                  className={`terminal-context-option ${selected.key === context.key ? 'selected' : ''}`}
                  data-testid={`terminal-context-${context.request.kind}`}
                  onClick={() => setSelectedKey(context.key)}
                >
                  <span className="terminal-radio" />
                  <span className="terminal-context-copy">
                    <strong>{context.title}</strong>
                    <small>{compactTerminalPath(context.cwd)}</small>
                  </span>
                  <span className="terminal-context-kind">{context.kindLabel}</span>
                </button>
              ))}
            </div>
            <div className={`terminal-resolved ${sameTree && launch !== 'shell' ? 'warning' : ''}`}>
              <span className="terminal-resolved-key">resolved cwd</span>
              <span>{compactTerminalPath(selected.cwd)}</span>
              <span className="terminal-resolved-key">owner</span>
              <span>{selected.owner}</span>
              <span className="terminal-resolved-key">editor focus</span>
              <span>unchanged: {workspace?.displayName ?? 'no focused workspace'}</span>
              <span className="terminal-resolved-key">accounting</span>
              <span>
                {sameTree && launch !== 'shell'
                  ? 'Same working tree · changes may overlap'
                  : selected.accounting}
              </span>
            </div>
          </section>
        </div>
        <footer className="terminal-create-foot">
          <span>
            Host 通过 project/task/scratch identity 解析 cwd；Renderer 不提交任意绝对路径。
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="terminal-create-submit"
            disabled={creating}
            onClick={() => void createSelected()}
          >
            {creating ? 'Creating…' : `Create ${launchLabel}`}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function TerminalPanel(): React.JSX.Element {
  const store = useTerminalStore();
  const workspace = useWorkspaceStore((s) => s.workspace);
  const tasks = useTaskStore((s) => s.tasks);
  const hostRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newTerminalOpen, setNewTerminalOpen] = useState(false);
  // ADR-0017: external agent sessions decorate their terminal's tab.
  const agentByTerminal = useExternalStore((s) => s.agentByTerminal);
  const taskByTerminal = useExternalStore((s) => s.taskByTerminal);
  const sessions = useExternalStore((s) => s.sessions);
  // ADR-0017 rev.2「意图升格」: a terminal the user moved to the side panel is
  // not in the dock — its xterm belongs to the panel until 归位.
  const promoted = useExternalStore((s) => s.promoted);
  const surface = useAppStore((s) => s.surface);
  const quickConsoleOpen = useQuickConsoleStore((s) => s.open);
  const dockItems = store.items.filter((t) => !t.hidden && t.id !== promoted?.terminalId);
  const activeDock = dockItems.find((t) => t.id === store.active) ?? null;

  useEffect(() => {
    store.init();
    useExternalStore.getState().init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A promoted terminal cannot stay dock-active; hand the slot to a neighbour.
  useEffect(() => {
    if (!promoted || store.active !== promoted.terminalId) return;
    const next = store.items.filter((t) => !t.hidden && t.id !== promoted.terminalId).at(-1);
    useTerminalStore.setState({ active: next?.id ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoted?.terminalId, store.active]);

  // Mount the active terminal into the host div. The Editor surface must be
  // in front — the room / the side panel own their instances otherwise.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeDock || surface !== 'workspace' || (activeDock.quick && quickConsoleOpen))
      return;
    mountTerminal(host, activeDock);
    return observeTerminalFit(host, activeDock);
  }, [activeDock, quickConsoleOpen, surface]);

  return (
    <div className="terminal-panel-layout" data-testid="terminal-panel">
      <div className="terminal-main-pane">
        {activeDock ? <SessionBar terminalId={activeDock.id} /> : null}
        <div ref={hostRef} className="terminal-host" data-testid="terminal-host" />
        {dockItems.length === 0 ? (
          <div className="terminal-dock-empty">
            <Ic name="terminal" size={18} />
            <span>
              {promoted
                ? 'The live terminal is in the side focus slot.'
                : workspace
                  ? 'Create a terminal in this project or another working context.'
                  : 'Open a project or choose a recent/scratch context.'}
            </span>
          </div>
        ) : null}
      </div>
      <aside className="terminal-list" aria-label="Terminal sessions">
        <div className="terminal-new-row">
          <button
            className="terminal-new-button"
            data-testid="terminal-new"
            disabled={!workspace}
            title={
              workspace ? `Create a shell in ${workspace.displayName}` : 'Open a project first'
            }
            onClick={() => void store.create({ context: { kind: 'focused' }, launch: 'shell' })}
          >
            <Ic name="plus" size={14} /> New Terminal
          </button>
          <button
            className="terminal-new-menu"
            data-testid="terminal-new-menu"
            title="Choose terminal type and working context"
            aria-label="Choose terminal type and working context"
            onClick={() => setNewTerminalOpen(true)}
          >
            <Ic name="chevron" size={14} />
          </button>
        </div>
        <div className="terminal-list-scroll">
          {store.items
            .filter((terminal) => !terminal.hidden)
            .map((terminal) => {
              const taskId = taskByTerminal[terminal.id];
              const task = taskId ? tasks.find((entry) => entry.id === taskId) : null;
              const session = taskId ? sessions[taskId] : undefined;
              const agent = agentByTerminal[terminal.id] ?? session?.cli ?? null;
              const inSide = promoted?.terminalId === terminal.id;
              const live = Boolean(agentByTerminal[terminal.id]) || session?.status === 'active';
              const ended = Boolean(session && session.status === 'ended');
              const stateLabel = inSide
                ? 'IN SIDE'
                : terminal.quick
                  ? quickConsoleOpen
                    ? 'QUICK · OPEN'
                    : 'QUICK'
                  : live
                    ? 'LIVE'
                    : ended
                      ? 'ENDED'
                      : 'IDLE';
              const dockActive = store.active === terminal.id && !inSide;
              // With a side focus slot, the strong selected color must describe
              // the terminal the user is actually looking at on the right.
              const selected = inSide || (!promoted && dockActive);
              const taskLabel = task?.title ?? terminal.contextLabel;
              const activate = (): void => {
                // When the focus slot is already in use, the session list is a
                // real switcher: clicking another live Agent atomically swaps
                // the two existing PTYs. No tiny secondary action is required.
                if (promoted && agent && live) {
                  useExternalStore.getState().promote(terminal.id);
                  return;
                }
                store.setActive(terminal.id);
              };
              const rowTitle = agent
                ? `${agentDisplayName(agent)} — ${inSide ? 'focus the side terminal' : promoted ? 'switch into the side slot' : 'open in the terminal dock'}`
                : `${terminal.title} — open in the terminal dock`;
              return (
                <div
                  key={terminal.id}
                  className={`terminal-list-row ${selected ? 'selected' : ''} ${inSide ? 'promoted' : ''} ${promoted && dockActive ? 'dock-active' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={inSide}
                  data-testid={`terminal-tab-${terminal.id}`}
                  title={rowTitle}
                  onClick={activate}
                  onDoubleClick={() => !agent && !inSide && setRenaming(terminal.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activate();
                    }
                  }}
                >
                  <span
                    className={`terminal-row-dot ${agent ? '' : 'shell'} ${terminal.exited || ended ? 'ended' : ''}`}
                  />
                  <span className="terminal-row-main">
                    {renaming === terminal.id ? (
                      <input
                        autoFocus
                        className="terminal-rename-input"
                        defaultValue={terminal.title}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === 'Enter') {
                            store.rename(
                              terminal.id,
                              (event.target as HTMLInputElement).value || terminal.title,
                            );
                            setRenaming(null);
                          }
                          if (event.key === 'Escape') setRenaming(null);
                        }}
                        onBlur={() => setRenaming(null)}
                      />
                    ) : (
                      <span className="terminal-row-title">
                        {agent ? (
                          <span
                            className="term-agent"
                            data-testid={
                              agentByTerminal[terminal.id]
                                ? `terminal-agent-${terminal.id}`
                                : undefined
                            }
                          >
                            ✳ {agentDisplayName(agent)} <span className="term-agent-ext">EXT</span>
                          </span>
                        ) : (
                          <>
                            {terminal.title}
                            {terminal.quick ? (
                              <span className="terminal-quick-badge">速召台</span>
                            ) : null}
                          </>
                        )}
                      </span>
                    )}
                    <span className="terminal-row-context">
                      {terminal.projectName} · {taskLabel}
                    </span>
                    <span className="terminal-row-cwd" title={terminal.cwd}>
                      {compactTerminalPath(terminal.cwd)}
                    </span>
                  </span>
                  <span className="terminal-row-side">
                    <span className={`terminal-row-place ${ended ? 'ended' : ''}`}>
                      {stateLabel}
                    </span>
                    <button
                      className="terminal-icon-button terminal-row-close"
                      aria-label={`Close ${terminal.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void store.requestKill(terminal.id);
                      }}
                    >
                      <Ic name="x" size={13} />
                    </button>
                  </span>
                  {taskId ? (
                    <span className="terminal-row-actions">
                      <button
                        className="terminal-row-action"
                        data-testid={`terminal-open-room-${terminal.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          useAppStore.getState().openTaskRoom(taskId);
                        }}
                      >
                        ⤢ Room
                      </button>
                      {live ? (
                        <button
                          className="terminal-row-action move"
                          data-testid={`terminal-row-promote-${terminal.id}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            useExternalStore.getState().promote(terminal.id);
                          }}
                        >
                          {inSide
                            ? '↗ Focus side'
                            : promoted
                              ? '⇄ Replace in side'
                              : '⇥ Move to side'}
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </div>
              );
            })}
        </div>
      </aside>

      <NewTerminalDialog open={newTerminalOpen} onClose={() => setNewTerminalOpen(false)} />

      {store.pendingKill ? (
        <div className="modal-backdrop">
          <div className="modal small" role="dialog" data-testid="terminal-kill-confirm">
            <div className="modal-header">Terminal has running processes</div>
            <div style={{ padding: 16 }}>
              <p>Closing this terminal will terminate its running processes.</p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  className="btn"
                  onClick={() => void store.confirmKill(store.pendingKill!, false)}
                >
                  Cancel
                </button>
                <button
                  className="btn danger"
                  data-testid="terminal-kill-force"
                  onClick={() => void store.confirmKill(store.pendingKill!, true)}
                >
                  Kill and close
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function TerminalContextsStatusItem(): React.JSX.Element | null {
  const items = useTerminalStore((s) => s.items);
  const agents = useExternalStore((s) => s.agentByTerminal);
  if (items.length === 0) return null;
  const contexts = new Set(items.map((item) => item.cwd)).size;
  const liveAgents = Object.keys(agents).length;
  return (
    <span
      className="sb-item terminal-context-status"
      data-testid="status-terminal-contexts"
      title={`${items.length} terminal sessions in ${contexts} independent working contexts`}
    >
      Terminal contexts: <strong>{contexts}</strong>
      {liveAgents > 0 ? <span className="terminal-live-status">● {liveAgents} live</span> : null}
    </span>
  );
}
