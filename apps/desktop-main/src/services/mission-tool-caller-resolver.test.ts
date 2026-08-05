import { describe, expect, it, vi } from 'vitest';
import type { ToolCallRequest } from '@pi-ide/agent-contract';
import type { AgentHost } from './agent-host.js';
import type { MissionOrchestrationService } from './mission-orchestration-service.js';
import { MissionToolCallerResolver } from './mission-tool-caller-resolver.js';
import type { TaskService } from './task-service.js';
import type { TerminalControlService } from './terminal-control-service.js';

const call: ToolCallRequest = {
  callId: 'call-promote',
  runId: 'terminal:term-1',
  taskId: 'task-1',
  toolName: 'orchestration.promote',
  input: {},
};

function harness() {
  const promote = vi.fn(() => ({
    alreadyPromoted: false,
    mission: { id: 'mission-1' },
    delegation: { results: [] },
  }));
  const getMission = vi.fn<MissionOrchestrationService['repository']['getMission']>(() => null);
  const missions = {
    repository: {
      getAssignmentForTerminal: vi.fn(() => null),
      getMission,
    },
    contextForRuntime: vi.fn(() => null),
    contextForAssignment: vi.fn(),
    promote,
  } as unknown as MissionOrchestrationService;
  const recordEvent = vi.fn();
  const tasks = {
    getTask: vi.fn(() => ({
      id: 'task-1',
      workspaceId: 'ws-1',
      projectPath: '/repo',
      worktree: null,
      title: 'Build feature',
      goalMd: 'Build feature with independent review',
      acceptance: ['Tests pass'],
      external: { cli: 'codex', sessionId: 'session-1' },
      model: { providerId: 'openai', modelId: 'codex' },
    })),
    latestUserMessage: vi.fn(() => 'Build feature with independent review'),
    recordEvent,
  } as unknown as TaskService;
  const orchestrationContextForCall = vi.fn<AgentHost['orchestrationContextForCall']>(() => null);
  const host = {
    orchestrationContextForCall,
  } as unknown as AgentHost;
  const terminals = {
    callerTerminalForCall: vi.fn(() => 'term-1'),
  } as unknown as TerminalControlService;
  const resolver = new MissionToolCallerResolver(
    missions,
    tasks,
    host,
    terminals,
    (agentId) => agentId === 'codex',
  );
  return { resolver, promote, recordEvent, getMission, orchestrationContextForCall };
}

describe('MissionToolCallerResolver Session promotion', () => {
  it('keeps an unattached Agent call outside Mission until promote is invoked', () => {
    const { resolver, promote } = harness();

    expect(resolver.resolve({ ...call, toolName: 'orchestration.inspect' })).toMatchObject({
      runtimeSessionId: 'terminal:term-1',
      missionId: null,
      assignmentId: null,
      attemptId: null,
      origin: 'charter-terminal',
    });
    expect(promote).not.toHaveBeenCalled();
  });

  it('derives authority from the bound Session and records a successful promotion', () => {
    const { resolver, promote, recordEvent } = harness();
    const plan = {
      reason: 'Independent review materially improves confidence.',
      children: [
        {
          key: 'review',
          goal: 'Review the implementation.',
          acceptanceCriteria: ['Report findings.'],
          requestedRuntime: 'codex' as const,
          workMode: 'read-only' as const,
          reason: 'Independent verification.',
          idempotencyKey: 'review-v1',
        },
      ],
      integration: { mode: 'none' as const },
    };

    expect(resolver.promote(call, plan)).toMatchObject({ mission: { id: 'mission-1' } });
    expect(promote).toHaveBeenCalledWith(
      expect.objectContaining({
        originConversationTaskId: 'task-1',
        runtimeSessionId: 'terminal:term-1',
        terminalId: 'term-1',
        requestedRuntime: 'codex',
        goal: 'Build feature with independent review',
      }),
      plan,
    );
    expect(recordEvent).toHaveBeenCalledWith(
      'task-1',
      'mission.promoted',
      expect.objectContaining({ missionId: 'mission-1' }),
    );
  });

  it('rejects promotion from an already attached Mission worker', () => {
    const { resolver, promote, getMission, orchestrationContextForCall } = harness();
    const worker = {
      principalId: 'worker',
      runtimeSessionId: 'terminal:term-1',
      missionId: 'mission-1',
      assignmentId: 'assignment-worker',
      attemptId: 'attempt-worker',
      origin: 'charter-terminal' as const,
    };
    orchestrationContextForCall.mockReturnValue(worker);
    getMission.mockReturnValue({ leadAssignmentId: 'assignment-lead' } as never);

    expect(() =>
      resolver.promote(call, {
        reason: 'Invalid nested promotion.',
        children: [
          {
            goal: 'Do work.',
            acceptanceCriteria: [],
            reason: 'Invalid.',
            idempotencyKey: 'invalid-worker-promotion',
          },
        ],
      }),
    ).toThrow(/already a Mission worker/i);
    expect(promote).not.toHaveBeenCalled();
  });
});
