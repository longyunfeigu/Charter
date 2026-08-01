export type OrchestrationConversationState = 'OPEN' | 'ARCHIVED';

/** A durable collaboration stream. A thread is presentation metadata inside a
 * conversation; it is not, by itself, a request for somebody to act. */
export interface OrchestrationConversation {
  id: string;
  missionId: string;
  topic: string;
  createdByPrincipalId: string | null;
  state: OrchestrationConversationState;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationConversationParticipant {
  conversationId: string;
  principalId: string;
  assignmentId: string | null;
  joinedAt: string;
}
