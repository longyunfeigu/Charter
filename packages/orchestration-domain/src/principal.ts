export type PrincipalKind = 'user' | 'managed_agent' | 'external_agent' | 'shell_agent' | 'system';

export type PrincipalState = 'active' | 'disconnected' | 'ended';

export interface OrchestrationPrincipal {
  id: string;
  kind: PrincipalKind;
  provider: string | null;
  externalIdentity: string | null;
  displayName: string;
  state: PrincipalState;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface OrchestrationCallerContext {
  principalId: string;
  runtimeSessionId: string;
  missionId: string | null;
  assignmentId: string | null;
  attemptId: string | null;
  origin: 'managed-run' | 'charter-terminal' | 'attached-cli' | 'user' | 'system';
}
