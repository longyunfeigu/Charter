import { describe, expect, it, vi } from 'vitest';
import type { OrchestrationCallerContext } from '@pi-ide/orchestration-domain';
import { ToolGateway } from './gateway.js';
import {
  registerOrchestrationTools,
  type OrchestrationControlPort,
} from './tools-orchestration.js';
import {
  ORCHESTRATION_COMMAND_REGISTRY,
  ORCHESTRATION_MCP_TOOLS,
} from './orchestration-command-registry.js';

const caller: OrchestrationCallerContext = {
  principalId: 'P',
  runtimeSessionId: 'R',
  missionId: 'M',
  assignmentId: 'A',
  attemptId: 'AT',
  origin: 'managed-run',
};

function setup() {
  const delegate = vi.fn(() => ({ assignmentId: 'B' }));
  const control = {
    inspect: vi.fn(() => ({ mission: 'M' })),
    delegate,
    delegateMany: vi.fn(),
    message: vi.fn(),
    reply: vi.fn(),
    sync: vi.fn(),
    ask: vi.fn(async () => ({ answer: null })),
    wait: vi.fn(async () => []),
    join: vi.fn(async () => ({ assignments: [] })),
    progress: vi.fn(),
    complete: vi.fn(),
    escalate: vi.fn(),
    pause: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    reassign: vi.fn(),
    steer: vi.fn(async () => undefined),
  } as unknown as OrchestrationControlPort;
  const gateway = new ToolGateway({ root: '/repo', mode: 'ask' });
  registerOrchestrationTools(gateway, { control, callerForCall: () => caller });
  return { gateway, control, delegate };
}

describe('orchestration native tools', () => {
  it('keeps Native, MCP, CLI, and Skill command semantics on one registry', () => {
    const { gateway } = setup();
    expect(
      gateway
        .catalog('ask')
        .filter((tool) => tool.name.startsWith('orchestration.'))
        .map((tool) => tool.name),
    ).toEqual(ORCHESTRATION_COMMAND_REGISTRY.map((entry) => `orchestration.${entry.command}`));
    expect(ORCHESTRATION_MCP_TOOLS.map((tool) => tool.name)).toEqual(
      ORCHESTRATION_COMMAND_REGISTRY.map((entry) => `orchestration_${entry.command}`),
    );
  });

  it('exposes recursive delegation even in Ask mode without a second permission lane', () => {
    const { gateway } = setup();
    const names = gateway.catalog('ask').map((item) => item.name);
    expect(names).toContain('orchestration.inspect');
    expect(names).toContain('orchestration.delegate');
    expect(names).toContain('orchestration.delegate_many');
    expect(names).toContain('orchestration.sync');
    expect(names).toContain('orchestration.ask');
    expect(names).toContain('orchestration.join');
    expect(names).toContain('orchestration.complete');
  });

  it('derives caller authority outside the payload and applies schema defaults', async () => {
    const { gateway, delegate } = setup();
    const result = await gateway.executeCall(
      {
        callId: 'call',
        runId: 'run',
        taskId: 'task',
        toolName: 'orchestration.delegate',
        input: {
          goal: 'Review',
          acceptanceCriteria: ['report'],
          reason: 'risk',
          idempotencyKey: 'review-v1',
        },
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(delegate).toHaveBeenCalledWith(
      caller,
      expect.objectContaining({
        requestedRuntime: 'managed',
        workMode: 'isolated-write',
      }),
    );
  });

  it('rejects identity fields supplied by an untrusted model', async () => {
    const { gateway, delegate } = setup();
    const result = await gateway.executeCall(
      {
        callId: 'call',
        runId: 'run',
        taskId: 'task',
        toolName: 'orchestration.delegate',
        input: {
          goal: 'Review',
          acceptanceCriteria: [],
          reason: 'risk',
          idempotencyKey: 'x',
          principalId: 'forged',
        },
      },
      new AbortController().signal,
    );
    expect(result.code).toBe('TOOL_INVALID_INPUT');
    expect(delegate).not.toHaveBeenCalled();
  });
});
