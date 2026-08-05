import { describe, expect, it } from 'vitest';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { missionAwareWorking, missionRuntimeStatusByTerminal } from './mission-runtime-status.js';

function snapshot(
  assignmentState: MissionSnapshotDto['assignments'][number]['state'],
  attemptState: MissionSnapshotDto['attempts'][number]['state'],
): MissionSnapshotDto {
  return {
    mission: {
      id: 'mission-1',
      workspaceId: 'workspace-1',
      originConversationTaskId: 'task-1',
      title: 'Mission',
      goal: 'Test runtime projection',
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
      leadAssignmentId: 'assignment-1',
      version: 1,
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:01:00.000Z',
      completedAt: null,
    },
    principals: [],
    tasks: [],
    dependencies: [],
    assignments: [
      {
        id: 'assignment-1',
        missionId: 'mission-1',
        taskId: 'mission-task-1',
        supervisorAssignmentId: null,
        assigneePrincipalId: 'principal-1',
        activeAttemptId: 'attempt-1',
        state: assignmentState,
        createdAt: '2026-07-31T00:00:00.000Z',
        updatedAt: '2026-07-31T00:01:00.000Z',
        completedAt: assignmentState === 'COMPLETED' ? '2026-07-31T00:01:00.000Z' : null,
      },
    ],
    attempts: [
      {
        id: 'attempt-1',
        assignmentId: 'assignment-1',
        ordinal: 1,
        requestedRuntime: 'claude',
        requestedModel: null,
        runtimeSessionId: 'terminal:terminal-1',
        terminalId: 'terminal-1',
        state: attemptState,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        startedAt: '2026-07-31T00:00:00.000Z',
        endedAt: attemptState === 'RUNNING' ? null : '2026-07-31T00:01:00.000Z',
        failureCode: null,
        failure: null,
        result: null,
      },
    ],
    messages: [],
    artifacts: [],
  };
}

describe('missionRuntimeStatusByTerminal', () => {
  it('projects a successful Assignment as settled even while its PTY remains resident', () => {
    expect(
      missionRuntimeStatusByTerminal([snapshot('COMPLETED', 'SUCCEEDED')]).get('terminal-1'),
    ).toBe('succeeded');
  });

  it('keeps a running Attempt active and distinguishes failed and stopped outcomes', () => {
    expect(missionRuntimeStatusByTerminal([snapshot('ACTIVE', 'RUNNING')]).get('terminal-1')).toBe(
      'active',
    );
    expect(missionRuntimeStatusByTerminal([snapshot('FAILED', 'FAILED')]).get('terminal-1')).toBe(
      'failed',
    );
    expect(
      missionRuntimeStatusByTerminal([snapshot('CANCELLED', 'CANCELLED')]).get('terminal-1'),
    ).toBe('stopped');
  });

  it('stops presence animation once Mission work settles but not while it remains active', () => {
    expect(missionAwareWorking(true, null)).toBe(true);
    expect(missionAwareWorking(true, 'active')).toBe(true);
    expect(missionAwareWorking(false, 'active')).toBe(false);
    expect(missionAwareWorking(true, 'succeeded')).toBe(false);
    expect(missionAwareWorking(true, 'failed')).toBe(false);
    expect(missionAwareWorking(true, 'stopped')).toBe(false);
  });
});
