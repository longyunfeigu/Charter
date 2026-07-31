import { describe, expect, it, vi } from 'vitest';
import { defaultMissionExecutionPolicy } from '@pi-ide/orchestration-domain';
import type { SettingsService } from './settings-service.js';
import type { TaskService } from './task-service.js';
import type { RuntimeStartRequest } from './orchestration-runtime-registry.js';
import { ManagedAgentRuntime } from './managed-agent-runtime.js';

function request(workMode: 'read-only' | 'isolated-write' | 'shared-write'): RuntimeStartRequest {
  const at = '2026-07-30T00:00:00.000Z';
  return {
    idempotencyKey: `launch-${workMode}`,
    workspaceRoot: '/repo',
    mission: {
      id: 'mission-1',
      workspaceId: 'ws-1',
      originConversationTaskId: 'origin-1',
      title: 'Mission',
      goal: 'Ship',
      acceptanceCriteria: [],
      executionPolicy: defaultMissionExecutionPolicy('/repo'),
      state: 'RUNNING',
      leadAssignmentId: 'assignment-lead',
      version: 1,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    },
    task: {
      id: 'mission-task-1',
      missionId: 'mission-1',
      parentTaskId: null,
      createdByAssignmentId: 'assignment-lead',
      title: 'Child work',
      goal: 'Implement the child work',
      acceptanceCriteria: ['tests pass'],
      expectedArtifacts: ['source changes'],
      workMode,
      writeScope: null,
      state: 'READY',
      result: null,
      version: 1,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    },
    assignment: {
      id: 'assignment-1',
      missionId: 'mission-1',
      taskId: 'mission-task-1',
      supervisorAssignmentId: 'assignment-lead',
      assigneePrincipalId: 'principal-1',
      activeAttemptId: 'attempt-1',
      state: 'PENDING',
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    },
    attempt: {
      id: 'attempt-1',
      assignmentId: 'assignment-1',
      ordinal: 1,
      requestedRuntime: 'managed',
      requestedModel: 'mock::mock-1',
      runtimeSessionId: null,
      terminalId: null,
      state: 'PLANNED',
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      startedAt: null,
      endedAt: null,
      failureCode: null,
      failure: null,
      result: null,
    },
  };
}

describe('ManagedAgentRuntime', () => {
  it('creates isolated write Assignments in a dedicated Task worktree with trusted context', async () => {
    const createOrchestratedTask = vi.fn(async () => ({ taskId: 'task-child', queued: false }));
    const tasks = {
      createOrchestratedTask,
      getTask: () => ({
        id: 'task-child',
        title: 'Child work',
        worktree: {
          path: '/worktrees/child',
          branch: 'charter/child',
          baseHead: 'abc123',
          baseBranch: 'main',
        },
      }),
    } as unknown as TaskService;
    const settings = {
      effective: {
        models: {
          useMockRuntime: true,
          defaultProviderId: 'mock',
          defaultModelId: 'mock-1',
          defaultThinkingLevel: 'medium',
        },
        agent: { defaultMode: 'auto' },
      },
    } as unknown as SettingsService;

    const binding = await new ManagedAgentRuntime(tasks, settings).start(request('isolated-write'));

    expect(binding).toEqual(
      expect.objectContaining({
        runtimeSessionId: 'managed-task:task-child',
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            kind: 'worktree',
            reference: expect.objectContaining({
              path: '/worktrees/child',
              baseHead: 'abc123',
              integrationTarget: '/repo',
            }),
          }),
        ]),
      }),
    );
    expect(createOrchestratedTask).toHaveBeenCalledWith(
      expect.objectContaining({ isolation: 'worktree', mode: 'auto', projectPath: '/repo' }),
      expect.objectContaining({
        principalId: 'principal-1',
        missionId: 'mission-1',
        assignmentId: 'assignment-1',
        attemptId: 'attempt-1',
        origin: 'managed-run',
      }),
      { attemptId: 'attempt-1', idempotencyKey: 'launch-isolated-write' },
    );
  });

  it('forces read-only Assignments into Ask mode without a worktree', async () => {
    const createOrchestratedTask = vi.fn(async () => ({ taskId: 'task-read', queued: false }));
    const tasks = {
      createOrchestratedTask,
      getTask: () => ({ id: 'task-read', title: 'Read work', worktree: null }),
    } as unknown as TaskService;
    const settings = {
      effective: {
        models: { useMockRuntime: true, defaultModelId: 'mock-1' },
        agent: { defaultMode: 'auto' },
      },
    } as unknown as SettingsService;

    await new ManagedAgentRuntime(tasks, settings).start(request('read-only'));

    expect(createOrchestratedTask).toHaveBeenCalledWith(
      expect.objectContaining({ isolation: 'none', mode: 'ask' }),
      expect.any(Object),
      expect.any(Object),
    );
  });
});
