import { describe, expect, it } from 'vitest';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { missionSummary, taskStateCopy, unresolvedDecisionMessages } from './mission-view-model.js';

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
        controlScope: 'mission-wide',
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
    ],
  };
}

describe('Mission view model', () => {
  it('counts durable decisions and failed work as user attention', () => {
    const value = missionSummary(snapshot());
    expect(value).toMatchObject({ total: 2, completed: 1, percent: 50, failed: 1, attention: 2 });
  });

  it('resolves a question when an answer exists on its durable thread', () => {
    const value = snapshot();
    value.messages.push({
      ...value.messages[0]!,
      id: 'answer-1',
      type: 'answer',
      threadId: 'question-1',
      sequence: 2,
    });
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
});
