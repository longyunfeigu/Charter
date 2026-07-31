import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';

export type MissionSection = 'work' | 'activity' | 'results';
export type MissionTone = 'active' | 'waiting' | 'attention' | 'success' | 'neutral';

export const TERMINAL_MISSION_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

const MISSION_COPY: Record<
  MissionSnapshotDto['mission']['state'],
  { label: string; description: string; tone: MissionTone }
> = {
  PLANNING: {
    label: 'Planning',
    description: 'The lead is shaping the work and deciding what to delegate.',
    tone: 'waiting',
  },
  RUNNING: {
    label: 'In progress',
    description: 'The team is working through the plan.',
    tone: 'active',
  },
  BLOCKED: {
    label: 'Needs attention',
    description: 'The team cannot move forward without a decision or recovery action.',
    tone: 'attention',
  },
  VERIFYING: {
    label: 'Ready to review',
    description: 'The planned work is complete and waiting for your acceptance.',
    tone: 'waiting',
  },
  COMPLETED: {
    label: 'Accepted',
    description: 'You accepted the Mission and its recorded evidence.',
    tone: 'success',
  },
  FAILED: {
    label: 'Stopped',
    description: 'The Mission ended without satisfying its goal.',
    tone: 'attention',
  },
  CANCELLED: {
    label: 'Cancelled',
    description: 'The Mission was cancelled.',
    tone: 'neutral',
  },
};

const TASK_COPY: Record<
  MissionSnapshotDto['tasks'][number]['state'],
  { label: string; tone: MissionTone }
> = {
  PROPOSED: { label: 'Proposed', tone: 'neutral' },
  BLOCKED: { label: 'Waiting on work', tone: 'waiting' },
  READY: { label: 'Ready', tone: 'waiting' },
  RUNNING: { label: 'In progress', tone: 'active' },
  VERIFYING: { label: 'Checking', tone: 'waiting' },
  COMPLETED: { label: 'Done', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'attention' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export function missionStateCopy(state: MissionSnapshotDto['mission']['state']) {
  return MISSION_COPY[state];
}

export function taskStateCopy(
  state: MissionSnapshotDto['tasks'][number]['state'],
  assignmentState?: MissionSnapshotDto['assignments'][number]['state'],
) {
  if (assignmentState === 'PAUSED') return { label: 'Paused', tone: 'waiting' as const };
  if (assignmentState === 'WAITING') return { label: 'Waiting', tone: 'waiting' as const };
  return TASK_COPY[state];
}

export function threadKey(message: MissionSnapshotDto['messages'][number]): string {
  return message.threadId ?? message.id;
}

/** Questions and escalations remain actionable until a later answer is recorded
 * on their thread. This survives restart without adding renderer-only state. */
export function unresolvedDecisionMessages(
  snapshot: MissionSnapshotDto,
): MissionSnapshotDto['messages'] {
  const answers = new Set(
    snapshot.messages
      .filter((message) => message.type === 'answer' && message.threadId)
      .map((message) => message.threadId!),
  );
  return snapshot.messages.filter(
    (message) =>
      (message.type === 'question' || message.type === 'escalation') &&
      !message.suppressedAt &&
      !answers.has(threadKey(message)),
  );
}

export function latestProgressForAssignment(
  snapshot: MissionSnapshotDto,
  assignmentId: string,
): MissionSnapshotDto['messages'][number] | null {
  return (
    snapshot.messages
      .filter(
        (message) =>
          message.fromAssignmentId === assignmentId &&
          (message.type === 'progress' || message.type === 'completion'),
      )
      .at(-1) ?? null
  );
}

export function missionSummary(snapshot: MissionSnapshotDto): {
  total: number;
  completed: number;
  active: number;
  waiting: number;
  failed: number;
  paused: number;
  attention: number;
  percent: number;
  decisions: ReturnType<typeof unresolvedDecisionMessages>;
} {
  const completed = snapshot.tasks.filter((task) => task.state === 'COMPLETED').length;
  const active = snapshot.assignments.filter((assignment) => assignment.state === 'ACTIVE').length;
  const waiting = snapshot.assignments.filter((assignment) =>
    ['PENDING', 'WAITING'].includes(assignment.state),
  ).length;
  const failed = snapshot.assignments.filter((assignment) =>
    ['FAILED', 'ORPHANED'].includes(assignment.state),
  ).length;
  const paused = snapshot.assignments.filter((assignment) => assignment.state === 'PAUSED').length;
  const decisions = unresolvedDecisionMessages(snapshot);
  const total = snapshot.tasks.length;
  return {
    total,
    completed,
    active,
    waiting,
    failed,
    paused,
    attention: decisions.length + failed,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    decisions,
  };
}

export function assignmentForTask(
  snapshot: MissionSnapshotDto,
  taskId: string,
): MissionSnapshotDto['assignments'][number] | null {
  const candidates = snapshot.assignments.filter((assignment) => assignment.taskId === taskId);
  return (
    candidates.find((assignment) =>
      ['ACTIVE', 'WAITING', 'PAUSED', 'PENDING'].includes(assignment.state),
    ) ??
    candidates.at(-1) ??
    null
  );
}

export function principalName(snapshot: MissionSnapshotDto, assignmentId: string | null): string {
  if (!assignmentId) return 'Charter';
  const assignment = snapshot.assignments.find((item) => item.id === assignmentId);
  const principal = snapshot.principals.find((item) => item.id === assignment?.assigneePrincipalId);
  return principal?.displayName ?? 'Agent';
}

export function formatMissionTime(value: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(value));
  if (elapsed < 60_000) return 'now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
