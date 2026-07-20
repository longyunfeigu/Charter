import { create } from 'zustand';
import { onEvent, rpcResult } from '../bridge.js';

/**
 * Workspace file decorations (ADR-0013): explorer rows, tabs and gutters read
 * one shared, watcher-refreshed snapshot. Two sources, merged:
 * - git status (authoritative when the project is a repo — covers user edits)
 * - the product's own change records (agent-touched files; the ONLY source
 *   for non-git projects, where git has nothing to say)
 * Visual language: A green (added — untracked and staged-new read the same to
 * users, so both show A), M amber, D red, R blue, C conflict red. Modified
 * files additionally carry ±line counts (git numstat) for the explorer.
 */

export type GitMark = 'A' | 'M' | 'D' | 'R' | 'C';

export const MARK_COLOR: Record<GitMark, string> = {
  A: 'var(--success)',
  M: 'var(--warning)',
  R: 'var(--info)',
  D: 'var(--danger)',
  C: 'var(--danger)',
};

export interface DiffStat {
  insertions: number;
  deletions: number;
}

interface GitStatusStore {
  isRepo: boolean;
  /** workspace-relative path → mark */
  byPath: Record<string, GitMark>;
  /** workspace-relative path → ±line counts (tracked, non-binary files only) */
  statByPath: Record<string, DiffStat>;
  /** directories that contain at least one marked file */
  dirty: Record<string, true>;
  /** bumps on every refresh — gutter recompute trigger */
  version: number;
  initialized: boolean;
  init(): void;
  refresh(): Promise<void>;
}

function markOf(entry: {
  group: 'staged' | 'changes' | 'untracked' | 'conflict';
  indexState: string;
  workState: string;
}): GitMark {
  if (entry.group === 'conflict') return 'C';
  if (entry.group === 'untracked') return 'A';
  const s = (entry.workState.trim() || entry.indexState.trim()).toUpperCase();
  if (s.startsWith('A')) return 'A';
  if (s.startsWith('D')) return 'D';
  if (s.startsWith('R')) return 'R';
  return 'M';
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export const useGitStatusStore = create<GitStatusStore>((set, get) => ({
  isRepo: false,
  byPath: {},
  statByPath: {},
  dirty: {},
  version: 0,
  initialized: false,

  init() {
    if (get().initialized) return;
    set({ initialized: true });
    onEvent('workspace.changed', () => {
      set({ byPath: {}, statByPath: {}, dirty: {}, isRepo: false });
      void get().refresh();
    });
    // Watcher events debounce into one status refresh.
    onEvent('fs.batch', () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void get().refresh();
      }, 400);
    });
    // Accept/rollback/archive edges add or clear agent marks immediately.
    onEvent('task.stateChanged', () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void get().refresh();
      }, 250);
    });
    void get().refresh();
  },

  async refresh() {
    const [gitRes, agentRes] = await Promise.all([
      rpcResult('git.status', {}),
      rpcResult('task.agentFileMarks', {}),
    ]);
    const byPath: Record<string, GitMark> = {};
    // Agent change records first …
    if (agentRes.ok) {
      for (const m of agentRes.data.marks) byPath[m.path] = m.mark;
    }
    // … git overrides per path when the project is a repo (it also sees user edits).
    const isRepo = gitRes.ok && gitRes.data.isRepo;
    const statByPath: Record<string, DiffStat> = {};
    if (gitRes.ok && gitRes.data.isRepo) {
      for (const entry of gitRes.data.entries) byPath[entry.path] = markOf(entry);
      for (const s of gitRes.data.stats) {
        statByPath[s.path] = { insertions: s.insertions, deletions: s.deletions };
      }
    }
    const dirty: Record<string, true> = {};
    for (const path of Object.keys(byPath)) {
      let dir = path;
      while (dir.includes('/')) {
        dir = dir.slice(0, dir.lastIndexOf('/'));
        dirty[dir] = true;
      }
    }
    set({ isRepo, byPath, statByPath, dirty, version: get().version + 1 });
  },
}));
