/**
 * In-room file peek state (ADR-0014, PIVOT-034) — pure tab/active bookkeeping,
 * kept out of the store so it is unit-testable. The peek is a resident split
 * panel inside the Task Room: pinned tabs, one active file, one shared
 * Changes/File/Edit mode toggle. Edit reuses the real workspace document
 * model, so the session surface and full IDE never own divergent buffers.
 */

export interface PeekState {
  taskId: string;
  /** Pinned tabs in open order (capped; oldest drop first). */
  paths: string[];
  active: string;
  mode: 'diff' | 'file' | 'edit';
}

export const MAX_PEEK_TABS = 8;

/** Open (or focus) a file in the peek. A different task resets the peek. */
export function peekOpen(
  prev: PeekState | null,
  taskId: string,
  path: string,
  mode?: PeekState['mode'],
): PeekState {
  if (!prev || prev.taskId !== taskId) {
    return { taskId, paths: [path], active: path, mode: mode ?? 'diff' };
  }
  let paths = prev.paths.includes(path) ? prev.paths : [...prev.paths, path];
  if (paths.length > MAX_PEEK_TABS) {
    // Drop the oldest tabs but never the one being opened.
    paths = paths.filter((p) => p === path || paths.indexOf(p) >= paths.length - MAX_PEEK_TABS);
    paths = paths.slice(-MAX_PEEK_TABS);
  }
  return { taskId, paths, active: path, mode: mode ?? prev.mode };
}

/** Close one tab; closing the last tab closes the peek (null). */
export function peekCloseTab(prev: PeekState, path: string): PeekState | null {
  const paths = prev.paths.filter((p) => p !== path);
  if (paths.length === 0) return null;
  return {
    ...prev,
    paths,
    active: prev.active === path ? paths[paths.length - 1]! : prev.active,
  };
}

/** Default peek mode for a timeline tool row: writes show the diff, reads the file. */
export function peekModeForTool(toolName: string): 'diff' | 'file' {
  return ['apply_patch', 'create_file', 'delete_file', 'rename_file'].includes(toolName)
    ? 'diff'
    : 'file';
}
