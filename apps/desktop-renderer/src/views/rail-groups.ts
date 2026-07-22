import type { TaskDto } from '@pi-ide/ipc-contracts';
import { isHistoryTask, needsAttention } from './labels.js';

/** One Sessions-rail row: a Charter task, or a bare composer-launched CLI
 * terminal that no task has claimed yet. */
export type SessionEntry =
  | { key: string; kind: 'task'; task: TaskDto }
  | {
      key: string;
      kind: 'terminal';
      terminalId: string;
      launch: 'shell' | 'claude' | 'codex';
      projectName: string;
      exited: boolean;
    };

export interface RailGroup {
  key: string;
  name: string;
  path: string | null;
  entries: SessionEntry[];
  needs: number;
  history?: boolean;
}

/**
 * ADR-0023 + external sessions: History = the session is over AND nothing
 * needs a decision (predicates live in labels.ts). Exited bare CLI terminals
 * count as over; a live process never lands here.
 */
export function isHistoryEntry(entry: SessionEntry): boolean {
  return entry.kind === 'terminal' ? entry.exited : isHistoryTask(entry.task);
}

/**
 * Group rail entries by project, History last. Pure so the Projects panel can
 * run it over the COMPLETE entry list — its per-project counts must not shrink
 * with the rail's pagination, which is a display concern only.
 */
export function buildRailGroups(entries: readonly SessionEntry[]): RailGroup[] {
  const active: RailGroup[] = [];
  const byName = new Map<string, RailGroup>();
  const history: RailGroup = {
    key: 'history',
    name: 'History',
    path: null,
    entries: [],
    needs: 0,
    history: true,
  };
  for (const entry of entries) {
    if (isHistoryEntry(entry)) {
      history.entries.push(entry);
      continue;
    }
    const name = entry.kind === 'task' ? entry.task.projectName : entry.projectName;
    let group = byName.get(name);
    if (!group) {
      group = { key: `proj:${name}`, name, path: null, entries: [], needs: 0 };
      byName.set(name, group);
      active.push(group);
    }
    if (entry.kind === 'task') {
      group.path ??= entry.task.projectPath;
      if (needsAttention(entry.task)) group.needs += 1;
    }
    group.entries.push(entry);
  }
  return history.entries.length > 0 ? [...active, history] : active;
}

/**
 * Recorded sessions per project path — active AND History rows alike, because
 * ADR-0034 "remove project" deletes both. Bare terminals are live processes,
 * not records, and stay out.
 */
export function recordedTasksByProject(entries: readonly SessionEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== 'task') continue;
    counts.set(entry.task.projectPath, (counts.get(entry.task.projectPath) ?? 0) + 1);
  }
  return counts;
}
