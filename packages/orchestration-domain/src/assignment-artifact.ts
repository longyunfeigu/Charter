export interface AssignmentArtifact {
  id: string;
  missionId: string;
  assignmentId: string;
  attemptId: string | null;
  kind: string;
  label: string;
  reference: Record<string, unknown>;
  createdAt: string;
}
