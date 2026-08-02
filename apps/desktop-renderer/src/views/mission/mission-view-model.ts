import type { ActionRequestDto, MissionSnapshotDto } from '@pi-ide/ipc-contracts';

export type MissionSection = 'work' | 'activity' | 'results';
export type MissionTone = 'active' | 'waiting' | 'attention' | 'success' | 'neutral';
export type MissionActivityFilter = 'all' | 'requests' | 'progress' | 'outcomes';

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
    label: 'Blocked',
    description: 'Work is blocked. Check team requests and Issues for the exact cause.',
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

export function openActionRequests(snapshot: MissionSnapshotDto) {
  return (snapshot.actionRequests ?? []).filter((request) => request.status === 'OPEN');
}

export function userActionRequests(snapshot: MissionSnapshotDto) {
  const userIds = new Set(
    snapshot.principals
      .filter((principal) => principal.kind === 'user')
      .map((principal) => principal.id),
  );
  userIds.add('user');
  return openActionRequests(snapshot).filter(
    (request) =>
      request.assignedToAssignmentId === null && userIds.has(request.assignedToPrincipalId),
  );
}

export function agentActionRequests(snapshot: MissionSnapshotDto) {
  const userRequestIds = new Set(userActionRequests(snapshot).map((request) => request.id));
  return openActionRequests(snapshot).filter((request) => !userRequestIds.has(request.id));
}

/** Resolve controls are explicit data. In particular, the UI never treats the
 * first option as a recommendation just because it happens to be first. */
export function actionOptionsFor(request: ActionRequestDto): ActionRequestDto['options'] {
  if (request.options.length > 0) return request.options;
  if (request.responseType === 'approval') {
    return [
      { id: 'approved', label: 'Approve' },
      { id: 'rejected', label: 'Reject' },
    ];
  }
  if (request.responseType === 'review') {
    return [
      { id: 'approved', label: 'Accept review' },
      { id: 'changes_requested', label: 'Request changes' },
    ];
  }
  if (request.responseType === 'recovery') {
    return [
      { id: 'retry', label: 'Retry' },
      { id: 'cancel', label: 'Cancel work', danger: true },
    ];
  }
  return [];
}

export function missionActivityMessages(
  snapshot: MissionSnapshotDto,
  filter: MissionActivityFilter,
): MissionSnapshotDto['messages'] {
  return snapshot.messages.filter((message) => {
    if (message.type === 'heartbeat') return false;
    if (filter === 'requests') return Boolean(message.actionRequestId);
    if (filter === 'progress') {
      return (
        !message.actionRequestId && ['assignment', 'progress', 'handoff'].includes(message.type)
      );
    }
    if (filter === 'outcomes') {
      return !message.actionRequestId && ['completion', 'cancellation'].includes(message.type);
    }
    return true;
  });
}

export function missionActivityCounts(
  snapshot: MissionSnapshotDto,
): Record<MissionActivityFilter, number> {
  return {
    all: missionActivityMessages(snapshot, 'all').length,
    requests: missionActivityMessages(snapshot, 'requests').length,
    progress: missionActivityMessages(snapshot, 'progress').length,
    outcomes: missionActivityMessages(snapshot, 'outcomes').length,
  };
}

export function openIncidents(snapshot: MissionSnapshotDto) {
  return (snapshot.incidents ?? []).filter(
    (incident) => !['RECOVERED', 'CLOSED'].includes(incident.state),
  );
}

/** Compatibility projection for graph/replay consumers. Human-attention edges
 * come only from explicit user Action Requests, never from message wording. */
export function unresolvedDecisionMessages(
  snapshot: MissionSnapshotDto,
): MissionSnapshotDto['messages'] {
  const openingIds = new Set(
    userActionRequests(snapshot)
      .map((request) => request.openingMessageId)
      .filter((id): id is string => Boolean(id)),
  );
  return snapshot.messages.filter((message) => openingIds.has(message.id) && !message.suppressedAt);
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
  agentActions: number;
  issues: number;
  percent: number;
  decisions: ReturnType<typeof unresolvedDecisionMessages>;
  humanActions: ReturnType<typeof userActionRequests>;
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
  const humanActions = userActionRequests(snapshot);
  const agentActions = agentActionRequests(snapshot);
  const issues = openIncidents(snapshot);
  const decisions = unresolvedDecisionMessages(snapshot);
  const total = snapshot.tasks.length;
  return {
    total,
    completed,
    active,
    waiting,
    failed,
    paused,
    attention: humanActions.length,
    agentActions: agentActions.length,
    issues: issues.length,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    decisions,
    humanActions,
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
