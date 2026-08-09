import type { OpenTabsState } from '@pi-ide/ipc-contracts';

/**
 * Editor tab model (ADR-0057) — pure bookkeeping, kept out of the store so it
 * is unit-testable (same discipline as views/peek.ts). A tab is either a plain
 * file buffer or a git diff view of a path; both are addressed by a stable
 * string id so every existing path-keyed call site keeps working unchanged
 * (a file tab's id IS its path).
 */

export interface FileTab {
  kind: 'file';
  path: string;
  pinned: boolean;
}

export interface DiffTab {
  kind: 'diff';
  path: string;
  /** true: HEAD ↔ index (read-only). false: index ↔ working tree (live buffer). */
  staged: boolean;
  pinned: boolean;
}

export type EditorTab = FileTab | DiffTab;

/**
 * `//` never appears in a normalized workspace-relative path, so this prefix
 * cannot collide with a real file named like a diff id.
 */
const DIFF_ID_PREFIX = 'git-diff://';

export function diffTabId(path: string, staged: boolean): string {
  return `${DIFF_ID_PREFIX}${staged ? 'staged' : 'work'}/${path}`;
}

export function tabId(tab: EditorTab): string {
  return tab.kind === 'file' ? tab.path : diffTabId(tab.path, tab.staged);
}

export function parseDiffTabId(id: string): { path: string; staged: boolean } | null {
  if (!id.startsWith(DIFF_ID_PREFIX)) return null;
  const rest = id.slice(DIFF_ID_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const scope = rest.slice(0, slash);
  if (scope !== 'staged' && scope !== 'work') return null;
  const path = rest.slice(slash + 1);
  if (!path) return null;
  return { path, staged: scope === 'staged' };
}

export function isDiffTabId(id: string): boolean {
  return id.startsWith(DIFF_ID_PREFIX);
}

export function findTab(tabs: EditorTab[], id: string): EditorTab | undefined {
  return tabs.find((tab) => tabId(tab) === id);
}

/**
 * Working-tree diff tabs edit the real document buffer, so they hold the
 * document open exactly like a file tab. Staged diffs read both sides from
 * git and never touch the buffer.
 */
export function tabHoldsDocument(tab: EditorTab): boolean {
  return tab.kind === 'file' || !tab.staged;
}

/** The active tab id a group falls back to after removing `id`. */
export function nextActiveAfterClose(
  tabs: EditorTab[],
  active: string | null,
  id: string,
): string | null {
  if (active !== id) return active;
  const remaining = tabs.filter((tab) => tabId(tab) !== id);
  const last = remaining.at(-1);
  return last ? tabId(last) : null;
}

/** Serialize in-memory groups into the persisted OpenTabsState shape. */
export function toPersistedGroups(
  groups: Array<{ tabs: EditorTab[]; active: string | null }>,
): OpenTabsState['groups'] {
  return groups.map((group) => ({
    tabs: group.tabs.map((tab) =>
      tab.kind === 'file'
        ? { path: tab.path, pinned: tab.pinned, kind: 'file' as const }
        : { path: tab.path, pinned: tab.pinned, kind: 'diff' as const, staged: tab.staged },
    ),
    active: group.active,
  }));
}
