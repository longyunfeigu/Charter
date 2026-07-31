import { productError, ProductFailure } from '@pi-ide/foundation';
import type { AssignmentState } from './assignment.js';
import type { ExecutionAttemptState } from './execution-attempt.js';
import type { MissionState } from './mission.js';
import type { MissionTaskState } from './mission-task.js';

const MISSION_TRANSITIONS: Record<MissionState, readonly MissionState[]> = {
  PLANNING: ['RUNNING', 'CANCELLED'],
  RUNNING: ['BLOCKED', 'VERIFYING', 'FAILED', 'CANCELLED'],
  BLOCKED: ['RUNNING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['RUNNING', 'CANCELLED'],
  CANCELLED: [],
};

const TASK_TRANSITIONS: Record<MissionTaskState, readonly MissionTaskState[]> = {
  PROPOSED: ['BLOCKED', 'READY', 'CANCELLED'],
  BLOCKED: ['READY', 'CANCELLED', 'FAILED'],
  READY: ['RUNNING', 'CANCELLED'],
  RUNNING: ['BLOCKED', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  VERIFYING: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['READY', 'CANCELLED'],
  CANCELLED: [],
};

const ASSIGNMENT_TRANSITIONS: Record<AssignmentState, readonly AssignmentState[]> = {
  PENDING: ['ACTIVE', 'CANCELLED', 'FAILED'],
  ACTIVE: ['WAITING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'ORPHANED'],
  WAITING: ['ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'ORPHANED'],
  PAUSED: ['ACTIVE', 'WAITING', 'CANCELLED', 'ORPHANED'],
  COMPLETED: [],
  FAILED: ['PENDING', 'ACTIVE', 'CANCELLED'],
  CANCELLED: [],
  ORPHANED: ['ACTIVE', 'PAUSED', 'FAILED', 'CANCELLED'],
};

const ATTEMPT_TRANSITIONS: Record<ExecutionAttemptState, readonly ExecutionAttemptState[]> = {
  PLANNED: ['STARTING', 'CANCELLED'],
  STARTING: ['RUNNING', 'FAILED', 'TIMED_OUT', 'CANCELLED'],
  RUNNING: ['WAITING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'STALE'],
  WAITING: ['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'STALE'],
  SUCCEEDED: [],
  FAILED: [],
  TIMED_OUT: [],
  CANCELLED: [],
  STALE: [],
};

function assertAllowed<T extends string>(
  kind: string,
  transitions: Record<T, readonly T[]>,
  from: T,
  to: T,
): void {
  if (transitions[from].includes(to)) return;
  throw new ProductFailure(
    productError('ORCHESTRATION_ILLEGAL_TRANSITION', {
      userMessage: `${kind} cannot move from ${from} to ${to}.`,
      context: { kind, from, to },
    }),
  );
}

export const canTransitionMission = (from: MissionState, to: MissionState): boolean =>
  MISSION_TRANSITIONS[from].includes(to);
export const canTransitionMissionTask = (from: MissionTaskState, to: MissionTaskState): boolean =>
  TASK_TRANSITIONS[from].includes(to);
export const canTransitionAssignment = (from: AssignmentState, to: AssignmentState): boolean =>
  ASSIGNMENT_TRANSITIONS[from].includes(to);
export const canTransitionAttempt = (
  from: ExecutionAttemptState,
  to: ExecutionAttemptState,
): boolean => ATTEMPT_TRANSITIONS[from].includes(to);

export const assertMissionTransition = (from: MissionState, to: MissionState): void =>
  assertAllowed('Mission', MISSION_TRANSITIONS, from, to);
export const assertMissionTaskTransition = (from: MissionTaskState, to: MissionTaskState): void =>
  assertAllowed('Mission task', TASK_TRANSITIONS, from, to);
export const assertAssignmentTransition = (from: AssignmentState, to: AssignmentState): void =>
  assertAllowed('Assignment', ASSIGNMENT_TRANSITIONS, from, to);
export const assertAttemptTransition = (
  from: ExecutionAttemptState,
  to: ExecutionAttemptState,
): void => assertAllowed('Execution attempt', ATTEMPT_TRANSITIONS, from, to);
