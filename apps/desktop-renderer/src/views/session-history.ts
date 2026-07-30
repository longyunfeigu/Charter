import type { DiscoveredSessionDto, TaskDto } from '@pi-ide/ipc-contracts';
import { sessionsInScope } from '../store/archaeologyStore.js';

export type SessionHistoryItem =
  | { key: string; kind: 'task'; at: string | null; task: TaskDto }
  | {
      key: string;
      kind: 'discovered';
      at: string | null;
      session: DiscoveredSessionDto;
    };

export interface SessionHistoryBucket {
  key: 'today' | 'yesterday' | 'week' | 'earlier' | 'undated';
  label: string;
  items: SessionHistoryItem[];
}

const DAY_MS = 86_400_000;
const BUCKETS: Array<[SessionHistoryBucket['key'], string]> = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'Past 7 days'],
  ['earlier', 'Earlier'],
  ['undated', 'Undated'],
];

/** One honest timeline across Charter tasks and CLI transcripts. A discovered
 * transcript that is already linked to a visible task is represented by the
 * richer task row once, never duplicated as an External conversation. */
export function sessionHistoryItems(
  tasks: TaskDto[],
  discovered: DiscoveredSessionDto[],
  scope: string | null,
): SessionHistoryItem[] {
  const scopedTasks = scope === null ? tasks : tasks.filter((task) => task.projectPath === scope);
  const taskIds = new Set(scopedTasks.map((task) => task.id));
  const scopedDiscovered = sessionsInScope(discovered, scope).filter(
    (session) => !session.trackedTaskId || !taskIds.has(session.trackedTaskId),
  );
  return [
    ...scopedTasks.map((task): SessionHistoryItem => ({
      key: `task:${task.id}`,
      kind: 'task',
      at: task.updatedAt,
      task,
    })),
    ...scopedDiscovered.map((session): SessionHistoryItem => ({
      key: `discovered:${session.cli}:${session.sessionId}`,
      kind: 'discovered',
      at: session.endedAt ?? session.startedAt,
      session,
    })),
  ].toSorted((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

export function sessionHistoryMatches(item: SessionHistoryItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const haystack =
    item.kind === 'task'
      ? [
          item.task.title,
          item.task.goalMd,
          item.task.projectName,
          item.task.projectPath,
          item.task.external?.cli,
        ]
      : [
          item.session.title,
          item.session.cli,
          item.session.cwd,
          item.session.projectPath,
          ...item.session.filesTouched,
          ...item.session.skills,
        ];
  return haystack.filter(Boolean).join(' ').toLowerCase().includes(normalized);
}

export function bucketSessionHistory(
  items: SessionHistoryItem[],
  now = Date.now(),
): SessionHistoryBucket[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const grouped: Record<SessionHistoryBucket['key'], SessionHistoryItem[]> = {
    today: [],
    yesterday: [],
    week: [],
    earlier: [],
    undated: [],
  };
  for (const item of items) {
    const timestamp = item.at ? Date.parse(item.at) : Number.NaN;
    if (!Number.isFinite(timestamp)) {
      grouped.undated.push(item);
      continue;
    }
    const start = new Date(timestamp);
    start.setHours(0, 0, 0, 0);
    const daysAgo = Math.round((startOfToday.getTime() - start.getTime()) / DAY_MS);
    if (daysAgo <= 0) grouped.today.push(item);
    else if (daysAgo === 1) grouped.yesterday.push(item);
    else if (daysAgo < 7) grouped.week.push(item);
    else grouped.earlier.push(item);
  }
  return BUCKETS.filter(([key]) => grouped[key].length > 0).map(([key, label]) => ({
    key,
    label,
    items: grouped[key],
  }));
}
