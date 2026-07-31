export const MISSION_TASK_STATES = [
  'PROPOSED',
  'BLOCKED',
  'READY',
  'RUNNING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type MissionTaskState = (typeof MISSION_TASK_STATES)[number];
export type AssignmentWorkMode = 'read-only' | 'isolated-write' | 'shared-write';

export interface MissionTask {
  id: string;
  missionId: string;
  parentTaskId: string | null;
  createdByAssignmentId: string | null;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  expectedArtifacts: string[];
  workMode: AssignmentWorkMode;
  writeScope: string[] | null;
  state: MissionTaskState;
  result: Record<string, unknown> | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
}
