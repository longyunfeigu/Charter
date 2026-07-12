import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { onEvent, rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';

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
  create(): Promise<void>;
  setActive(id: string): void;
  requestKill(id: string): Promise<void>;
  confirmKill(id: string, confirmed: boolean): Promise<void>;
  rename(id: string, title: string): void;
  clearActive(): void;
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
    onEvent('workspace.changed', () => {
      for (const item of get().items) item.term.dispose();
      set({ items: [], active: null });
    });
  },

  async create() {
    const settings = useAppStore.getState().settings;
    const res = await rpcResult('terminal.create', {});
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
      title: res.data.title,
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
  },

  rename(id, title) {
    set({ items: get().items.map((t) => (t.id === id ? { ...t, title } : t)) });
  },

  clearActive() {
    const active = get().items.find((t) => t.id === get().active);
    active?.term.clear();
  },
}));

export function TerminalPanel(): React.JSX.Element {
  const store = useTerminalStore();
  const workspace = useWorkspaceStore((s) => s.workspace);
  const hostRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    store.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount the active terminal into the host div.
  useEffect(() => {
    const host = hostRef.current;
    const active = store.items.find((t) => t.id === store.active);
    if (!host || !active) return;
    host.innerHTML = '';
    active.term.open(host);
    active.fit.fit();
    active.term.focus();
    const observer = new ResizeObserver(() => {
      try {
        active.fit.fit();
      } catch {
        // ignore fit races during teardown
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [store.active, store.items]);

  if (!workspace) {
    return <div className="empty-state">Open a workspace to use terminals.</div>;
  }

  return (
    <div style={{ display: 'flex', height: '100%' }} data-testid="terminal-panel">
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div
          ref={hostRef}
          style={{ flex: 1, minHeight: 0, padding: '2px 4px' }}
          data-testid="terminal-host"
        />
        {store.items.length === 0 ? (
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
        {store.items.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center' }}>
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
                  {t.title}
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
