import { describe, expect, it } from 'vitest';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import {
  actionOptionsFor,
  missionActivityCounts,
  missionActivityMessages,
  missionSummary,
  taskStateCopy,
  unresolvedDecisionMessages,
} from './mission-view-model.js';

function snapshot(): MissionSnapshotDto {
  return {
    mission: {
      id: 'mission-1',
      workspaceId: 'workspace-1',
      originConversationTaskId: 'conversation-1',
      title: 'Ship a release',
      goal: 'Ship it',
      acceptanceCriteria: [],
      executionPolicy: {
        inheritHostPermissions: true,
        controlScope: 'hierarchical',
        workspaceRoot: '/repo',
        toolPolicy: 'inherit',
        runtimeDefaults: { environment: {} },
        limits: { maxConcurrentAgents: null, maxTotalAgents: null },
      },
      state: 'RUNNING',
      leadAssignmentId: 'a',
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      completedAt: null,
    },
    principals: [],
    actionRequests: [
      {
        id: 'agent-action',
        missionId: 'mission-1',
        conversationId: 'conversation-agent',
        relatedTaskId: 'task-b',
        createdByPrincipalId: 'pa',
        createdByAssignmentId: 'a',
        assignedToPrincipalId: 'pb',
        assignedToAssignmentId: 'b',
        kind: 'information',
        title: 'Choose an API',
        context: 'Which one?',
        responseType: 'text',
        options: [],
        recommendation: null,
        impact: null,
        priority: 'high',
        blockingScope: 'assignment',
        status: 'OPEN',
        openingMessageId: 'question-1',
        idempotencyKey: 'agent-action',
        dueAt: null,
        resolvedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'user-action',
        missionId: 'mission-1',
        conversationId: 'conversation-user',
        relatedTaskId: 'task-a',
        createdByPrincipalId: 'pa',
        createdByAssignmentId: 'a',
        assignedToPrincipalId: 'user',
        assignedToAssignmentId: null,
        kind: 'choice',
        title: 'Choose release window',
        context: 'The deploy needs a business decision.',
        responseType: 'choice',
        options: [
          { id: 'now', label: 'Release now' },
          { id: 'later', label: 'Release later' },
        ],
        recommendation: 'Release now',
        impact: 'This determines whether deployment proceeds.',
        priority: 'high',
        blockingScope: 'mission',
        status: 'OPEN',
        openingMessageId: 'user-question-1',
        idempotencyKey: 'user-action',
        dueAt: null,
        resolvedAt: null,
        createdAt: '2026-01-01T00:01:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
      },
    ],
    tasks: [
      {
        id: 'task-a',
        missionId: 'mission-1',
        parentTaskId: null,
        createdByAssignmentId: null,
        title: 'A',
        goal: 'A',
        acceptanceCriteria: [],
        expectedArtifacts: [],
        workMode: 'read-only',
        writeScope: null,
        state: 'COMPLETED',
        result: null,
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'task-b',
        missionId: 'mission-1',
        parentTaskId: 'task-a',
        createdByAssignmentId: 'a',
        title: 'B',
        goal: 'B',
        acceptanceCriteria: [],
        expectedArtifacts: [],
        workMode: 'read-only',
        writeScope: null,
        state: 'RUNNING',
        result: null,
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        completedAt: null,
      },
    ],
    dependencies: [],
    assignments: [
      {
        id: 'a',
        missionId: 'mission-1',
        taskId: 'task-a',
        supervisorAssignmentId: null,
        assigneePrincipalId: 'pa',
        activeAttemptId: 'attempt-a',
        state: 'COMPLETED',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'b',
        missionId: 'mission-1',
        taskId: 'task-b',
        supervisorAssignmentId: 'a',
        assigneePrincipalId: 'pb',
        activeAttemptId: 'attempt-b',
        state: 'FAILED',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        completedAt: null,
      },
    ],
    attempts: [],
    artifacts: [],
    messages: [
      {
        id: 'question-1',
        missionId: 'mission-1',
        conversationId: 'conversation-agent',
        actionRequestId: 'agent-action',
        fromAssignmentId: 'b',
        toAssignmentId: 'a',
        threadId: null,
        attemptId: null,
        type: 'question',
        priority: 'high',
        subject: 'Choose an API',
        body: 'Which one?',
        payload: null,
        sequence: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        deliveredAt: null,
        readAt: null,
        suppressedAt: null,
        suppressionReason: null,
      },
      {
        id: 'user-question-1',
        missionId: 'mission-1',
        conversationId: 'conversation-user',
        actionRequestId: 'user-action',
        fromAssignmentId: 'a',
        toAssignmentId: null,
        threadId: null,
        attemptId: null,
        type: 'question',
        priority: 'high',
        subject: 'Choose release window',
        body: 'The deploy needs a business decision.',
        payload: null,
        sequence: 2,
        createdAt: '2026-01-01T00:01:00.000Z',
        deliveredAt: null,
        readAt: null,
        suppressedAt: null,
        suppressionReason: null,
      },
      {
        id: 'progress-1',
        missionId: 'mission-1',
        fromAssignmentId: 'b',
        toAssignmentId: 'a',
        threadId: null,
        attemptId: null,
        type: 'progress',
        priority: 'normal',
        subject: 'Repository progress',
        body: 'The state transitions are implemented.',
        payload: null,
        sequence: 3,
        createdAt: '2026-01-01T00:02:00.000Z',
        deliveredAt: null,
        readAt: null,
        suppressedAt: null,
        suppressionReason: null,
      },
      {
        id: 'completion-1',
        missionId: 'mission-1',
        fromAssignmentId: 'b',
        toAssignmentId: 'a',
        threadId: null,
        attemptId: null,
        type: 'completion',
        priority: 'normal',
        subject: 'Repository complete',
        body: 'The repository is ready for verification.',
        payload: null,
        sequence: 4,
        createdAt: '2026-01-01T00:03:00.000Z',
        deliveredAt: null,
        readAt: null,
        suppressedAt: null,
        suppressionReason: null,
      },
      {
        id: 'heartbeat-1',
        missionId: 'mission-1',
        fromAssignmentId: 'b',
        toAssignmentId: 'a',
        threadId: null,
        attemptId: null,
        type: 'heartbeat',
        priority: 'normal',
        subject: 'Still active',
        body: '',
        payload: null,
        sequence: 5,
        createdAt: '2026-01-01T00:04:00.000Z',
        deliveredAt: null,
        readAt: null,
        suppressedAt: null,
        suppressionReason: null,
      },
    ],
  };
}

describe('Mission view model', () => {
  it('counts only explicit user Action Requests as user attention', () => {
    const value = missionSummary(snapshot());
    expect(value).toMatchObject({
      total: 2,
      completed: 1,
      percent: 50,
      failed: 1,
      attention: 1,
      agentActions: 1,
    });
    expect(value.decisions.map((message) => message.id)).toEqual(['user-question-1']);
  });

  it('removes an action only when its durable Action Request is resolved', () => {
    const value = snapshot();
    value.actionRequests![1]!.status = 'RESOLVED';
    value.actionRequests![1]!.resolvedAt = '2026-01-01T00:02:00.000Z';
    expect(unresolvedDecisionMessages(value)).toEqual([]);
  });

  it('presents a durably parked Assignment as waiting instead of in progress', () => {
    const value = snapshot();
    value.assignments[1]!.state = 'WAITING';

    expect(taskStateCopy(value.tasks[1]!.state, value.assignments[1]!.state)).toEqual({
      label: 'Waiting',
      tone: 'waiting',
    });
    expect(missionSummary(value)).toMatchObject({ active: 0, waiting: 1 });
  });

  it('separates requests, progress, and outcomes without exposing heartbeats', () => {
    const value = snapshot();

    expect(missionActivityCounts(value)).toEqual({
      all: 4,
      requests: 2,
      progress: 1,
      outcomes: 1,
    });
    expect(missionActivityMessages(value, 'requests').map((message) => message.id)).toEqual([
      'question-1',
      'user-question-1',
    ]);
    expect(missionActivityMessages(value, 'progress').map((message) => message.id)).toEqual([
      'progress-1',
    ]);
    expect(missionActivityMessages(value, 'outcomes').map((message) => message.id)).toEqual([
      'completion-1',
    ]);
  });

  it('styles only explicitly recommended or dangerous request options', () => {
    const value = snapshot();
    value.actionRequests![1]!.options = [
      { id: 'later', label: 'Release later' },
      { id: 'now', label: 'Release now', recommended: true },
    ];
    expect(actionOptionsFor(value.actionRequests![1]!)).toEqual(value.actionRequests![1]!.options);

    value.actionRequests![1]!.options = [];
    value.actionRequests![1]!.responseType = 'recovery';
    expect(actionOptionsFor(value.actionRequests![1]!)).toEqual([
      { id: 'retry', label: 'Retry' },
      { id: 'cancel', label: 'Cancel work', danger: true },
    ]);
  });
});
