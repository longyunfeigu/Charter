import { TaskStateSchema } from '@pi-ide/ipc-contracts';
import type { z } from 'zod';

export type TaskState = z.infer<typeof TaskStateSchema>;
export type StateTone = 'run' | 'warn' | 'ok' | 'err' | 'idle';

/**
 * PIVOT-023: the single user-facing vocabulary for the task lifecycle.
 * No raw enum is ever rendered — every surface (Home, Task Room, Editor agent
 * panel, notifications) reads labels from here.
 * - `label` — full sentence-style label ("Waiting for your approval")
 * - `short` — chip-sized label ("Plan ready")
 * - `tone`  — semantic color family
 */
export const TASK_STATE_META: Record<TaskState, { label: string; short: string; tone: StateTone }> =
  {
    DRAFT: { label: 'Draft', short: 'Draft', tone: 'idle' },
    READY: { label: 'Queued', short: 'Queued', tone: 'idle' },
    EXPLORING: { label: 'Exploring the codebase', short: 'Exploring', tone: 'run' },
    PLANNING: { label: 'Writing a plan', short: 'Planning', tone: 'run' },
    AWAITING_PLAN_APPROVAL: {
      label: 'Waiting for your approval',
      short: 'Plan ready',
      tone: 'warn',
    },
    IN_PROGRESS: { label: 'Working', short: 'Working', tone: 'run' },
    AWAITING_PERMISSION: { label: 'Needs your permission', short: 'Permission', tone: 'warn' },
    VERIFYING: { label: 'Running verification', short: 'Verifying', tone: 'run' },
    REVIEW_READY: { label: 'Ready to review', short: 'Review', tone: 'ok' },
    ACCEPTED: { label: 'Accepted', short: 'Accepted', tone: 'ok' },
    ROLLED_BACK: { label: 'Rolled back', short: 'Rolled back', tone: 'idle' },
    INTERRUPTED: { label: 'Interrupted', short: 'Interrupted', tone: 'warn' },
    FAILED: { label: 'Failed', short: 'Failed', tone: 'err' },
    CANCELLED: { label: 'Cancelled', short: 'Cancelled', tone: 'idle' },
    ARCHIVED: { label: 'Archived', short: 'Archived', tone: 'idle' },
  };

export function stateLabel(state: string): string {
  return TASK_STATE_META[state as TaskState]?.label ?? state;
}

/** ADR-0009 light completion: REVIEW_READY with zero net changes is an answer. */
export function isAnswered(task: { state: string; changedFiles?: number | null }): boolean {
  return task.state === 'REVIEW_READY' && task.changedFiles === 0;
}

/** Presentation meta for a task — the only place the "Answered" veneer exists. */
export function presentedMeta(task: { state: string; changedFiles?: number | null }): {
  label: string;
  short: string;
  tone: StateTone;
} {
  if (isAnswered(task))
    return { label: 'Answered — nothing changed on disk', short: 'Answered', tone: 'ok' };
  return (
    TASK_STATE_META[task.state as TaskState] ?? {
      label: task.state,
      short: task.state,
      tone: 'idle',
    }
  );
}

export function stateShort(state: string): string {
  return TASK_STATE_META[state as TaskState]?.short ?? state;
}

export function stateTone(state: string): StateTone {
  return TASK_STATE_META[state as TaskState]?.tone ?? 'idle';
}

export const TONE_COLOR: Record<StateTone, string> = {
  run: 'var(--info)',
  warn: 'var(--warning)',
  ok: 'var(--success)',
  err: 'var(--danger)',
  idle: 'var(--fg-muted)',
};

/** Trust levels (approval modes) — shared by Home composer and task headers. */
export const MODE_META: Array<{ id: 'ask' | 'edit' | 'auto'; label: string; hint: string }> = [
  { id: 'ask', label: 'Read-only', hint: 'Answers questions; never writes or runs anything' },
  { id: 'edit', label: 'Approve changes', hint: 'Plans first; every write/command asks you' },
  { id: 'auto', label: 'Auto · pause on risk', hint: 'Low-risk actions run; risky ones ask' },
];

export function modeLabel(mode: string): string {
  return MODE_META.find((m) => m.id === mode)?.label ?? mode;
}

/** Humane action verbs for tool calls (fallback prettifies snake_case). */
const TOOL_VERBS: Record<string, string> = {
  read_file: 'Read file',
  list_directory: 'Listed directory',
  search_text: 'Searched the project',
  git_status: 'Checked git status',
  git_diff: 'Read the git diff',
  create_file: 'Created file',
  apply_patch: 'Edited file',
  delete_file: 'Deleted file',
  rename_file: 'Renamed file',
  run_command: 'Ran command',
  run_verification: 'Ran verification',
  propose_plan: 'Proposed a plan',
  update_plan: 'Updated the plan',
  ask_user: 'Asked you a question',
};

export function toolVerb(name: string): string {
  const known = TOOL_VERBS[name];
  if (known) return known;
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Humane tool lifecycle word (never the raw enum). */
export function toolStateWord(state: string): string {
  switch (state) {
    case 'SUCCEEDED':
      return '';
    case 'FAILED':
      return 'failed';
    case 'DENIED':
      return 'denied';
    case 'CANCELLED':
      return 'cancelled';
    case 'TIMED_OUT':
      return 'timed out';
    default:
      return 'running…';
  }
}
