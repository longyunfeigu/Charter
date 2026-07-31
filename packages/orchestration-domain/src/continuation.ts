import type { AssignmentState } from './assignment.js';
import type { OrchestrationMessageType } from './orchestration-message.js';

export const CONTINUATION_STATES = [
  'ARMED',
  'READY',
  'DELIVERING',
  'DELIVERED',
  'CONSUMED',
  'CANCELLED',
] as const;

export type ContinuationState = (typeof CONTINUATION_STATES)[number];
export type ContinuationMode = 'all' | 'any';
export type ContinuationTargetKind = 'assignment_terminal' | 'message';

export const RESUME_INTENT_STATES = [
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'ACKNOWLEDGED',
  'CANCELLED',
] as const;

export type ResumeIntentState = (typeof RESUME_INTENT_STATES)[number];

export interface AssignmentTerminalContinuationCondition {
  kind: 'assignment_terminal';
  assignmentId: string;
  states?: AssignmentState[];
}

export interface MessageContinuationCondition {
  kind: 'message';
  fromAssignmentId?: string | null;
  types?: OrchestrationMessageType[];
  threadId?: string | null;
}

export type ContinuationCondition =
  AssignmentTerminalContinuationCondition | MessageContinuationCondition;

export interface OrchestrationContinuation {
  id: string;
  missionId: string;
  ownerAssignmentId: string;
  ownerAttemptId: string;
  mode: ContinuationMode;
  state: ContinuationState;
  reason: string;
  cursorSequence: number;
  deadlineAt: string | null;
  idempotencyKey: string;
  readyAt: string | null;
  deliveredAt: string | null;
  consumedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationContinuationTarget {
  id: string;
  continuationId: string;
  kind: ContinuationTargetKind;
  targetAssignmentId: string | null;
  fromAssignmentId: string | null;
  messageTypes: OrchestrationMessageType[] | null;
  threadId: string | null;
  terminalStates: AssignmentState[] | null;
  satisfiedBy: string | null;
  satisfiedPayload: Record<string, unknown> | null;
  satisfiedAt: string | null;
  createdAt: string;
}

export interface OrchestrationResumeIntent {
  id: string;
  continuationId: string;
  missionId: string;
  ownerAssignmentId: string;
  ownerAttemptId: string;
  runtimeSessionId: string | null;
  state: ResumeIntentState;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  availableAt: string;
  lastError: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContinuationBundle {
  continuation: OrchestrationContinuation;
  targets: OrchestrationContinuationTarget[];
  resumeIntent: OrchestrationResumeIntent | null;
}
