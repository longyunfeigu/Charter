import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { monaco, modelUri } from '../monaco-setup.js';
import { onEvent, rpcResult } from '../bridge.js';
import { useEditorStore } from '../store/editorStore.js';
import { useAppStore } from '../store/appStore.js';

interface Match {
  line: number;
  column: number;
  matchText: string;
  previewText: string;
  absoluteStart: number;
  absoluteEnd: number;
  excluded?: boolean;
}
interface Group {
  path: string;
  contentHash: string;
  matches: Match[];
  collapsed?: boolean;
}

interface SearchState {
  query: string;
  replaceText: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  includeGlob: string;
  excludeGlob: string;
  searching: boolean;
  searchId: string | null;
  groups: Group[];
  truncated: boolean;
  ran: boolean;
  previewOpen: boolean;

  set(partial: Partial<SearchState>): void;
  run(): Promise<void>;
  cancel(): Promise<void>;
  toggleMatch(path: string, index: number): void;
  toggleGroup(path: string): void;
  applyReplace(): Promise<void>;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  replaceText: '',
  isRegex: false,
  caseSensitive: false,
  wholeWord: false,
  includeGlob: '',
  excludeGlob: '',
  searching: false,
  searchId: null,
  groups: [],
  truncated: false,
  ran: false,
  previewOpen: false,

  set: (partial) => set(partial),

  async run() {
    const state = get();
    if (state.query.trim() === '') return;
    set({ searching: true, groups: [], truncated: false, ran: true });
    const res = await rpcResult('search.textStart', {
      query: state.query,
      isRegex: state.isRegex,
      caseSensitive: state.caseSensitive,
      wholeWord: state.wholeWord,
      ...(state.includeGlob ? { includeGlob: state.includeGlob } : {}),
      ...(state.excludeGlob ? { excludeGlob: state.excludeGlob } : {}),
      maxResults: 2000,
    });
    if (res.ok) set({ searchId: res.data.searchId });
    else {
      set({ searching: false });
      useAppStore.getState().pushToast('error', res.error.userMessage);
    }
  },

  async cancel() {
    const { searchId } = get();
    if (searchId) await rpcResult('search.cancel', { searchId });
    set({ searching: false });
  },

  toggleMatch(path, index) {
    set({
      groups: get().groups.map((g) =>
        g.path === path
          ? {
              ...g,
              matches: g.matches.map((m, i) => (i === index ? { ...m, excluded: !m.excluded } : m)),
            }
          : g,
      ),
    });
  },

  toggleGroup(path) {
    set({
      groups: get().groups.map((g) => (g.path === path ? { ...g, collapsed: !g.collapsed } : g)),
    });
  },

  async applyReplace() {
    const state = get();
    const files = state.groups
      .map((g) => ({
        path: g.path,
        expectedHash: g.contentHash,
        edits: g.matches
          .filter((m) => !m.excluded)
          .map((m) => ({ start: m.absoluteStart, end: m.absoluteEnd, text: state.replaceText })),
      }))
      .filter((f) => f.edits.length > 0);
    if (files.length === 0) return;
    const res = await rpcResult('search.replace', { files });
    set({ previewOpen: false });
    if (res.ok) {
      const applied = res.data.outcomes.filter((o) => o.status === 'applied').length;
      const stale = res.data.outcomes.filter((o) => o.status === 'stale').length;
      useAppStore
        .getState()
        .pushToast(
          stale > 0 ? 'warning' : 'success',
          `Replaced in ${applied} file(s).${stale > 0 ? ` ${stale} file(s) changed since the search and were skipped — re-run the search.` : ''}`,
        );
      void get().run();
    } else {
      useAppStore.getState().pushToast('error', res.error.userMessage);
    }
  },
}));

export function focusSearchView(): void {
  useAppStore.getState().showSideBarView('search');
  setTimeout(() => {
    document.querySelector<HTMLInputElement>('[data-testid="search-input"]')?.focus();
  }, 50);
}

export function SearchView(): React.JSX.Element {
  const store = useSearchStore();
  const [showReplace, setShowReplace] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    onEvent('search.results', (payload) => {
      const current = useSearchStore.getState();
      if (payload.searchId !== current.searchId) return;
      useSearchStore.setState({
        groups: payload.groups.map((g) => ({ ...g })),
        searching: !payload.done,
        truncated: payload.truncated,
      });
    });
  }, []);

  const totalMatches = store.groups.reduce((n, g) => n + g.matches.length, 0);
  const included = store.groups.reduce(
    (n, g) => n + g.matches.filter((m) => !m.excluded).length,
    0,
  );

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      data-testid="search-view"
    >
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            data-testid="search-input"
            placeholder="Search"
            value={store.query}
            style={{
              flex: 1,
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '5px 8px',
            }}
            onChange={(e) => store.set({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void store.run();
            }}
          />
          <button
            className="modal-close"
            title="Toggle replace"
            aria-label="Toggle replace"
            onClick={() => setShowReplace(!showReplace)}
          >
            ⇄
          </button>
        </div>
        {showReplace ? (
          <input
            data-testid="replace-input"
            placeholder="Replace"
            value={store.replaceText}
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '5px 8px',
            }}
            onChange={(e) => store.set({ replaceText: e.target.value })}
          />
        ) : null}
        <div style={{ display: 'flex', gap: 4, fontSize: 11, flexWrap: 'wrap' }}>
          {(
            [
              ['Aa', 'caseSensitive', 'Match case'],
              ['ab', 'wholeWord', 'Whole word'],
              ['.*', 'isRegex', 'Regular expression'],
            ] as const
          ).map(([label, key, title]) => (
            <button
              key={key}
              className="btn"
              title={title}
              aria-pressed={store[key]}
              style={{
                padding: '2px 8px',
                background: store[key] ? 'var(--bg-selected)' : undefined,
              }}
              onClick={() => store.set({ [key]: !store[key] } as Partial<SearchState>)}
            >
              {label}
            </button>
          ))}
          {store.searching ? (
            <button className="btn" data-testid="search-cancel" onClick={() => void store.cancel()}>
              Cancel
            </button>
          ) : (
            <button
              className="btn primary"
              data-testid="search-run"
              onClick={() => void store.run()}
            >
              Search
            </button>
          )}
        </div>
        <details>
          <summary className="text-muted" style={{ fontSize: 11, cursor: 'pointer' }}>
            include / exclude
          </summary>
          <input
            placeholder="include glob e.g. src/**"
            value={store.includeGlob}
            style={{
              width: '100%',
              marginTop: 4,
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '4px 8px',
            }}
            onChange={(e) => store.set({ includeGlob: e.target.value })}
          />
          <input
            placeholder="exclude glob e.g. **/*.md"
            value={store.excludeGlob}
            style={{
              width: '100%',
              marginTop: 4,
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '4px 8px',
            }}
            onChange={(e) => store.set({ excludeGlob: e.target.value })}
          />
        </details>
      </div>

      <div style={{ flex: 1, overflow: 'auto', fontSize: 12 }} data-testid="search-results">
        {store.searching ? (
          <div className="text-muted" style={{ padding: 8 }}>
            Searching…
          </div>
        ) : null}
        {!store.searching && store.ran && totalMatches === 0 ? (
          <div className="empty-state">No results</div>
        ) : null}
        {store.truncated ? (
          <div className="text-warning" style={{ padding: '4px 8px' }}>
            Results truncated — refine the query.
          </div>
        ) : null}
        {store.groups.map((group) => (
          <div key={group.path}>
            <button
              className="quickpick-item"
              style={{
                fontWeight: 600,
                position: 'sticky',
                top: 0,
                background: 'var(--bg-sidebar)',
              }}
              onClick={() => store.toggleGroup(group.path)}
            >
              <span aria-hidden>{group.collapsed ? '▸' : '▾'}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{group.path}</span>
              <span className="qp-detail">{group.matches.length}</span>
            </button>
            {!group.collapsed
              ? group.matches.map((match, i) => (
                  <div
                    key={i}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 18 }}
                  >
                    {showReplace ? (
                      <input
                        type="checkbox"
                        aria-label="Include in replace"
                        checked={!match.excluded}
                        onChange={() => store.toggleMatch(group.path, i)}
                      />
                    ) : null}
                    <button
                      className="quickpick-item"
                      style={{ padding: '3px 8px', flex: 1 }}
                      data-testid={`search-match-${group.path}-${match.line}`}
                      onClick={() => {
                        void useEditorStore
                          .getState()
                          .openFile(group.path)
                          .then(() => {
                            revealPosition(group.path, match.line, match.column);
                          });
                      }}
                    >
                      <span className="text-muted" style={{ minWidth: 30 }}>
                        {match.line}
                      </span>
                      <span
                        className="mono"
                        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'pre' }}
                      >
                        {match.previewText.trim().slice(0, 120)}
                      </span>
                    </button>
                  </div>
                ))
              : null}
          </div>
        ))}
      </div>

      {showReplace && totalMatches > 0 ? (
        <div style={{ padding: 8, borderTop: '1px solid var(--border)' }}>
          <button
            className="btn primary"
            data-testid="replace-preview-btn"
            style={{ width: '100%' }}
            onClick={() => store.set({ previewOpen: true })}
          >
            Preview replace ({included} of {totalMatches})
          </button>
        </div>
      ) : null}

      {store.previewOpen ? <ReplacePreview /> : null}
    </div>
  );
}

function ReplacePreview(): React.JSX.Element {
  const store = useSearchStore();
  const rows: Array<{ path: string; line: number; before: string; after: string }> = [];
  for (const group of store.groups) {
    for (const match of group.matches) {
      if (match.excluded) continue;
      rows.push({
        path: group.path,
        line: match.line,
        before: match.previewText.trim().slice(0, 160),
        after: match.previewText.replace(match.matchText, store.replaceText).trim().slice(0, 160),
      });
    }
  }
  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-label="Replace preview"
        data-testid="replace-preview"
      >
        <div className="modal-header">
          <span>
            Replace preview — {rows.length} change(s) in {new Set(rows.map((r) => r.path)).size}{' '}
            file(s)
          </span>
          <button
            className="modal-close"
            aria-label="Close"
            onClick={() => store.set({ previewOpen: false })}
          >
            ✕
          </button>
        </div>
        <div className="modal-body" style={{ fontSize: 12 }}>
          {rows.map((row, i) => (
            <div key={i} style={{ padding: '6px 14px', borderBottom: '1px solid var(--border)' }}>
              <div className="text-muted mono">
                {row.path}:{row.line}
              </div>
              <div
                className="mono"
                style={{ background: 'var(--diff-del-bg)', padding: '1px 6px' }}
              >
                - {row.before}
              </div>
              <div
                className="mono"
                style={{ background: 'var(--diff-add-bg)', padding: '1px 6px' }}
              >
                + {row.after}
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            padding: 12,
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            borderTop: '1px solid var(--border)',
          }}
        >
          <button className="btn" onClick={() => store.set({ previewOpen: false })}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="replace-apply"
            onClick={() => void store.applyReplace()}
          >
            Apply replace
          </button>
        </div>
      </div>
    </div>
  );
}

export function revealPosition(path: string, line: number, column: number): void {
  // Editor may need a tick to mount the model after openFile resolves.
  setTimeout(() => {
    const model = monaco.editor.getModel(modelUri(path));
    if (!model) return;
    const editor = monaco.editor.getEditors().find((e) => e.getModel() === model);
    if (editor) {
      editor.revealPositionInCenter({ lineNumber: line, column });
      editor.setPosition({ lineNumber: line, column });
      editor.focus();
    }
  }, 80);
}
