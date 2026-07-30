import type { TaskDto } from '@pi-ide/ipc-contracts';
import { needsAttention } from '../views/labels.js';

const STORAGE_KEY = 'charter.attention-dismissals.v1';

export type AttentionDismissals = Record<string, string>;

export function attentionFingerprint(task: TaskDto): string {
  return `${task.state}:${task.updatedAt}`;
}

export function loadAttentionDismissals(): AttentionDismissals {
  if (typeof window === 'undefined') return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

export function saveAttentionDismissals(dismissals: AttentionDismissals): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(dismissals));
  } catch {
    // A privacy-restricted renderer may deny storage; clearing still works for this run.
  }
}

export function visibleAttentionTasks(
  tasks: TaskDto[],
  dismissals: AttentionDismissals,
): TaskDto[] {
  return tasks.filter(
    (task) =>
      !task.archived && needsAttention(task) && dismissals[task.id] !== attentionFingerprint(task),
  );
}

export function dismissCurrentAttention(
  tasks: TaskDto[],
  current: AttentionDismissals,
): AttentionDismissals {
  const taskIds = new Set(tasks.map((task) => task.id));
  const next = Object.fromEntries(
    Object.entries(current).filter(([taskId]) => taskIds.has(taskId)),
  );
  for (const task of tasks) {
    if (!task.archived && needsAttention(task)) next[task.id] = attentionFingerprint(task);
  }
  return next;
}
