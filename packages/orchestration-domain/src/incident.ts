export type OrchestrationIncidentState =
  'OPEN' | 'RECOVERING' | 'RECOVERED' | 'NEEDS_ACTION' | 'CLOSED';
export type OrchestrationIncidentSeverity = 'warning' | 'error' | 'critical';

/** A runtime or coordination problem. Incidents are shown under Issues and do
 * not become user work unless linked to a user-assigned ActionRequest. */
export interface OrchestrationIncident {
  id: string;
  missionId: string;
  assignmentId: string | null;
  attemptId: string | null;
  kind: string;
  severity: OrchestrationIncidentSeverity;
  state: OrchestrationIncidentState;
  summary: string;
  detail: Record<string, unknown> | null;
  automaticAttempts: number;
  actionRequestId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}
