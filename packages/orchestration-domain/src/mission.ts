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
  /** Soft-deleted Missions remain recoverable for the local retention window. */
  deletedAt?: string | null;
}

export interface MissionExecutionPolicy {
  inheritHostPermissions: true;
  controlScope: 'mission-wide' | 'hierarchical';
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

/** `managed`, `shell`, or an opaque external Agent id resolved at runtime. */
export type RuntimeKind = string;

export function defaultMissionExecutionPolicy(workspaceRoot: string): MissionExecutionPolicy {
  return {
    inheritHostPermissions: true,
    controlScope: 'hierarchical',
    workspaceRoot,
    toolPolicy: 'inherit',
    runtimeDefaults: { environment: {} },
    limits: { maxConcurrentAgents: null, maxTotalAgents: null },
  };
}
