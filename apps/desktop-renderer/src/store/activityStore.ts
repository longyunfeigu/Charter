import { create } from 'zustand';
import { projectActivityEvent, type ActivityItem } from '@pi-ide/ipc-contracts';
import { onEvent, rpcResult } from '../bridge.js';

/**
 * Live activity across ALL tasks (ADR-0006): the mission-control cards and the
 * presence glow feed from here. Every persisted task event is already
 * broadcast for every task; this store runs the same pure projection the
 * replay uses, so "live" and "replay" can never tell different stories.
 */

export interface TaskActivity {
  /** Latest projected item of any kind. */
  last: ActivityItem | null;
  /** Latest non-state action (what the agent is/was DOING). */
  lastAction: ActivityItem | null;
  /** The currently running tool call, if any. */
  current: ActivityItem | null;
  /** Distinct workspace-relative paths touched so far (capped). */
  filesTouched: string[];
  updatedAt: number;
}

export interface ActivityPulse {
  taskId: string;
  paths: string[];
  at: number;
}

interface ActivityStore {
  perTask: Record<string, TaskActivity>;
  /** Recent write pulses for the presence glow (ring, newest last). */
  pulses: ActivityPulse[];
  initialized: boolean;
  init(): void;
  hydrate(taskId: string): Promise<void>;
  ingest(item: ActivityItem): void;
}

const EMPTY: TaskActivity = {
  last: null,
  lastAction: null,
  current: null,
  filesTouched: [],
  updatedAt: 0,
};

const MAX_FILES = 500;
const MAX_PULSES = 200;

function fold(prev: TaskActivity, item: ActivityItem): TaskActivity {
  const filesTouched =
    item.paths.length > 0
      ? [...new Set([...prev.filesTouched, ...item.paths])].slice(-MAX_FILES)
      : prev.filesTouched;
  // "What is the agent DOING" — message/state/system noise never becomes the
  // action line (fixes the room header overflowing with reply prose).
  const isAction =
    item.kind !== 'state' &&
    item.kind !== 'system' &&
    item.kind !== 'report' &&
    item.kind !== 'message' &&
    item.kind !== 'user';
  let current = prev.current;
  if (item.status === 'running' && item.callId) {
    current = item;
  } else if (item.callId && current?.callId === item.callId) {
    current = null; // the running call reached a terminal state
  }
  return {
    last: item,
    lastAction: isAction ? item : prev.lastAction,
    current,
    filesTouched,
    updatedAt: Date.now(),
  };
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
  perTask: {},
  pulses: [],
  initialized: false,

  init() {
    if (get().initialized) return;
    set({ initialized: true });
    onEvent('task.event', ({ taskId, event }) => {
      const item = projectActivityEvent(event);
      if (!item) return;
      void taskId;
      get().ingest(item);
    });
    // ADR-0009: activity is global; switching the focused project keeps every
    // task's presence alive.
  },

  ingest(item) {
    const perTask = get().perTask;
    const next = fold(perTask[item.taskId] ?? EMPTY, item);
    const patch: Partial<ActivityStore> = { perTask: { ...perTask, [item.taskId]: next } };
    if ((item.kind === 'write' || item.kind === 'review') && item.paths.length > 0) {
      patch.pulses = [
        ...get().pulses.slice(-(MAX_PULSES - 1)),
        { taskId: item.taskId, paths: item.paths, at: Date.now() },
      ];
    }
    set(patch as never);
  },

  /** Backfill from the persisted log (dashboard reload / app restart). */
  async hydrate(taskId) {
    if (get().perTask[taskId]) return;
    const res = await rpcResult('task.activity', { taskId, tail: 30 });
    if (!res.ok) return;
    let acc = EMPTY;
    for (const item of res.data.items) acc = fold(acc, item);
    // A run that died with the app must not show a stale “running” action.
    if (acc.current && Date.now() - Date.parse(acc.current.at) > 10 * 60 * 1000) {
      acc = { ...acc, current: null };
    }
    set({ perTask: { ...get().perTask, [taskId]: acc } });
  },
}));

/** Current one-line action for a task card, or null. */
export function currentActionLine(activity: TaskActivity | undefined): ActivityItem | null {
  if (!activity) return null;
  return activity.current ?? activity.lastAction ?? activity.last;
}
