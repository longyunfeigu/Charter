import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import {
  agentActionRequests,
  assignmentForTask,
  taskStateCopy,
  unresolvedDecisionMessages,
  type MissionTone,
} from './mission-view-model.js';

export const MISSION_GRAPH_NODE_WIDTH = 236;
export const MISSION_GRAPH_NODE_HEIGHT = 94;
export const MISSION_GRAPH_COLUMN_GAP = 92;
export const MISSION_GRAPH_ROW_GAP = 36;

export type MissionGraphEdgeKind = 'dependency' | 'delegation' | 'communication' | 'human';
export type MissionGraphCoverage = 'tracked' | 'partial' | 'external' | 'disconnected';
export type MissionGraphFilter = 'all' | 'active' | 'attention';

export interface MissionGraphNode {
  id: string;
  task: MissionSnapshotDto['tasks'][number];
  assignment: MissionSnapshotDto['assignments'][number] | null;
  principal: MissionSnapshotDto['principals'][number] | null;
  attempt: MissionSnapshotDto['attempts'][number] | null;
  x: number;
  y: number;
  layer: number;
  state: { label: string; tone: MissionTone };
  coverage: MissionGraphCoverage;
  duration: string;
  attemptCount: number;
  artifactCount: number;
  delegatedCount: number;
  blockedCount: number;
  blockedByFailure: boolean;
  critical: boolean;
}

export interface MissionGraphEdge {
  id: string;
  kind: MissionGraphEdgeKind;
  sourceId: string;
  targetId: string;
  messageIds: string[];
  count: number;
  bidirectional: boolean;
  pending: boolean;
  failed: boolean;
  urgent: boolean;
  label: string;
}

export interface MissionGraphTimelineEvent {
  id: string;
  at: number;
  label: string;
  kind: 'mission' | 'task' | 'attempt' | 'message' | 'artifact';
  taskId: string | null;
  messageId: string | null;
}

export interface MissionGraphProjection {
  nodes: MissionGraphNode[];
  edges: MissionGraphEdge[];
  width: number;
  height: number;
  showHuman: boolean;
  humanX: number;
  humanY: number;
  humanAttention: number;
  visibleTaskIds: Set<string>;
  isReplay: boolean;
}

export interface MissionGraphProjectionOptions {
  at?: number | null;
  search?: string;
  filter?: MissionGraphFilter;
  focusTaskId?: string | null;
  collapsedTaskIds?: ReadonlySet<string>;
}

const timestamp = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function formatDuration(startedAt: string | null | undefined, endedAt: string | null | undefined) {
  const start = timestamp(startedAt);
  if (start === null) return 'Not started';
  const end = timestamp(endedAt) ?? Date.now();
  const elapsed = Math.max(0, end - start);
  if (elapsed < 60_000) return '<1m';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  return `${Math.floor(elapsed / 3_600_000)}h ${Math.floor((elapsed % 3_600_000) / 60_000)}m`;
}

function taskStateAt(
  snapshot: MissionSnapshotDto,
  task: MissionSnapshotDto['tasks'][number],
  assignment: MissionSnapshotDto['assignments'][number] | null,
  attempts: MissionSnapshotDto['attempts'],
  at: number | null,
): { label: string; tone: MissionTone } {
  if (at === null) return taskStateCopy(task.state, assignment?.state);

  const candidates = attempts
    .filter((attempt) => {
      const start = timestamp(attempt.startedAt);
      return start === null || start <= at;
    })
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const attempt = candidates.at(-1);
  const endedAt = timestamp(attempt?.endedAt);
  if (attempt && endedAt !== null && endedAt <= at) {
    if (attempt.state === 'SUCCEEDED') return { label: 'Done', tone: 'success' };
    if (['FAILED', 'TIMED_OUT'].includes(attempt.state)) {
      return { label: attempt.state === 'TIMED_OUT' ? 'Timed out' : 'Failed', tone: 'attention' };
    }
    if (attempt.state === 'CANCELLED') return { label: 'Cancelled', tone: 'neutral' };
    if (attempt.state === 'STALE') return { label: 'Disconnected', tone: 'attention' };
  }
  const startedAt = timestamp(attempt?.startedAt);
  if (attempt && startedAt !== null && startedAt <= at && (endedAt === null || endedAt > at)) {
    if (attempt.state === 'WAITING') return { label: 'Waiting', tone: 'waiting' };
    return { label: 'In progress', tone: 'active' };
  }

  const dependencies = snapshot.dependencies.filter((edge) => edge.taskId === task.id);
  return dependencies.length > 0
    ? { label: 'Waiting on work', tone: 'waiting' }
    : { label: 'Ready', tone: 'waiting' };
}

function coverageFor(
  assignment: MissionSnapshotDto['assignments'][number] | null,
  principal: MissionSnapshotDto['principals'][number] | null,
  attempt: MissionSnapshotDto['attempts'][number] | null,
  runtime: NonNullable<MissionSnapshotDto['runtimeSessions']>[number] | null,
): MissionGraphCoverage {
  const terminalAssignment =
    assignment && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(assignment.state);
  if (terminalAssignment) {
    if (principal?.kind === 'external_agent') return 'external';
    if (attempt?.requestedRuntime === 'managed' || runtime) return 'tracked';
  }
  if (
    principal?.state === 'disconnected' ||
    assignment?.state === 'ORPHANED' ||
    runtime?.state === 'DISCONNECTED'
  ) {
    return 'disconnected';
  }
  if (principal?.kind === 'external_agent') return 'external';
  if (attempt?.requestedRuntime === 'managed') return 'tracked';
  if (attempt?.runtimeSessionId && !runtime) return 'partial';
  return 'tracked';
}

function structuralPredecessors(
  taskId: string,
  tasksById: ReadonlyMap<string, MissionSnapshotDto['tasks'][number]>,
  dependencies: readonly MissionSnapshotDto['dependencies'][number][],
): string[] {
  const explicit = dependencies
    .filter((edge) => edge.taskId === taskId && tasksById.has(edge.dependsOnTaskId))
    .map((edge) => edge.dependsOnTaskId);
  if (explicit.length > 0) return explicit;
  const parent = tasksById.get(taskId)?.parentTaskId;
  return parent && tasksById.has(parent) ? [parent] : [];
}

function graphContext(
  seedIds: ReadonlySet<string>,
  tasks: readonly MissionSnapshotDto['tasks'][number][],
  dependencies: readonly MissionSnapshotDto['dependencies'][number][],
): Set<string> {
  const context = new Set(seedIds);
  const children = new Map<string, string[]>();
  const linked = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parentTaskId)
      children.set(task.parentTaskId, [...(children.get(task.parentTaskId) ?? []), task.id]);
  }
  for (const edge of dependencies) {
    linked.set(edge.taskId, [...(linked.get(edge.taskId) ?? []), edge.dependsOnTaskId]);
    linked.set(edge.dependsOnTaskId, [...(linked.get(edge.dependsOnTaskId) ?? []), edge.taskId]);
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const pending = [...seedIds];
  while (pending.length > 0) {
    const id = pending.pop()!;
    const parent = byId.get(id)?.parentTaskId;
    for (const related of [
      ...(children.get(id) ?? []),
      ...(linked.get(id) ?? []),
      ...(parent ? [parent] : []),
    ]) {
      if (context.has(related)) continue;
      context.add(related);
      pending.push(related);
    }
  }
  return context;
}

function descendantsOf(
  taskId: string,
  tasks: readonly MissionSnapshotDto['tasks'][number][],
): Set<string> {
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parentTaskId)
      children.set(task.parentTaskId, [...(children.get(task.parentTaskId) ?? []), task.id]);
  }
  const descendants = new Set<string>();
  const pending = [...(children.get(taskId) ?? [])];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (descendants.has(id)) continue;
    descendants.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return descendants;
}

function criticalPath(
  tasks: readonly MissionSnapshotDto['tasks'][number][],
  dependencies: readonly MissionSnapshotDto['dependencies'][number][],
): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, string[]>();
  const visit = (id: string, stack: ReadonlySet<string>): string[] => {
    if (stack.has(id)) return [id];
    const cached = memo.get(id);
    if (cached) return cached;
    const nextStack = new Set(stack).add(id);
    const predecessors = structuralPredecessors(id, byId, dependencies);
    const best =
      predecessors
        .map((predecessor) => visit(predecessor, nextStack))
        .toSorted((left, right) => right.length - left.length)[0] ?? [];
    const path = [...best, id];
    memo.set(id, path);
    return path;
  };
  const longest =
    tasks
      .map((task) => visit(task.id, new Set()))
      .toSorted((left, right) => right.length - left.length)[0] ?? [];
  return new Set(longest);
}

function priorityRank(priority: MissionSnapshotDto['messages'][number]['priority']): number {
  return priority === 'urgent' ? 2 : priority === 'high' ? 1 : 0;
}

export function missionGraphTimeline(snapshot: MissionSnapshotDto): MissionGraphTimelineEvent[] {
  const assignmentTask = new Map(
    snapshot.assignments.map((assignment) => [assignment.id, assignment.taskId]),
  );
  const attemptTask = new Map(
    snapshot.attempts.map((attempt) => [
      attempt.id,
      assignmentTask.get(attempt.assignmentId) ?? null,
    ]),
  );
  const events: MissionGraphTimelineEvent[] = [
    {
      id: `mission:${snapshot.mission.id}`,
      at: timestamp(snapshot.mission.createdAt) ?? 0,
      label: 'Mission created',
      kind: 'mission',
      taskId: null,
      messageId: null,
    },
  ];
  for (const task of snapshot.tasks) {
    events.push({
      id: `task:${task.id}`,
      at: timestamp(task.createdAt) ?? 0,
      label: `${task.title} added`,
      kind: 'task',
      taskId: task.id,
      messageId: null,
    });
  }
  for (const attempt of snapshot.attempts) {
    const taskId = attemptTask.get(attempt.id) ?? null;
    if (attempt.startedAt) {
      events.push({
        id: `attempt:${attempt.id}:start`,
        at: timestamp(attempt.startedAt) ?? 0,
        label: `Attempt ${attempt.ordinal} started`,
        kind: 'attempt',
        taskId,
        messageId: null,
      });
    }
    if (attempt.endedAt) {
      events.push({
        id: `attempt:${attempt.id}:end`,
        at: timestamp(attempt.endedAt) ?? 0,
        label: `Attempt ${attempt.ordinal} ${attempt.state.toLowerCase()}`,
        kind: 'attempt',
        taskId,
        messageId: null,
      });
    }
  }
  for (const message of snapshot.messages) {
    events.push({
      id: `message:${message.id}`,
      at: timestamp(message.createdAt) ?? 0,
      label: message.subject || message.type,
      kind: 'message',
      taskId: message.fromAssignmentId
        ? (assignmentTask.get(message.fromAssignmentId) ?? null)
        : null,
      messageId: message.id,
    });
  }
  for (const artifact of snapshot.artifacts) {
    events.push({
      id: `artifact:${artifact.id}`,
      at: timestamp(artifact.createdAt) ?? 0,
      label: artifact.label,
      kind: 'artifact',
      taskId: assignmentTask.get(artifact.assignmentId) ?? null,
      messageId: null,
    });
  }
  if (snapshot.mission.completedAt) {
    events.push({
      id: `mission:${snapshot.mission.id}:end`,
      at: timestamp(snapshot.mission.completedAt) ?? 0,
      label: 'Mission ended',
      kind: 'mission',
      taskId: null,
      messageId: null,
    });
  }
  return events
    .filter((event) => event.at > 0)
    .toSorted((left, right) => left.at - right.at || left.id.localeCompare(right.id));
}

export function buildMissionGraph(
  snapshot: MissionSnapshotDto,
  options: MissionGraphProjectionOptions = {},
): MissionGraphProjection {
  const latestKnownAt = Math.max(
    timestamp(snapshot.mission.updatedAt) ?? 0,
    ...missionGraphTimeline(snapshot).map((event) => event.at),
  );
  const requestedAt = options.at ?? null;
  const at = requestedAt !== null && requestedAt < latestKnownAt ? requestedAt : null;
  const isReplay = at !== null;
  const availableTasks = snapshot.tasks.filter(
    (task) => at === null || (timestamp(task.createdAt) ?? 0) <= at,
  );
  const availableIds = new Set(availableTasks.map((task) => task.id));
  const availableDependencies = snapshot.dependencies.filter(
    (edge) =>
      availableIds.has(edge.taskId) &&
      availableIds.has(edge.dependsOnTaskId) &&
      (at === null || (timestamp(edge.createdAt) ?? 0) <= at),
  );
  const hiddenByCollapse = new Set<string>();
  for (const collapsedId of options.collapsedTaskIds ?? []) {
    for (const descendant of descendantsOf(collapsedId, availableTasks))
      hiddenByCollapse.add(descendant);
  }

  let visible = availableTasks.filter((task) => !hiddenByCollapse.has(task.id));
  const query = options.search?.trim().toLocaleLowerCase() ?? '';
  if (query) {
    const matches = new Set(
      visible
        .filter((task) => {
          const assignment = assignmentForTask(snapshot, task.id);
          const principal = snapshot.principals.find(
            (item) => item.id === assignment?.assigneePrincipalId,
          );
          return `${task.title} ${task.goal} ${principal?.displayName ?? ''}`
            .toLocaleLowerCase()
            .includes(query);
        })
        .map((task) => task.id),
    );
    const context = graphContext(matches, visible, availableDependencies);
    visible = visible.filter((task) => context.has(task.id));
  }

  const provisionalState = new Map(
    visible.map((task) => {
      const assignment = assignmentForTask(snapshot, task.id);
      const attempts = assignment
        ? snapshot.attempts.filter((attempt) => attempt.assignmentId === assignment.id)
        : [];
      return [task.id, taskStateAt(snapshot, task, assignment, attempts, at)] as const;
    }),
  );
  if (options.filter && options.filter !== 'all') {
    const matches = new Set(
      visible
        .filter((task) => {
          const state = provisionalState.get(task.id)!;
          return options.filter === 'active'
            ? state.tone === 'active'
            : state.tone === 'attention' || state.tone === 'waiting';
        })
        .map((task) => task.id),
    );
    const context = graphContext(matches, visible, availableDependencies);
    visible = visible.filter((task) => context.has(task.id));
  }
  if (options.focusTaskId && visible.some((task) => task.id === options.focusTaskId)) {
    const focus = graphContext(new Set([options.focusTaskId]), visible, availableDependencies);
    visible = visible.filter((task) => focus.has(task.id));
  }

  const visibleById = new Map(visible.map((task) => [task.id, task]));
  const layerMemo = new Map<string, number>();
  const layerFor = (id: string, stack: ReadonlySet<string>): number => {
    if (stack.has(id)) return 0;
    const cached = layerMemo.get(id);
    if (cached !== undefined) return cached;
    const predecessors = structuralPredecessors(id, visibleById, availableDependencies);
    const layer =
      predecessors.length === 0
        ? 0
        : 1 + Math.max(...predecessors.map((item) => layerFor(item, new Set(stack).add(id))));
    layerMemo.set(id, layer);
    return layer;
  };
  const columns = new Map<number, MissionSnapshotDto['tasks']>();
  for (const task of visible) {
    const layer = layerFor(task.id, new Set());
    columns.set(layer, [...(columns.get(layer) ?? []), task]);
  }
  for (const [layer, tasks] of columns) {
    columns.set(
      layer,
      tasks.toSorted(
        (left, right) =>
          (timestamp(left.createdAt) ?? 0) - (timestamp(right.createdAt) ?? 0) ||
          left.id.localeCompare(right.id),
      ),
    );
  }

  const critical = criticalPath(visible, availableDependencies);
  const dependencyChildren = new Map<string, string[]>();
  for (const edge of availableDependencies) {
    if (!visibleById.has(edge.taskId) || !visibleById.has(edge.dependsOnTaskId)) continue;
    dependencyChildren.set(edge.dependsOnTaskId, [
      ...(dependencyChildren.get(edge.dependsOnTaskId) ?? []),
      edge.taskId,
    ]);
  }
  const downstream = (id: string): Set<string> => {
    const result = new Set<string>();
    const pending = [...(dependencyChildren.get(id) ?? [])];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (result.has(current)) continue;
      result.add(current);
      pending.push(...(dependencyChildren.get(current) ?? []));
    }
    return result;
  };
  const failedIds = new Set(
    visible
      .filter((task) => provisionalState.get(task.id)?.tone === 'attention')
      .map((task) => task.id),
  );
  const delegatedCounts = new Map<string, number>();
  for (const task of availableTasks) {
    if (task.parentTaskId)
      delegatedCounts.set(task.parentTaskId, (delegatedCounts.get(task.parentTaskId) ?? 0) + 1);
  }

  const nodes: MissionGraphNode[] = [];
  for (const [layer, tasks] of [...columns.entries()].toSorted(
    (left, right) => left[0] - right[0],
  )) {
    tasks.forEach((task, row) => {
      const assignment = assignmentForTask(snapshot, task.id);
      const principal =
        snapshot.principals.find((item) => item.id === assignment?.assigneePrincipalId) ?? null;
      const attempts = assignment
        ? snapshot.attempts
            .filter(
              (attempt) =>
                attempt.assignmentId === assignment.id &&
                (at === null ||
                  timestamp(attempt.startedAt) === null ||
                  (timestamp(attempt.startedAt) ?? 0) <= at),
            )
            .toSorted((left, right) => left.ordinal - right.ordinal)
        : [];
      const attempt = attempts.at(-1) ?? null;
      const runtime =
        snapshot.runtimeSessions?.find((item) => item.attemptId === attempt?.id) ?? null;
      const dependencies = availableDependencies.filter((edge) => edge.taskId === task.id);
      const durationEnd =
        at === null
          ? attempt?.endedAt
          : attempt?.endedAt && (timestamp(attempt.endedAt) ?? Number.POSITIVE_INFINITY) <= at
            ? attempt.endedAt
            : new Date(at).toISOString();
      nodes.push({
        id: task.id,
        task,
        assignment,
        principal,
        attempt,
        x: 44 + layer * (MISSION_GRAPH_NODE_WIDTH + MISSION_GRAPH_COLUMN_GAP),
        y: 44 + row * (MISSION_GRAPH_NODE_HEIGHT + MISSION_GRAPH_ROW_GAP),
        layer,
        state: taskStateAt(snapshot, task, assignment, attempts, at),
        coverage: coverageFor(assignment, principal, attempt, runtime),
        duration: formatDuration(attempt?.startedAt, durationEnd),
        attemptCount: attempts.length,
        artifactCount: snapshot.artifacts.filter(
          (artifact) =>
            artifact.assignmentId === assignment?.id &&
            (at === null || (timestamp(artifact.createdAt) ?? 0) <= at),
        ).length,
        delegatedCount: delegatedCounts.get(task.id) ?? 0,
        blockedCount: downstream(task.id).size,
        blockedByFailure: dependencies.some((edge) => failedIds.has(edge.dependsOnTaskId)),
        critical: critical.has(task.id),
      });
    });
  }

  const edges: MissionGraphEdge[] = [];
  for (const edge of availableDependencies) {
    if (!visibleById.has(edge.taskId) || !visibleById.has(edge.dependsOnTaskId)) continue;
    edges.push({
      id: `dependency:${edge.dependsOnTaskId}:${edge.taskId}`,
      kind: 'dependency',
      sourceId: edge.dependsOnTaskId,
      targetId: edge.taskId,
      messageIds: [],
      count: 1,
      bidirectional: false,
      pending: false,
      failed: failedIds.has(edge.dependsOnTaskId),
      urgent: false,
      label: failedIds.has(edge.dependsOnTaskId) ? 'Blocked by failure' : 'Depends on',
    });
  }
  for (const task of visible) {
    if (
      task.parentTaskId &&
      visibleById.has(task.parentTaskId) &&
      !edges.some(
        (edge) =>
          edge.kind === 'dependency' &&
          edge.sourceId === task.parentTaskId &&
          edge.targetId === task.id,
      )
    ) {
      edges.push({
        id: `delegation:${task.parentTaskId}:${task.id}`,
        kind: 'delegation',
        sourceId: task.parentTaskId,
        targetId: task.id,
        messageIds: [],
        count: 1,
        bidirectional: false,
        pending: false,
        failed: false,
        urgent: false,
        label: 'Delegated',
      });
    }
  }

  const availableMessages = snapshot.messages.filter(
    (message) =>
      !message.suppressedAt &&
      message.type !== 'heartbeat' &&
      (at === null || (timestamp(message.createdAt) ?? 0) <= at),
  );
  const replaySnapshot = { ...snapshot, messages: availableMessages };
  const unresolved = unresolvedDecisionMessages(replaySnapshot);
  const openAgentRequestIds = new Set(
    agentActionRequests(replaySnapshot).map((request) => request.id),
  );
  const assignmentTask = new Map(
    snapshot.assignments.map((assignment) => [assignment.id, assignment.taskId]),
  );
  const communicationGroups = new Map<
    string,
    {
      first: string;
      second: string;
      directions: Set<string>;
      messages: MissionSnapshotDto['messages'];
    }
  >();
  for (const message of availableMessages) {
    if (
      !message.fromAssignmentId ||
      !message.toAssignmentId ||
      ['assignment', 'heartbeat'].includes(message.type)
    ) {
      continue;
    }
    const source = assignmentTask.get(message.fromAssignmentId);
    const target = assignmentTask.get(message.toAssignmentId);
    if (
      !source ||
      !target ||
      source === target ||
      !visibleById.has(source) ||
      !visibleById.has(target)
    )
      continue;
    const ordered = [source, target].toSorted();
    const first = ordered[0]!;
    const second = ordered[1]!;
    const key = `${first}:${second}`;
    const group =
      communicationGroups.get(key) ??
      ({
        first,
        second,
        directions: new Set<string>(),
        messages: [],
      } satisfies {
        first: string;
        second: string;
        directions: Set<string>;
        messages: MissionSnapshotDto['messages'];
      });
    group.directions.add(`${source}:${target}`);
    group.messages.push(message);
    communicationGroups.set(key, group);
  }
  for (const [key, group] of communicationGroups) {
    const latest = group.messages
      .toSorted(
        (left, right) => (timestamp(left.createdAt) ?? 0) - (timestamp(right.createdAt) ?? 0),
      )
      .at(-1)!;
    edges.push({
      id: `communication:${key}`,
      kind: 'communication',
      sourceId:
        group.directions.size > 1
          ? group.first
          : assignmentTask.get(group.messages[0]!.fromAssignmentId!)!,
      targetId:
        group.directions.size > 1
          ? group.second
          : assignmentTask.get(group.messages[0]!.toAssignmentId!)!,
      messageIds: group.messages.map((message) => message.id),
      count: new Set(group.messages.map((message) => message.threadId ?? message.id)).size,
      bidirectional: group.directions.size > 1,
      pending: group.messages.some(
        (message) => message.actionRequestId && openAgentRequestIds.has(message.actionRequestId),
      ),
      failed: (snapshot.messageDeliveries ?? []).some(
        (delivery) =>
          group.messages.some((message) => message.id === delivery.messageId) &&
          delivery.state === 'failed',
      ),
      urgent: Math.max(...group.messages.map((message) => priorityRank(message.priority))) > 0,
      label: latest.subject || `${group.messages.length} messages`,
    });
  }

  const humanSources = new Map<string, MissionSnapshotDto['messages']>();
  for (const message of unresolved) {
    const source = message.fromAssignmentId ? assignmentTask.get(message.fromAssignmentId) : null;
    if (!source || !visibleById.has(source)) continue;
    humanSources.set(source, [...(humanSources.get(source) ?? []), message]);
  }
  for (const [sourceId, messages] of humanSources) {
    edges.push({
      id: `human:${sourceId}`,
      kind: 'human',
      sourceId,
      targetId: 'mission-human',
      messageIds: messages.map((message) => message.id),
      count: Math.max(1, messages.length),
      bidirectional: false,
      pending: true,
      failed: messages.length === 0,
      urgent: messages.some((message) => message.priority !== 'normal'),
      label: messages[0]?.subject ?? 'Recovery needed',
    });
  }

  const maxLayer = Math.max(0, ...nodes.map((node) => node.layer));
  const maxRows = Math.max(1, ...[...columns.values()].map((column) => column.length));
  const showHuman = humanSources.size > 0;
  const humanX = 44 + (maxLayer + 1) * (MISSION_GRAPH_NODE_WIDTH + MISSION_GRAPH_COLUMN_GAP);
  const humanY =
    44 + Math.max(0, (maxRows - 1) * (MISSION_GRAPH_NODE_HEIGHT + MISSION_GRAPH_ROW_GAP)) / 2;
  return {
    nodes,
    edges,
    width:
      88 +
      (maxLayer + 1 + (showHuman ? 1 : 0)) * MISSION_GRAPH_NODE_WIDTH +
      (maxLayer + (showHuman ? 1 : 0)) * MISSION_GRAPH_COLUMN_GAP,
    height: 88 + maxRows * MISSION_GRAPH_NODE_HEIGHT + (maxRows - 1) * MISSION_GRAPH_ROW_GAP,
    showHuman,
    humanX,
    humanY,
    humanAttention: [...humanSources.values()].reduce(
      (total, messages) => total + Math.max(1, messages.length),
      0,
    ),
    visibleTaskIds: new Set(nodes.map((node) => node.id)),
    isReplay,
  };
}
