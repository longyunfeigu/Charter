import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyFilter } from '@pi-ide/foundation';
import { allCommands, executeCommand, formatKeybinding } from '../commands.js';
import { useAppStore } from '../store/appStore.js';

export function CommandPalette(): React.JSX.Element | null {
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const commands = allCommands();
    return fuzzyFilter(
      query,
      commands,
      (c) => `${c.category ? `${c.category}: ` : ''}${c.title}`,
      60,
    );
    // `open` re-reads the registry and enabled() gates on every open; commands
    // registered after first mount would otherwise stay missing.
  }, [query, open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  if (!open) return null;

  const run = (index: number) => {
    const item = items[index];
    if (!item) return;
    setOpen(false);
    executeCommand(item.item.id);
  };

  return (
    <>
      <div className="overlay-backdrop" onClick={() => setOpen(false)} />
      <div className="quickpick" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          value={query}
          placeholder="Type a command…"
          aria-label="Command"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              setSelected((s) => Math.min(s + 1, items.length - 1));
              e.preventDefault();
            } else if (e.key === 'ArrowUp') {
              setSelected((s) => Math.max(s - 1, 0));
              e.preventDefault();
            } else if (e.key === 'Enter') {
              run(selected);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        <div className="quickpick-list" role="listbox">
          {items.length === 0 ? (
            <div className="quickpick-empty">No matching commands</div>
          ) : (
            items.map((ranked, i) => (
              <button
                key={ranked.item.id}
                role="option"
                aria-selected={i === selected}
                className={`quickpick-item ${i === selected ? 'selected' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => run(i)}
              >
                <span>
                  {ranked.item.category ? (
                    <span className="text-muted">{ranked.item.category}: </span>
                  ) : null}
                  {ranked.item.title}
                </span>
                {ranked.item.keybinding ? (
                  <span className="qp-kbd">{formatKeybinding(ranked.item.keybinding)}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}
