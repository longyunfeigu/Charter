import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { rpcResult } from '../bridge.js';
import { useEditorStore } from '../store/editorStore.js';

interface QuickOpenStore {
  open: boolean;
  setOpen(open: boolean): void;
}
export const useQuickOpenStore = create<QuickOpenStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

const recentFiles: string[] = [];
export function noteRecentFile(path: string): void {
  const index = recentFiles.indexOf(path);
  if (index !== -1) recentFiles.splice(index, 1);
  recentFiles.unshift(path);
  if (recentFiles.length > 30) recentFiles.pop();
}

export function QuickOpen(): React.JSX.Element | null {
  const open = useQuickOpenStore((s) => s.open);
  const setOpen = useQuickOpenStore((s) => s.setOpen);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Array<{ path: string; positions: number[] }>>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const seq = ++requestSeq.current;
    void rpcResult('search.files', { query }).then((res) => {
      if (seq !== requestSeq.current || !res.ok) return;
      let list = res.data.items;
      if (query === '') {
        // SRCH-001: recent files first when no query.
        const recent = recentFiles
          .filter((p) => list.some((i) => i.path === p) || true)
          .slice(0, 15)
          .map((p) => ({ path: p, positions: [] as number[] }));
        const rest = list.filter((i) => !recentFiles.includes(i.path)).slice(0, 50);
        list = [...recent, ...rest];
      }
      setItems(list.slice(0, 60));
      setSelected(0);
    });
  }, [query, open]);

  if (!open) return null;

  const openItem = (index: number) => {
    const item = items[index];
    if (!item) return;
    setOpen(false);
    noteRecentFile(item.path);
    void useEditorStore.getState().openFile(item.path);
  };

  return (
    <>
      <div className="overlay-backdrop" onClick={() => setOpen(false)} />
      <div className="quickpick" role="dialog" aria-label="Quick open" data-testid="quick-open">
        <input
          ref={inputRef}
          value={query}
          placeholder="Go to file…"
          aria-label="File name"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              setSelected((s) => Math.min(s + 1, items.length - 1));
              e.preventDefault();
            } else if (e.key === 'ArrowUp') {
              setSelected((s) => Math.max(s - 1, 0));
              e.preventDefault();
            } else if (e.key === 'Enter') openItem(selected);
            else if (e.key === 'Escape') setOpen(false);
          }}
        />
        <div className="quickpick-list" role="listbox">
          {items.length === 0 ? (
            <div className="quickpick-empty">No matching files</div>
          ) : (
            items.map((item, i) => {
              const name = item.path.split('/').pop()!;
              const dir = item.path.slice(0, item.path.length - name.length);
              return (
                <button
                  key={item.path}
                  role="option"
                  aria-selected={i === selected}
                  className={`quickpick-item ${i === selected ? 'selected' : ''}`}
                  data-testid={`quickopen-item-${item.path}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => openItem(i)}
                >
                  <span>{name}</span>
                  <span className="qp-detail">{dir}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
