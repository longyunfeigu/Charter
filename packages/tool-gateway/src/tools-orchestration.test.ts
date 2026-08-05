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
  const promote = vi.fn(() => ({ mission: { id: 'M' } }));
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
    park: vi.fn(() => ({ continuation: { id: 'CONT' } })),
    continue: vi.fn(() => ({ continuation: { id: 'CONT', state: 'CONSUMED' } })),
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
  registerOrchestrationTools(gateway, {
    control,
    callerForCall: () => caller,
    promoteForCall: promote,
  });
  return { gateway, control, delegate, promote };
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
    expect(names).toContain('orchestration.park');
    expect(names).toContain('orchestration.continue');
    expect(names).toContain('orchestration.complete');
  });

  it('promotes from the trusted call context with a validated worker plan', async () => {
    const { gateway, promote } = setup();
    const result = await gateway.executeCall(
      {
        callId: 'promote',
        runId: 'run',
        taskId: 'task',
        toolName: 'orchestration.promote',
        input: {
          reason: 'Independent implementation and review improve confidence.',
          children: [
            {
              key: 'review',
              goal: 'Review the implementation independently.',
              acceptanceCriteria: ['Report concrete findings.'],
              requestedRuntime: 'codex',
              workMode: 'read-only',
              reason: 'Independent review reduces regression risk.',
              idempotencyKey: 'review-v1',
            },
          ],
        },
      },
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
    expect(promote).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task', toolName: 'orchestration.promote' }),
      expect.objectContaining({
        integration: { mode: 'auto' },
        children: [expect.objectContaining({ requestedRuntime: 'codex' })],
      }),
    );
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
        workMode: 'auto',
      }),
    );
  });

  it('defaults inspect to compact and delegate_many to automatic integration planning', async () => {
    const { gateway, control } = setup();
    const inspected = await gateway.executeCall(
      {
        callId: 'inspect',
        runId: 'run',
        taskId: 'task',
        toolName: 'orchestration.inspect',
        input: {},
      },
      new AbortController().signal,
    );
    expect(inspected.ok).toBe(true);
    expect(control.inspect).toHaveBeenCalledWith(caller, { view: 'compact' });

    const delegated = await gateway.executeCall(
      {
        callId: 'batch',
        runId: 'run',
        taskId: 'task',
        toolName: 'orchestration.delegate_many',
        input: {
          children: [
            {
              key: 'foundation',
              goal: 'Define the contract',
              reason: 'parallel work',
              idempotencyKey: 'foundation-v1',
            },
            {
              key: 'consumer',
              dependsOn: ['foundation'],
              goal: 'Use the contract',
              reason: 'ordered work',
              idempotencyKey: 'consumer-v1',
            },
          ],
        },
      },
      new AbortController().signal,
    );
    expect(delegated.ok).toBe(true);
    expect(control.delegateMany).toHaveBeenCalledWith(
      caller,
      expect.objectContaining({
        integration: { mode: 'auto' },
        children: expect.arrayContaining([
          expect.objectContaining({ key: 'consumer', dependsOn: ['foundation'] }),
        ]),
      }),
    );
  });

  it('marks messages observed when a blocking wait returns them by default', async () => {
    const { gateway, control } = setup();
    const result = await gateway.executeCall(
      {
        callId: 'call-wait',
        runId: 'run',
        taskId: 'task',
        toolName: 'orchestration.wait',
        input: { types: ['question'], timeoutMs: 1_000 },
      },
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
    expect(control.wait).toHaveBeenCalledWith(
      caller,
      expect.objectContaining({ markRead: true, unreadOnly: true }),
    );
  });

  it('exposes durable park and idempotent continuation resume with schema defaults', async () => {
    const { gateway, control } = setup();
    const parked = await gateway.executeCall(
      {
        callId: 'call-park',
        runId: 'run',
        taskId: 'task',
        toolName: 'orchestration.park',
        input: {
          conditions: [{ kind: 'assignment_terminal', assignmentId: 'B' }],
          reason: 'Wait for B',
          idempotencyKey: 'wait-b',
        },
      },
      new AbortController().signal,
    );
    expect(parked.ok).toBe(true);
    expect(control.park).toHaveBeenCalledWith(
      caller,
      expect.objectContaining({ mode: 'all', afterSequence: 0 }),
    );

    const resumed = await gateway.executeCall(
      {
        callId: 'call-continue',
        runId: 'run',
        taskId: 'task',
        toolName: 'orchestration.continue',
        input: { continuationId: 'CONT' },
      },
      new AbortController().signal,
    );
    expect(resumed.ok).toBe(true);
    expect(control.continue).toHaveBeenCalledWith(caller, { continuationId: 'CONT' });
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

  it('keeps large artifacts out of the orchestration control plane', async () => {
    const { gateway, control } = setup();
    const result = await gateway.executeCall(
      {
        callId: 'call-large-payload',
        runId: 'run',
        taskId: 'task',
        toolName: 'orchestration.message',
        input: {
          toAssignmentId: 'B',
          subject: 'Large output',
          body: 'See the workspace artifact.',
          payload: { rawOutput: 'x'.repeat(64 * 1024) },
        },
      },
      new AbortController().signal,
    );

    expect(result.code).toBe('TOOL_INVALID_INPUT');
    expect(control.message).not.toHaveBeenCalled();
  });
});
