import { describe, expect, it } from 'vitest';
import {
  announceChange,
  changeKindLabel,
  groupChanges,
  nextChangeIndex,
  type DiffLine,
} from '../../apps/desktop-renderer/src/views/accessible-diff';

const ctx = (n: number, t = 'ctx'): DiffLine => ({ kind: 'context', lineNumber: n, text: t });
const add = (n: number, t: string): DiffLine => ({ kind: 'addition', lineNumber: n, text: t });
const del = (n: number, t: string): DiffLine => ({ kind: 'deletion', lineNumber: n, text: t });

describe('accessible diff grouping (M11-05, A11Y-005)', () => {
  it('groups consecutive changed lines, split by context', () => {
    const changes = groupChanges([ctx(1), del(2, 'old'), add(2, 'new'), ctx(3), add(4, 'added')]);
    expect(changes.length).toBe(2);
    expect(changes[0]).toMatchObject({ index: 0, line: 2, additions: 1, deletions: 1 });
    expect(changes[1]).toMatchObject({ index: 1, line: 4, additions: 1, deletions: 0 });
  });

  it('a file of only context has no changes', () => {
    expect(groupChanges([ctx(1), ctx(2), ctx(3)])).toEqual([]);
  });

  it('labels change kind', () => {
    expect(changeKindLabel(groupChanges([add(1, 'a')])[0]!)).toBe('added');
    expect(changeKindLabel(groupChanges([del(1, 'a')])[0]!)).toBe('removed');
    expect(changeKindLabel(groupChanges([del(1, 'a'), add(1, 'b')])[0]!)).toBe('modified');
  });

  it('announces a change for a screen reader', () => {
    const change = groupChanges([del(41, 'x'), add(41, 'y'), add(42, 'z')])[0]!;
    const said = announceChange('src/router.ts', change, 4);
    expect(said).toContain('Change 1 of 4');
    expect(said).toContain('src/router.ts');
    expect(said).toContain('line 41');
    expect(said).toContain('modified');
    expect(said).toContain('2 added, 1 removed');
  });

  it('F7 / Shift+F7 wrap around the change list', () => {
    expect(nextChangeIndex(-1, 4, 1)).toBe(0); // first F7 from nowhere
    expect(nextChangeIndex(-1, 4, -1)).toBe(3); // first Shift+F7 → last
    expect(nextChangeIndex(3, 4, 1)).toBe(0); // wrap forward
    expect(nextChangeIndex(0, 4, -1)).toBe(3); // wrap back
    expect(nextChangeIndex(0, 0, 1)).toBe(-1); // nothing to focus
  });
});
