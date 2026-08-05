import { describe, expect, it } from 'vitest';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { buildMissionGraph, missionGraphTimeline } from './mission-graph-model.js';

const at = (minute: number) => `2026-07-31T00:${String(minute).padStart(2, '0')}:00.000Z`;

function snapshot(): MissionSnapshotDto {
  return {
    mission: {
      id: 'mission-graph',
      workspaceId: 'workspace',
      originConversationTaskId: 'conversation',
      title: 'Graph Mission',
      goal: 'Coordinate durable work',
      acceptanceCriteria: [],
      executionPolicy: {
        inheritHostPermissions: true,
        controlScope: 'hierarchical',
        workspaceRoot: '/repo',
        toolPolicy: 'inherit',
        runtimeDefaults: { environment: {} },
        limits: { maxConcurrentAgents: null, maxTotalAgents: null },
      },
      state: 'BLOCKED',
      leadAssignmentId: 'assignment-a',
      version: 1,
      createdAt: at(0),
      updatedAt: at(9),
      completedAt: null,
    },
    principals: [
      {
        id: 'principal-a',
        kind: 'managed_agent',
        provider: 'codex',
        externalIdentity: null,
        displayName: 'Lead A',
        state: 'active',
        createdAt: at(0),
        lastSeenAt: at(9),
      },
      {
        id: 'principal-b',
        kind: 'managed_agent',
        provider: 'codex',
        externalIdentity: null,
        displayName: 'Agent B',
        state: 'active',
        createdAt: at(1),
        lastSeenAt: at(9),
      },
      {
        id: 'principal-d',
        kind: 'external_agent',
        provider: 'claude',
        externalIdentity: 'claude-d',
        displayName: 'Agent D',
        state: 'active',
        createdAt: at(3),
        lastSeenAt: at(8),
      },
      {
        id: 'user',
        kind: 'user',
        provider: null,
        externalIdentity: null,
        displayName: 'You',
        state: 'active',
        createdAt: at(0),
        lastSeenAt: at(9),
      },
    ],
    actionRequests: [
      {
        id: 'schema-request',
        missionId: 'mission-graph',
        conversationId: 'review-thread',
        relatedTaskId: 'task-d',
        createdByPrincipalId: 'principal-d',
        createdByAssignmentId: 'assignment-d',
        assignedToPrincipalId: 'principal-b',
        assignedToAssignmentId: 'assignment-b',
        kind: 'information',
        title: 'Where is the target?',
        context: 'The package is missing.',
        responseType: 'text',
        options: [],
        recommendation: null,
        impact: null,
        priority: 'high',
        blockingScope: 'assignment',
        status: 'OPEN',
        openingMessageId: 'question',
        idempotencyKey: 'schema-request',
        dueAt: null,
        resolvedAt: null,
        createdAt: at(4),
        updatedAt: at(4),
      },
      {
        id: 'release-decision',
        missionId: 'mission-graph',
        conversationId: 'release-conversation',
        relatedTaskId: 'task-a',
        createdByPrincipalId: 'principal-a',
        createdByAssignmentId: 'assignment-a',
        assignedToPrincipalId: 'user',
        assignedToAssignmentId: null,
        kind: 'choice',
        title: 'Choose release window',
        context: 'Select a business release window.',
        responseType: 'choice',
        options: [{ id: 'now', label: 'Release now' }],
        recommendation: 'Release now',
        impact: 'Deployment waits for this decision.',
        priority: 'high',
        blockingScope: 'mission',
        status: 'OPEN',
        openingMessageId: 'user-question',
        idempotencyKey: 'release-decision',
        dueAt: null,
        resolvedAt: null,
        createdAt: at(7),
        updatedAt: at(7),
      },
    ],
    tasks: [
      {
        id: 'task-a',
        missionId: 'mission-graph',
        parentTaskId: null,
        createdByAssignmentId: null,
        title: 'Lead work',
        goal: 'Coordinate',
        acceptanceCriteria: [],
        expectedArtifacts: [],
        workMode: 'read-only',
        writeScope: null,
        state: 'RUNNING',
        result: null,
        version: 1,
        createdAt: at(0),
        updatedAt: at(9),
        completedAt: null,
      },
      {
        id: 'task-b',
        missionId: 'mission-graph',
        parentTaskId: 'task-a',
        createdByAssignmentId: 'assignment-a',
        title: 'Implementation',
        goal: 'Implement',
        acceptanceCriteria: [],
        expectedArtifacts: ['code'],
        workMode: 'isolated-write',
        writeScope: ['/repo'],
        state: 'COMPLETED',
        result: null,
        version: 1,
        createdAt: at(1),
        updatedAt: at(6),
        completedAt: at(6),
      },
      {
        id: 'task-d',
        missionId: 'mission-graph',
        parentTaskId: 'task-b',
        createdByAssignmentId: 'assignment-b',
        title: 'Independent review',
        goal: 'Review',
        acceptanceCriteria: [],
        expectedArtifacts: ['report'],
        workMode: 'read-only',
        writeScope: null,
        state: 'FAILED',
        result: null,
        version: 1,
        createdAt: at(3),
        updatedAt: at(8),
        completedAt: null,
      },
    ],
    dependencies: [{ taskId: 'task-a', dependsOnTaskId: 'task-d', createdAt: at(3) }],
    assignments: [
      {
        id: 'assignment-a',
        missionId: 'mission-graph',
        taskId: 'task-a',
        supervisorAssignmentId: null,
        assigneePrincipalId: 'principal-a',
        activeAttemptId: 'attempt-a',
        state: 'WAITING',
        createdAt: at(0),
        updatedAt: at(9),
        completedAt: null,
      },
      {
        id: 'assignment-b',
        missionId: 'mission-graph',
        taskId: 'task-b',
        supervisorAssignmentId: 'assignment-a',
        assigneePrincipalId: 'principal-b',
        activeAttemptId: 'attempt-b',
        state: 'COMPLETED',
        createdAt: at(1),
        updatedAt: at(6),
        completedAt: at(6),
      },
      {
        id: 'assignment-d',
        missionId: 'mission-graph',
        taskId: 'task-d',
        supervisorAssignmentId: 'assignment-b',
        assigneePrincipalId: 'principal-d',
        activeAttemptId: 'attempt-d',
        state: 'FAILED',
        createdAt: at(3),
        updatedAt: at(8),
        completedAt: null,
      },
    ],
    attempts: [
      {
        id: 'attempt-a',
        assignmentId: 'assignment-a',
        ordinal: 1,
        requestedRuntime: 'managed',
        requestedModel: null,
        runtimeSessionId: 'runtime-a',
        terminalId: null,
        state: 'WAITING',
        leaseExpiresAt: null,
        lastHeartbeatAt: at(9),
        startedAt: at(0),
        endedAt: null,
        failureCode: null,
        failure: null,
        result: null,
      },
      {
        id: 'attempt-b',
        assignmentId: 'assignment-b',
        ordinal: 1,
        requestedRuntime: 'codex',
        requestedModel: null,
        runtimeSessionId: 'runtime-b',
        terminalId: 'terminal-b',
        state: 'SUCCEEDED',
        leaseExpiresAt: null,
        lastHeartbeatAt: at(6),
        startedAt: at(1),
        endedAt: at(6),
        failureCode: null,
        failure: null,
        result: null,
      },
      {
        id: 'attempt-d',
        assignmentId: 'assignment-d',
        ordinal: 1,
        requestedRuntime: 'claude',
        requestedModel: 'sonnet',
        runtimeSessionId: 'runtime-d',
        terminalId: 'terminal-d',
        state: 'FAILED',
        leaseExpiresAt: null,
        lastHeartbeatAt: at(8),
        startedAt: at(3),
        endedAt: at(8),
        failureCode: 'TARGET_MISSING',
        failure: null,
        result: null,
      },
    ],
    messages: [
      {
        id: 'question',
        missionId: 'mission-graph',
        conversationId: 'review-thread',
        actionRequestId: 'schema-request',
        fromAssignmentId: 'assignment-d',
        toAssignmentId: 'assignment-b',
        threadId: 'review-thread',
        attemptId: 'attempt-d',
        type: 'question',
        priority: 'high',
        subject: 'Where is the target?',
        body: 'The package is missing.',
        payload: null,
        sequence: 1,
        createdAt: at(4),
        deliveredAt: at(4),
        readAt: null,
        suppressedAt: null,
        suppressionReason: null,
      },
      {
        id: 'progress',
        missionId: 'mission-graph',
        fromAssignmentId: 'assignment-b',
        toAssignmentId: 'assignment-d',
        threadId: 'review-thread',
        attemptId: 'attempt-b',
        type: 'progress',
        priority: 'normal',
        subject: 'Checking',
        body: 'Looking for the package.',
        payload: null,
        sequence: 2,
        createdAt: at(5),
        deliveredAt: at(5),
        readAt: at(5),
        suppressedAt: null,
        suppressionReason: null,
      },
      {
        id: 'user-question',
        missionId: 'mission-graph',
        conversationId: 'release-conversation',
        actionRequestId: 'release-decision',
        fromAssignmentId: 'assignment-a',
        toAssignmentId: null,
        threadId: null,
        attemptId: 'attempt-a',
        type: 'question',
        priority: 'high',
        subject: 'Choose release window',
        body: 'Select a business release window.',
        payload: null,
        sequence: 3,
        createdAt: at(7),
        deliveredAt: null,
        readAt: null,
        suppressedAt: null,
        suppressionReason: null,
      },
    ],
    artifacts: [
      {
        id: 'artifact-b',
        missionId: 'mission-graph',
        assignmentId: 'assignment-b',
        attemptId: 'attempt-b',
        kind: 'file-change',
        label: 'Implementation',
        reference: { path: '/repo/index.ts' },
        createdAt: at(6),
      },
    ],
    runtimeSessions: [],
    runtimeEvents: [],
    messageDeliveries: [
      {
        messageId: 'question',
        assignmentId: 'assignment-b',
        state: 'delivered',
        attempts: 1,
        lastError: null,
        deliveredAt: at(4),
        observedAt: null,
        updatedAt: at(4),
      },
    ],
  };
}

describe('Mission graph model', () => {
  it('projects dependency, delegation, communication and human-attention edges', () => {
    const graph = buildMissionGraph(snapshot());

    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'dependency',
          sourceId: 'task-d',
          targetId: 'task-a',
          failed: true,
        }),
        expect.objectContaining({
          kind: 'delegation',
          sourceId: 'task-a',
          targetId: 'task-b',
        }),
        expect.objectContaining({
          kind: 'communication',
          sourceId: 'task-b',
          targetId: 'task-d',
          bidirectional: true,
          pending: true,
          pendingCount: 1,
          failedCount: 0,
          count: 1,
        }),
        expect.objectContaining({ kind: 'human', sourceId: 'task-a' }),
      ]),
    );
    expect(graph.showHuman).toBe(true);
    expect(graph.nodes.find((node) => node.id === 'task-d')).toMatchObject({
      coverage: 'external',
      state: { tone: 'attention' },
    });
  });

  it('preserves delegation when the same two tasks also have an execution dependency', () => {
    const input = snapshot();
    input.dependencies.push({
      taskId: 'task-b',
      dependsOnTaskId: 'task-a',
      createdAt: at(2),
    });

    const graph = buildMissionGraph(input);

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'dependency',
          sourceId: 'task-a',
          targetId: 'task-b',
        }),
        expect.objectContaining({
          kind: 'delegation',
          sourceId: 'task-a',
          targetId: 'task-b',
        }),
      ]),
    );
  });

  it('reconstructs only work and events known at the selected moment', () => {
    const graph = buildMissionGraph(snapshot(), { at: Date.parse(at(2)) });
    const timeline = missionGraphTimeline(snapshot());

    expect(graph.isReplay).toBe(true);
    expect(graph.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(['task-a', 'task-b']),
    );
    expect(graph.nodes.some((node) => node.id === 'task-d')).toBe(false);
    expect(timeline.some((event) => event.id === 'message:question')).toBe(true);
    expect(
      timeline.every((event, index) => index === 0 || event.at >= timeline[index - 1]!.at),
    ).toBe(true);
  });

  it('collapses recursively delegated descendants without deleting their durable data', () => {
    const graph = buildMissionGraph(snapshot(), {
      collapsedTaskIds: new Set(['task-a']),
    });

    expect(graph.nodes.map((node) => node.id)).toEqual(['task-a']);
    expect(snapshot().tasks).toHaveLength(3);
  });
});
