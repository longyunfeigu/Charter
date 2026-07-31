export const ASSIGNMENT_STATES = [
  'PENDING',
  'ACTIVE',
  'WAITING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'ORPHANED',
] as const;

export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

export interface Assignment {
  id: string;
  missionId: string;
  taskId: string;
  supervisorAssignmentId: string | null;
  assigneePrincipalId: string;
  activeAttemptId: string | null;
  state: AssignmentState;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
