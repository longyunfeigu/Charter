import type { RuntimeKind } from './mission.js';

export const ATTEMPT_STATES = [
  'PLANNED',
  'STARTING',
  'RUNNING',
  'WAITING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'STALE',
] as const;

export type ExecutionAttemptState = (typeof ATTEMPT_STATES)[number];

export interface ExecutionAttempt {
  id: string;
  assignmentId: string;
  ordinal: number;
  requestedRuntime: RuntimeKind;
  requestedModel: string | null;
  runtimeSessionId: string | null;
  terminalId: string | null;
  state: ExecutionAttemptState;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  failureCode: string | null;
  failure: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
}

export const TERMINAL_ATTEMPT_STATES: readonly ExecutionAttemptState[] = [
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'STALE',
];

export function isTerminalAttemptState(state: ExecutionAttemptState): boolean {
  return TERMINAL_ATTEMPT_STATES.includes(state);
}
