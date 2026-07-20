import type { AgentMode } from '@pi-ide/agent-contract';
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
    // ADR-0032: the settled conversation — alive, waiting for the next message.
    IDLE: { label: 'Settled — reply to continue', short: 'Idle', tone: 'ok' },
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

/** ADR-0009 light completion: zero net changes is an answer (ADR-0032: such
 * turns settle straight to IDLE; REVIEW_READY covers historic rows). */
export function isAnswered(task: { state: string; changedFiles?: number | null }): boolean {
  return (task.state === 'IDLE' || task.state === 'REVIEW_READY') && task.changedFiles === 0;
}

/**
 * Cleanup affordance: which Sessions may be archived from the UI (ADR-0032:
 * archive is the only close). Running/deciding turns never offer it — stop or
 * decide first. An unsettled REVIEW_READY turn may archive: the changes keep
 * their current state (worktree Sessions merge back at archive time).
 */
export function canArchiveTask(task: { state: string; changedFiles?: number | null }): boolean {
  return [
    'IDLE',
    'REVIEW_READY',
    'ACCEPTED',
    'ROLLED_BACK',
    'CANCELLED',
    'FAILED',
    'INTERRUPTED',
  ].includes(task.state);
}

/** ADR-0023: task states whose work is settled — the rail's History bucket. */
export const SETTLED_TASK_STATES: ReadonlySet<string> = new Set([
  'ACCEPTED',
  'ROLLED_BACK',
  'CANCELLED',
]);

/** Minimal task shape the History/resume predicates need. */
type ExternalishTask = {
  state: string;
  changedFiles?: number | null;
  external?: { cli: string; status: 'active' | 'ended' } | null;
};

/**
 * History membership for a task row: the session is over AND nothing needs a
 * decision. A live external process never lands here whatever the task state
 * says, and rows revive out of History automatically — grouping is
 * state-derived, so a resume flips them straight back into their project
 * group. Ended external sessions with unreviewed changes stay out (History
 * never hides something that still wants a decision).
 */
export function isHistoryTask(task: ExternalishTask): boolean {
  if (task.external) {
    return (
      task.external.status === 'ended' && (SETTLED_TASK_STATES.has(task.state) || isAnswered(task))
    );
  }
  return SETTLED_TASK_STATES.has(task.state);
}

/**
 * States an ended external session can be revived from. ADR-0032: IDLE (a
 * settled, live conversation) and the unsettled trio resume the SAME task;
 * historic terminal rows (pre-migration) continue as a NEW task on a fresh
 * entry snapshot.
 */
const EXTERNAL_RESUMABLE_STATES = new Set([
  'REVIEW_READY',
  'IDLE',
  'INTERRUPTED',
  'FAILED',
  ...SETTLED_TASK_STATES,
]);

export function canResumeExternal(task: ExternalishTask): boolean {
  return (
    task.external != null &&
    task.external.status === 'ended' &&
    (task.external.cli === 'claude' || task.external.cli === 'codex') &&
    EXTERNAL_RESUMABLE_STATES.has(task.state)
  );
}

/** Attention = the amber Inbox: states that block on the user (ADR-0009:
 * zero-change "Answered" tasks are excluded — they ask for nothing). */
export const ATTENTION_STATES = [
  'AWAITING_PERMISSION',
  'AWAITING_PLAN_APPROVAL',
  'REVIEW_READY',
  'INTERRUPTED',
  'FAILED',
];

export function needsAttention(task: { state: string; changedFiles?: number | null }): boolean {
  return ATTENTION_STATES.includes(task.state) && !isAnswered(task);
}

/** Presentation meta for a task — the only place the "Answered" veneer exists. */
export function presentedMeta(task: {
  state: string;
  changedFiles?: number | null;
  external?: unknown;
}): {
  label: string;
  short: string;
  tone: StateTone;
} {
  if (isAnswered(task)) {
    // An external CLI reaching this state means the process exited — say so.
    // "Answered" describes Pi runs, not a session the user (or the CLI) closed.
    if (task.external) {
      return { label: 'Session ended — nothing changed on disk', short: 'Ended', tone: 'idle' };
    }
    return { label: 'Answered — nothing changed on disk', short: 'Answered', tone: 'ok' };
  }
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
export const MODE_META: Array<{
  id: AgentMode;
  label: string;
  /** Compact segment label — the full label lives in the hint line/tooltips. */
  seg: string;
  hint: string;
  danger?: boolean;
}> = [
  {
    id: 'ask',
    label: 'Read-only',
    seg: 'Read',
    hint: 'Answers questions; never writes or runs anything',
  },
  {
    id: 'edit',
    label: 'Approve changes',
    seg: 'Approve',
    hint: 'Plans first; every write/command asks you',
  },
  {
    id: 'auto',
    label: 'Auto · pause on risk',
    seg: 'Auto',
    hint: 'Low-risk actions run; risky ones ask',
  },
  {
    id: 'full',
    label: 'Full auto',
    seg: 'Full',
    hint: 'Nothing asks and the result is applied automatically — forbidden actions stay blocked, verification failures pause, and you can roll back afterwards',
    danger: true,
  },
];

export function modeLabel(mode: string): string {
  return MODE_META.find((m) => m.id === mode)?.label ?? mode;
}

/** Reasoning-effort levels (agent-contract ThinkingLevel) — composer + settings. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevelId = (typeof THINKING_LEVELS)[number];

/**
 * Clamp an effort level to a model's supported list (nearest neighbour, higher
 * first — mirrors the runtime's own clamp so the composer never promises a
 * level the provider call would silently downgrade).
 */
export function clampThinkingLevelTo(
  supported: readonly string[],
  level: ThinkingLevelId,
): ThinkingLevelId {
  if (supported.includes(level)) return level;
  const index = THINKING_LEVELS.indexOf(level);
  for (let i = index + 1; i < THINKING_LEVELS.length; i++) {
    if (supported.includes(THINKING_LEVELS[i]!)) return THINKING_LEVELS[i]!;
  }
  for (let i = index - 1; i >= 0; i--) {
    if (supported.includes(THINKING_LEVELS[i]!)) return THINKING_LEVELS[i]!;
  }
  return (supported[0] as ThinkingLevelId) ?? 'off';
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
