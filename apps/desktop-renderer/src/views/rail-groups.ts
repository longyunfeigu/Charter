import type { AssignmentDto, MissionSnapshotDto, TaskDto } from '@pi-ide/ipc-contracts';
import { isHistoryTask, needsAttention } from './labels.js';

export interface MissionSessionLink {
  missionId: string;
  assignmentId: string;
  parentKey: string | null;
  depth: number;
  agentName: string;
  taskTitle: string;
  provider: 'pi' | 'shell' | 'claude' | 'codex';
  assignmentState: AssignmentDto['state'];
  missionState: MissionSnapshotDto['mission']['state'];
  runtimeSessionId: string | null;
  terminalId: string | null;
  transport: 'native' | 'acp' | 'terminal' | null;
}

/** One Sessions-rail row: a Charter task, or a bare composer-launched CLI
 * terminal that no task has claimed yet. */
export type SessionEntry =
  | { key: string; kind: 'task'; task: TaskDto; mission?: MissionSessionLink }
  | {
      key: string;
      kind: 'terminal';
      terminalId: string;
      launch: 'shell' | 'claude' | 'codex';
      projectName: string;
      exited: boolean;
      /** ADR-0047: true when this terminal runs on a remote SSH host. The host
       * label is already the projectName, so grouping puts it under the host. */
      remote?: boolean;
      mission?: MissionSessionLink;
    }
  | {
      key: string;
      kind: 'mission';
      projectName: string;
      projectPath: string;
      updatedAt: string;
      mission: MissionSessionLink;
    };

export interface RailGroup {
  key: string;
  name: string;
  path: string | null;
  entries: SessionEntry[];
  needs: number;
  history?: boolean;
}

export const ACTIVE_SESSION_GROUP_LIMIT = 3;
export const HISTORY_PERIOD_INITIAL_LIMIT = 5;
export const HISTORY_PERIOD_MORE_STEP = 10;

export type HistoryPeriodKey =
  'today' | 'yesterday' | 'previous-7-days' | 'previous-30-days' | 'older';

export interface HistoryPeriod {
  key: HistoryPeriodKey;
  label: string;
  entries: SessionEntry[];
}

const HISTORY_PERIOD_DEFINITIONS: ReadonlyArray<{
  key: HistoryPeriodKey;
  label: string;
}> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'previous-7-days', label: 'Previous 7 days' },
  { key: 'previous-30-days', label: 'Previous 30 days' },
  { key: 'older', label: 'Older' },
];

function localCalendarDay(value: number): number {
  const date = new Date(value);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function entryUpdatedAt(entry: SessionEntry, now: number): number {
  if (entry.kind === 'terminal') return now;
  const parsed = Date.parse(entry.kind === 'task' ? entry.task.updatedAt : entry.updatedAt);
  return Number.isFinite(parsed) ? parsed : now;
}

/** History periods are mutually exclusive local-calendar ranges. */
export function historyPeriodKey(value: number, now: number): HistoryPeriodKey {
  const elapsedDays = Math.floor((localCalendarDay(now) - localCalendarDay(value)) / 86_400_000);
  if (elapsedDays <= 0) return 'today';
  if (elapsedDays === 1) return 'yesterday';
  if (elapsedDays <= 7) return 'previous-7-days';
  if (elapsedDays <= 30) return 'previous-30-days';
  return 'older';
}

/** Split History into stable display periods and order every period newest first. */
export function buildHistoryPeriods(
  entries: readonly SessionEntry[],
  now: number,
): HistoryPeriod[] {
  const byPeriod = new Map<HistoryPeriodKey, SessionEntry[]>();
  for (const entry of entries) {
    const key = historyPeriodKey(entryUpdatedAt(entry, now), now);
    const period = byPeriod.get(key) ?? [];
    period.push(entry);
    byPeriod.set(key, period);
  }
  return HISTORY_PERIOD_DEFINITIONS.flatMap(({ key, label }) => {
    const periodEntries = byPeriod.get(key);
    if (!periodEntries?.length) return [];
    return [
      {
        key,
        label,
        entries: periodEntries.toSorted(
          (left, right) => entryUpdatedAt(right, now) - entryUpdatedAt(left, now),
        ),
      },
    ];
  });
}

export function visibleHistoryPeriodEntries(
  period: HistoryPeriod,
  options: { limit: number; filtering: boolean },
): SessionEntry[] {
  if (options.filtering) return period.entries;
  return period.entries.slice(0, options.limit);
}

/** Active project groups stay compact by default. Search/filter results and
 * History's outer group stay complete; History periods paginate separately. */
export function visibleRailGroupEntries(
  group: RailGroup,
  options: { expanded: boolean; filtering: boolean },
): SessionEntry[] {
  if (group.history || options.expanded || options.filtering) return group.entries;
  const present = new Set(group.entries.map((entry) => entry.key));
  const roots = group.entries.filter(
    (entry) => !entry.mission?.parentKey || !present.has(entry.mission.parentKey),
  );
  const visible = new Set(roots.slice(0, ACTIVE_SESSION_GROUP_LIMIT).map((entry) => entry.key));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of group.entries) {
      const parentKey = entry.mission?.parentKey;
      if (!parentKey || !visible.has(parentKey) || visible.has(entry.key)) continue;
      visible.add(entry.key);
      changed = true;
    }
  }
  return group.entries.filter((entry) => visible.has(entry.key));
}

/**
 * ADR-0023 + external sessions: History = the session is over AND nothing
 * needs a decision (predicates live in labels.ts). Exited bare CLI terminals
 * count as over; a live process never lands here.
 */
export function isHistoryEntry(entry: SessionEntry): boolean {
  if (entry.mission) {
    return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(entry.mission.missionState);
  }
  if (entry.kind === 'mission') return false;
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
    } else if (entry.kind === 'mission') {
      group.path ??= entry.projectPath;
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
