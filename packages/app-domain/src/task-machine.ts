import { productError, ProductFailure } from '@pi-ide/foundation';

export const TASK_STATES = [
  'DRAFT',
  'READY',
  'EXPLORING',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'IN_PROGRESS',
  'AWAITING_PERMISSION',
  'VERIFYING',
  'REVIEW_READY',
  // ADR-0032: the turn is settled and the Session is a live conversation
  // awaiting the next message. ACCEPTED/ROLLED_BACK no longer occur as
  // resting states for new work (they survive for historic rows/events);
  // ARCHIVED is the only terminal.
  'IDLE',
  'ACCEPTED',
  'ROLLED_BACK',
  'INTERRUPTED',
  'FAILED',
  'CANCELLED',
  'ARCHIVED',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** Allowed transitions per spec §6.1 as amended by ADR-0032 (session-as-
 * conversation): settlement transitions land on IDLE, the conversation's
 * resting state; ARCHIVED is the only terminal. */
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['EXPLORING', 'CANCELLED'],
  EXPLORING: ['PLANNING', 'IN_PROGRESS', 'FAILED', 'INTERRUPTED'],
  PLANNING: ['AWAITING_PLAN_APPROVAL', 'IN_PROGRESS', 'FAILED', 'INTERRUPTED'],
  // Plan rejection settles the turn back to the conversation (ADR-0032);
  // CANCELLED survives for historic rows.
  AWAITING_PLAN_APPROVAL: ['IN_PROGRESS', 'IDLE', 'CANCELLED', 'INTERRUPTED'],
  IN_PROGRESS: [
    'AWAITING_PERMISSION',
    'VERIFYING',
    'REVIEW_READY',
    // Zero-change turns settle as answered straight to the conversation.
    'IDLE',
    'FAILED',
    'INTERRUPTED',
    'EXPLORING',
    'PLANNING',
  ],
  AWAITING_PERMISSION: ['IN_PROGRESS', 'INTERRUPTED', 'FAILED'],
  VERIFYING: ['IN_PROGRESS', 'REVIEW_READY', 'IDLE', 'FAILED', 'INTERRUPTED'],
  // Accept / roll back settle the turn; the Session stays a live conversation.
  REVIEW_READY: ['IN_PROGRESS', 'IDLE', 'ARCHIVED', 'ACCEPTED', 'ROLLED_BACK'],
  // The settled conversation: the next message starts a new run; archive is
  // the only close.
  IDLE: ['IN_PROGRESS', 'EXPLORING', 'ARCHIVED'],
  // Historic resting states (pre-ADR-0032 rows) keep their exits.
  ACCEPTED: ['ARCHIVED', 'ROLLED_BACK'],
  ROLLED_BACK: ['ARCHIVED'],
  INTERRUPTED: ['READY', 'IN_PROGRESS', 'REVIEW_READY', 'IDLE', 'ROLLED_BACK', 'ARCHIVED'],
  FAILED: ['IN_PROGRESS', 'REVIEW_READY', 'IDLE', 'ROLLED_BACK', 'ARCHIVED'],
  CANCELLED: ['ARCHIVED'],
  ARCHIVED: [],
};

const RUNNING_STATES: readonly TaskState[] = [
  'EXPLORING',
  'PLANNING',
  'IN_PROGRESS',
  'AWAITING_PERMISSION',
  'VERIFYING',
];

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new ProductFailure(
      productError('TASK_ILLEGAL_TRANSITION', {
        userMessage: `The task cannot move from ${from} to ${to}.`,
        context: { from, to },
      }),
    );
  }
}

export function isRunningState(state: TaskState): boolean {
  return RUNNING_STATES.includes(state);
}
