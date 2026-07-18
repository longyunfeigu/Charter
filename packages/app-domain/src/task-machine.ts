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
  'ACCEPTED',
  'ROLLED_BACK',
  'INTERRUPTED',
  'FAILED',
  'CANCELLED',
  'ARCHIVED',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** Allowed transitions exactly per spec §6.1 (state → set of next states). */
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['EXPLORING', 'CANCELLED'],
  EXPLORING: ['PLANNING', 'IN_PROGRESS', 'FAILED', 'INTERRUPTED'],
  PLANNING: ['AWAITING_PLAN_APPROVAL', 'IN_PROGRESS', 'FAILED', 'INTERRUPTED'],
  AWAITING_PLAN_APPROVAL: ['IN_PROGRESS', 'CANCELLED', 'INTERRUPTED'],
  IN_PROGRESS: [
    'AWAITING_PERMISSION',
    'VERIFYING',
    'REVIEW_READY',
    'FAILED',
    'INTERRUPTED',
    'EXPLORING',
    'PLANNING',
  ],
  AWAITING_PERMISSION: ['IN_PROGRESS', 'INTERRUPTED', 'FAILED'],
  VERIFYING: ['IN_PROGRESS', 'REVIEW_READY', 'FAILED', 'INTERRUPTED'],
  REVIEW_READY: ['IN_PROGRESS', 'ACCEPTED', 'ROLLED_BACK'],
  // ADR-0012: accepting is not a commit — while snapshots exist the user can
  // still restore the pre-task state after accept (esp. full-auto tasks).
  ACCEPTED: ['ARCHIVED', 'ROLLED_BACK'],
  ROLLED_BACK: ['ARCHIVED'],
  INTERRUPTED: ['READY', 'IN_PROGRESS', 'REVIEW_READY', 'ROLLED_BACK'],
  FAILED: ['IN_PROGRESS', 'REVIEW_READY', 'ROLLED_BACK'],
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
