import type { OrchestrationMessagePriority } from './orchestration-message.js';

export const ACTION_REQUEST_KINDS = [
  'information',
  'review',
  'approval',
  'choice',
  'input',
  'recovery',
  'escalation',
] as const;

export type ActionRequestKind = (typeof ACTION_REQUEST_KINDS)[number];
export type ActionRequestStatus = 'OPEN' | 'RESOLVED' | 'CANCELLED' | 'EXPIRED';
export type ActionRequestResponseType = 'text' | 'approval' | 'choice' | 'review' | 'recovery';
export type ActionRequestBlockingScope = 'none' | 'assignment' | 'task' | 'mission';

export interface ActionRequestOption {
  id: string;
  label: string;
  description?: string;
}

/** Explicit work that one principal asks another principal to perform.
 * User attention is derived only from OPEN requests whose assignee is a user. */
export interface OrchestrationActionRequest {
  id: string;
  missionId: string;
  conversationId: string;
  relatedTaskId: string | null;
  createdByPrincipalId: string;
  createdByAssignmentId: string | null;
  assignedToPrincipalId: string;
  assignedToAssignmentId: string | null;
  kind: ActionRequestKind;
  title: string;
  context: string;
  responseType: ActionRequestResponseType;
  options: ActionRequestOption[];
  recommendation: string | null;
  impact: string | null;
  priority: OrchestrationMessagePriority;
  blockingScope: ActionRequestBlockingScope;
  status: ActionRequestStatus;
  openingMessageId: string | null;
  idempotencyKey: string;
  dueAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationActionResolution {
  id: string;
  requestId: string;
  resolvedByPrincipalId: string;
  resolvedByAssignmentId: string | null;
  outcome: string;
  body: string;
  payload: Record<string, unknown> | null;
  rationale: string | null;
  idempotencyKey: string;
  createdAt: string;
}
