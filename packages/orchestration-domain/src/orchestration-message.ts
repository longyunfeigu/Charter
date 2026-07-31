export const ORCHESTRATION_MESSAGE_TYPES = [
  'assignment',
  'progress',
  'question',
  'answer',
  'escalation',
  'completion',
  'cancellation',
  'handoff',
  'heartbeat',
] as const;

export type OrchestrationMessageType = (typeof ORCHESTRATION_MESSAGE_TYPES)[number];
export type OrchestrationMessagePriority = 'normal' | 'high' | 'urgent';

export interface OrchestrationMessage {
  id: string;
  missionId: string;
  fromAssignmentId: string | null;
  toAssignmentId: string | null;
  threadId: string | null;
  attemptId: string | null;
  type: OrchestrationMessageType;
  priority: OrchestrationMessagePriority;
  subject: string;
  body: string;
  payload: Record<string, unknown> | null;
  sequence: number;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  suppressedAt: string | null;
  suppressionReason: string | null;
}
