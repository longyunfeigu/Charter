import { describe, expect, it } from 'vitest';
import {
  diffTabId,
  findTab,
  isDiffTabId,
  nextActiveAfterClose,
  parseDiffTabId,
  tabHoldsDocument,
  tabId,
  toPersistedGroups,
  type EditorTab,
} from './editor-tabs.js';

const file = (path: string, pinned = false): EditorTab => ({ kind: 'file', path, pinned });
const diff = (path: string, staged: boolean, pinned = false): EditorTab => ({
  kind: 'diff',
  path,
  staged,
  pinned,
});

describe('tab ids', () => {
  it('a file tab id IS its path — every legacy call site keeps working', () => {
    expect(tabId(file('src/util.ts'))).toBe('src/util.ts');
  });

  it('diff ids are scope-qualified and never collide with each other', () => {
    expect(diffTabId('src/util.ts', false)).toBe('git-diff://work/src/util.ts');
    expect(diffTabId('src/util.ts', true)).toBe('git-diff://staged/src/util.ts');
    expect(diffTabId('src/util.ts', false)).not.toBe(diffTabId('src/util.ts', true));
  });

  it('round-trips through parse', () => {
    expect(parseDiffTabId(diffTabId('a/b.ts', true))).toEqual({ path: 'a/b.ts', staged: true });
    expect(parseDiffTabId(diffTabId('a/b.ts', false))).toEqual({ path: 'a/b.ts', staged: false });
  });

  it('rejects plain paths and malformed ids', () => {
    expect(parseDiffTabId('src/util.ts')).toBeNull();
    expect(parseDiffTabId('git-diff://bogus/src/util.ts')).toBeNull();
    expect(parseDiffTabId('git-diff://work/')).toBeNull();
    expect(isDiffTabId('git-diff://work/x')).toBe(true);
    expect(isDiffTabId('src/git-diff:.ts')).toBe(false);
  });

  it('keeps a path containing slashes intact', () => {
    const parsed = parseDiffTabId(diffTabId('deep/nested/dir/file.spec.ts', false));
    expect(parsed?.path).toBe('deep/nested/dir/file.spec.ts');
  });
});

describe('findTab', () => {
  it('distinguishes the file tab from diff tabs of the same path', () => {
    const tabs = [file('a.ts'), diff('a.ts', false), diff('a.ts', true)];
    expect(findTab(tabs, 'a.ts')).toBe(tabs[0]);
    expect(findTab(tabs, diffTabId('a.ts', false))).toBe(tabs[1]);
    expect(findTab(tabs, diffTabId('a.ts', true))).toBe(tabs[2]);
    expect(findTab(tabs, diffTabId('b.ts', true))).toBeUndefined();
  });
});

describe('tabHoldsDocument', () => {
  it('file and working-tree diff tabs hold the live buffer, staged diffs do not', () => {
    expect(tabHoldsDocument(file('a.ts'))).toBe(true);
    expect(tabHoldsDocument(diff('a.ts', false))).toBe(true);
    expect(tabHoldsDocument(diff('a.ts', true))).toBe(false);
  });
});

describe('nextActiveAfterClose', () => {
  const tabs = [file('a.ts'), diff('a.ts', false), file('b.ts')];

  it('keeps the current active when a background tab closes', () => {
    expect(nextActiveAfterClose(tabs, 'b.ts', diffTabId('a.ts', false))).toBe('b.ts');
  });

  it('falls back to the last remaining tab when the active one closes', () => {
    expect(nextActiveAfterClose(tabs, 'b.ts', 'b.ts')).toBe(diffTabId('a.ts', false));
  });

  it('returns null when the last tab closes', () => {
    expect(nextActiveAfterClose([file('a.ts')], 'a.ts', 'a.ts')).toBeNull();
  });
});

describe('persistence mapping', () => {
  it('serializes both tab kinds and the staged flag', () => {
    const groups = [
      {
        tabs: [file('a.ts', true), diff('a.ts', false), diff('b.ts', true)],
        active: diffTabId('a.ts', false),
      },
    ];
    expect(toPersistedGroups(groups)).toEqual([
      {
        tabs: [
          { path: 'a.ts', pinned: true, kind: 'file' },
          { path: 'a.ts', pinned: false, kind: 'diff', staged: false },
          { path: 'b.ts', pinned: false, kind: 'diff', staged: true },
        ],
        active: 'git-diff://work/a.ts',
      },
    ]);
  });
});
