import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { onEvent, rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useExternalStore } from '../store/externalStore.js';

interface TermInstance {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  exited: boolean;
}

interface TerminalStore {
  items: TermInstance[];
  active: string | null;
  pendingKill: string | null;
  initialized: boolean;
  init(): void;
  create(options?: { taskId?: string; title?: string }): Promise<void>;
  setActive(id: string): void;
  requestKill(id: string): Promise<void>;
  confirmKill(id: string, confirmed: boolean): Promise<void>;
  rename(id: string, title: string): void;
  clearActive(): void;
}

/**
 * Mount an existing xterm into a host element. xterm 6's `open()` only
 * attaches on the FIRST call (re-open is a window-bookkeeping no-op), so every
 * re-mount — dock tab switch, side panel, room, surface round-trip — must move
 * the live element itself (ADR-0017 rev.2 substrate fix).
 */
export function mountTerminal(host: HTMLElement, item: Pick<TermInstance, 'term' | 'fit'>): void {
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
}

function makeTerm(fontSize: number, scrollback: number): { term: Terminal; fit: FitAddon } {
  const dark = document.documentElement.dataset.theme !== 'light';
  const term = new Terminal({
    fontSize,
    fontFamily: "Menlo, Monaco, 'SF Mono', monospace",
    scrollback,
    cursorBlink: true,
    allowProposedApi: true,
    theme: dark
      ? { background: '#181818', foreground: '#cccccc' }
      : { background: '#ffffff', foreground: '#333333', cursor: '#333333' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  return { term, fit };
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  items: [],
  active: null,
  pendingKill: null,
  initialized: false,

  init() {
    if (get().initialized) return;
    set({ initialized: true });
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
    onEvent('workspace.changed', () => {
      for (const item of get().items) item.term.dispose();
      set({ items: [], active: null });
    });
  },

  async create(options) {
    const settings = useAppStore.getState().settings;
    const res = await rpcResult(
      'terminal.create',
      options?.taskId ? { taskId: options.taskId } : {},
    );
    if (!res.ok) {
      useAppStore.getState().pushToast('error', res.error.userMessage);
      return;
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
      title: options?.title ?? res.data.title,
      term,
      fit,
      exited: false,
    };
    set({ items: [...get().items, item], active: item.id });
    useAppStore.getState().showBottomTab('terminal');
  },

  setActive(id) {
    set({ active: id });
  },

  async requestKill(id) {
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
    useExternalStore.getState().handleTerminalClosed(id);
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
  const taskId = useExternalStore((s) => s.taskByTerminal[terminalId]);
  const cli = useExternalStore((s) => s.agentByTerminal[terminalId] ?? null);
  const session = useExternalStore((s) => (taskId ? s.sessions[taskId] : undefined));
  const promoted = useExternalStore((s) => s.promoted);
  if (!taskId) return null;
  const live = session ? session.status === 'active' : cli !== null;
  const files = session?.files.length ?? 0;
  const name = cli ?? session?.cli ?? 'agent';
  const slotTaken = promoted !== null && promoted.terminalId !== terminalId;
  const openRoom = (): void => useAppStore.getState().openTaskRoom(taskId);
  return (
    <div className={`term-session-bar ${live ? '' : 'ended'}`} data-testid="terminal-session-bar">
      <span className="tsb-dot" />
      <span className="tsb-cli">✳ {name}</span>
      <span
        className="term-agent-ext"
        title="External agent session — unmanaged (outside the Tool Gateway); tracked & reviewable"
      >
        EXT · unmanaged
      </span>
      {session?.snapshotRef ? (
        <span className="tsb-snap" title="Entry snapshot — rollback restores these bytes exactly">
          snap {session.snapshotRef.slice(0, 7)}
        </span>
      ) : null}
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
          disabled={slotTaken}
          title={
            slotTaken
              ? 'The side panel already hosts another session'
              : 'Move this session terminal to the right side panel (return anytime)'
          }
          onClick={() => useExternalStore.getState().promote(terminalId)}
        >
          ⇥ Move to side panel
        </button>
      ) : null}
    </div>
  );
}

export function TerminalPanel(): React.JSX.Element {
  const store = useTerminalStore();
  const workspace = useWorkspaceStore((s) => s.workspace);
  const hostRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // ADR-0017: external agent sessions decorate their terminal's tab.
  const agentByTerminal = useExternalStore((s) => s.agentByTerminal);
  const taskByTerminal = useExternalStore((s) => s.taskByTerminal);
  // ADR-0017 rev.2「意图升格」: a terminal the user moved to the side panel is
  // not in the dock — its xterm belongs to the panel until 归位.
  const promoted = useExternalStore((s) => s.promoted);
  const surface = useAppStore((s) => s.surface);
  const dockItems = store.items.filter((t) => t.id !== promoted?.terminalId);
  const activeDock = dockItems.find((t) => t.id === store.active) ?? null;

  useEffect(() => {
    store.init();
    useExternalStore.getState().init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A promoted terminal cannot stay dock-active; hand the slot to a neighbour.
  useEffect(() => {
    if (!promoted || store.active !== promoted.terminalId) return;
    const next = store.items.filter((t) => t.id !== promoted.terminalId).at(-1);
    useTerminalStore.setState({ active: next?.id ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoted?.terminalId, store.active]);

  // Mount the active terminal into the host div. The Editor surface must be
  // in front — the room / the side panel own their instances otherwise.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeDock || surface !== 'workspace') return;
    mountTerminal(host, activeDock);
    const observer = new ResizeObserver(() => {
      try {
        activeDock.fit.fit();
      } catch {
        // ignore fit races during teardown
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [activeDock, surface]);

  if (!workspace) {
    return <div className="empty-state">Open a workspace to use terminals.</div>;
  }

  return (
    <div style={{ display: 'flex', height: '100%' }} data-testid="terminal-panel">
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {activeDock ? <SessionBar terminalId={activeDock.id} /> : null}
        <div
          ref={hostRef}
          style={{ flex: 1, minHeight: 0, padding: '2px 4px' }}
          data-testid="terminal-host"
        />
        {dockItems.length === 0 ? (
          <div className="empty-state">
            <button
              className="btn primary"
              data-testid="terminal-create"
              onClick={() => void store.create()}
            >
              New Terminal
            </button>
          </div>
        ) : null}
      </div>
      <div
        style={{
          width: 180,
          borderLeft: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
        }}
      >
        <button
          className="quickpick-item"
          data-testid="terminal-new"
          onClick={() => void store.create()}
        >
          ＋ New Terminal
        </button>
        {dockItems.map((t) => (
          <div key={t.id}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {renaming === t.id ? (
                <input
                  autoFocus
                  defaultValue={t.title}
                  style={{ flex: 1, margin: 4 }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      store.rename(t.id, (e.target as HTMLInputElement).value || t.title);
                      setRenaming(null);
                    }
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => setRenaming(null)}
                />
              ) : (
                <button
                  className="quickpick-item"
                  style={{
                    flex: 1,
                    background: store.active === t.id ? 'var(--bg-selected)' : undefined,
                  }}
                  data-testid={`terminal-tab-${t.id}`}
                  onClick={() => store.setActive(t.id)}
                  onDoubleClick={() => setRenaming(t.id)}
                >
                  <span>
                    {t.exited ? '◌ ' : '● '}
                    {agentByTerminal[t.id] ? (
                      <span className="term-agent" data-testid={`terminal-agent-${t.id}`}>
                        ✳ {agentByTerminal[t.id]}{' '}
                        <span
                          className="term-agent-ext"
                          title="External agent session — unmanaged (outside the Tool Gateway); tracked & reviewable"
                        >
                          EXT
                        </span>
                      </span>
                    ) : (
                      t.title
                    )}
                  </span>
                </button>
              )}
              <button
                className="modal-close"
                aria-label={`Close ${t.title}`}
                onClick={() => void store.requestKill(t.id)}
              >
                ✕
              </button>
            </div>
            {taskByTerminal[t.id] ? (
              <button
                className="quickpick-item term-room-open"
                data-testid={`terminal-open-room-${t.id}`}
                title="Open this session's Task Room — live changes, peek and review around this terminal"
                onClick={() => {
                  useAppStore.getState().openTaskRoom(taskByTerminal[t.id]!);
                }}
              >
                ⤢ Open session room
              </button>
            ) : null}
          </div>
        ))}
      </div>

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
