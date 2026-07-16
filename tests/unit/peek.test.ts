import { describe, expect, it } from 'vitest';
import {
  MAX_PEEK_TABS,
  peekCloseTab,
  peekModeForTool,
  peekOpen,
  type PeekState,
} from '../../apps/desktop-renderer/src/views/peek.js';

describe('peek state (ADR-0014, PIVOT-034)', () => {
  it('opens a first file with the requested mode', () => {
    const s = peekOpen(null, 't1', 'src/a.ts', 'file');
    expect(s).toEqual({ taskId: 't1', paths: ['src/a.ts'], active: 'src/a.ts', mode: 'file' });
  });

  it('can open the shared workspace editor in the resident session slot', () => {
    const s = peekOpen(null, 't1', 'src/a.ts', 'edit');
    expect(s.mode).toBe('edit');
  });

  it('defaults to diff mode when none is given on a fresh peek', () => {
    expect(peekOpen(null, 't1', 'src/a.ts').mode).toBe('diff');
  });

  it('pins additional files as tabs and focuses the newest', () => {
    let s = peekOpen(null, 't1', 'a.ts', 'diff');
    s = peekOpen(s, 't1', 'b.ts');
    expect(s.paths).toEqual(['a.ts', 'b.ts']);
    expect(s.active).toBe('b.ts');
    expect(s.mode).toBe('diff'); // keeps the current mode when not specified
  });

  it('re-opening a pinned file focuses it without duplicating the tab', () => {
    let s = peekOpen(null, 't1', 'a.ts');
    s = peekOpen(s, 't1', 'b.ts');
    s = peekOpen(s, 't1', 'a.ts', 'file');
    expect(s.paths).toEqual(['a.ts', 'b.ts']);
    expect(s.active).toBe('a.ts');
    expect(s.mode).toBe('file'); // explicit mode wins
  });

  it('a different task resets the peek entirely', () => {
    const s1 = peekOpen(null, 't1', 'a.ts', 'file');
    const s2 = peekOpen(s1, 't2', 'b.ts');
    expect(s2).toEqual({ taskId: 't2', paths: ['b.ts'], active: 'b.ts', mode: 'diff' });
  });

  it('caps pinned tabs, dropping the oldest but never the opened file', () => {
    let s: PeekState | null = null;
    for (let i = 0; i < MAX_PEEK_TABS + 3; i++) {
      s = peekOpen(s, 't1', `f${i}.ts`);
    }
    expect(s!.paths.length).toBe(MAX_PEEK_TABS);
    expect(s!.paths).not.toContain('f0.ts');
    expect(s!.active).toBe(`f${MAX_PEEK_TABS + 2}.ts`);
    expect(s!.paths).toContain(s!.active);
  });

  it('closing a background tab keeps the active file', () => {
    let s = peekOpen(null, 't1', 'a.ts');
    s = peekOpen(s, 't1', 'b.ts');
    const next = peekCloseTab(s, 'a.ts');
    expect(next).not.toBeNull();
    expect(next!.paths).toEqual(['b.ts']);
    expect(next!.active).toBe('b.ts');
  });

  it('closing the active tab focuses the last remaining tab', () => {
    let s = peekOpen(null, 't1', 'a.ts');
    s = peekOpen(s, 't1', 'b.ts');
    s = peekOpen(s, 't1', 'c.ts');
    const next = peekCloseTab(s, 'c.ts');
    expect(next!.active).toBe('b.ts');
  });

  it('closing the last tab closes the peek', () => {
    const s = peekOpen(null, 't1', 'a.ts');
    expect(peekCloseTab(s, 'a.ts')).toBeNull();
  });

  it('write tools default to the diff, read tools to the file', () => {
    expect(peekModeForTool('apply_patch')).toBe('diff');
    expect(peekModeForTool('create_file')).toBe('diff');
    expect(peekModeForTool('delete_file')).toBe('diff');
    expect(peekModeForTool('rename_file')).toBe('diff');
    expect(peekModeForTool('read_file')).toBe('file');
    expect(peekModeForTool('list_directory')).toBe('file');
  });
});
