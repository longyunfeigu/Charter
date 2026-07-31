export const MISSION_STATES = [
  'PLANNING',
  'RUNNING',
  'BLOCKED',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;

export type MissionState = (typeof MISSION_STATES)[number];

export interface Mission {
  id: string;
  workspaceId: string;
  originConversationTaskId: string | null;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  executionPolicy: MissionExecutionPolicy;
  state: MissionState;
  leadAssignmentId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface MissionExecutionPolicy {
  inheritHostPermissions: true;
  controlScope: 'mission-wide';
  workspaceRoot: string;
  toolPolicy: 'inherit';
  runtimeDefaults: {
    environment: Record<string, string>;
    preferredRuntime?: RuntimeKind;
    preferredModel?: string;
  };
  limits: {
    maxConcurrentAgents: number | null;
    maxTotalAgents: number | null;
  };
}

export type RuntimeKind = 'managed' | 'claude' | 'codex' | 'shell';

export function defaultMissionExecutionPolicy(workspaceRoot: string): MissionExecutionPolicy {
  return {
    inheritHostPermissions: true,
    controlScope: 'mission-wide',
    workspaceRoot,
    toolPolicy: 'inherit',
    runtimeDefaults: { environment: {} },
    limits: { maxConcurrentAgents: null, maxTotalAgents: null },
  };
}
