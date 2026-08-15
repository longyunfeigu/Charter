import { describe, expect, it } from 'vitest';
import type { ToolCallRequest } from '@pi-ide/agent-contract';
import { productError, ProductFailure } from '@pi-ide/foundation';
import { ToolGateway } from './gateway.js';
import { registerAgentTools, type AgentControlPort, type AgentWaitState } from './tools-agent.js';
import type { TerminalToolCaller } from './tools-terminal.js';

function call(toolName: string, input: unknown): ToolCallRequest {
  return { callId: `call_${toolName}`, runId: 'run_1', taskId: 'task_1', toolName, input };
}

function control(overrides: Partial<AgentControlPort> = {}): AgentControlPort {
  return {
    preflightPrompt: () => undefined,
    status: () => ({ state: 'idle' }),
    explain: () => ({ state: 'idle', explanation: {} }),
    result: async () => ({ source: 'native_history', answer: 'done' }),
    read: async (_caller, input) => ({ mode: input.mode, content: 'screen' }),
    wait: async (_caller, input) => ({ matched: input.until[0] }),
    prompt: async () => ({ accepted: true, startedStateChangeSeq: 2 }),
    ...overrides,
  };
}

describe('agent.* gateway tools', () => {
  it('exposes all semantic tools in Ask mode with sequence-aware guidance', () => {
    const gateway = new ToolGateway({ root: '/tmp', mode: 'ask' });
    registerAgentTools(gateway, { control: control() });
    const catalog = gateway.catalog('ask');
    expect(catalog.map((entry) => entry.name)).toEqual([
      'agent.status',
      'agent.explain',
      'agent.result',
      'agent.read',
      'agent.wait',
      'agent.prompt',
    ]);
    expect(catalog.find((entry) => entry.name === 'agent.wait')?.promptGuidance).toContain(
      'afterSeq',
    );
    expect(catalog.find((entry) => entry.name === 'agent.prompt')?.promptGuidance).toContain(
      'never marks a Charter Task',
    );
  });

  it('reads a bounded settled result through the semantic port', async () => {
    let observed: unknown;
    const gateway = new ToolGateway({ root: '/tmp', mode: 'ask' });
    registerAgentTools(gateway, {
      control: control({
        async result(_caller, input) {
          observed = input;
          return { source: 'screen', fidelity: 'observed', answer: 'visible answer' };
        },
      }),
    });

    await expect(
      gateway.executeCall(
        call('agent.result', { id: 'gemini-worker' }),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { source: 'screen', fidelity: 'observed', answer: 'visible answer' },
    });
    expect(observed).toEqual({ id: 'gemini-worker', maxBytes: 64 * 1024 });
  });

  it('keeps screen passive by default and requires transcript mode explicitly', async () => {
    let observed: unknown;
    const gateway = new ToolGateway({ root: '/tmp', mode: 'ask' });
    registerAgentTools(gateway, {
      control: control({
        async read(_caller, input) {
          observed = input;
          return { mode: input.mode, restored: true };
        },
      }),
    });

    await expect(
      gateway.executeCall(call('agent.read', { id: 'worker' }), new AbortController().signal),
    ).resolves.toMatchObject({ ok: true, data: { mode: 'screen', restored: true } });
    expect(observed).toEqual({
      id: 'worker',
      mode: 'screen',
      lines: 200,
      maxBytes: 64 * 1024,
      unwrap: true,
    });

    await gateway.executeCall(
      call('agent.read', { id: 'worker', mode: 'transcript', lines: 600 }),
      new AbortController().signal,
    );
    expect(observed).toMatchObject({ mode: 'transcript', lines: 600 });
  });

  it('applies wait defaults and carries the authenticated terminal caller', async () => {
    let observed:
      { caller: TerminalToolCaller; until: AgentWaitState[]; timeoutMs: number } | undefined;
    const gateway = new ToolGateway({ root: '/tmp', mode: 'ask' });
    registerAgentTools(gateway, {
      callerTerminalForCall: () => 'term-caller',
      control: control({
        async wait(caller, input) {
          observed = { caller, until: input.until, timeoutMs: input.timeoutMs };
          return { matched: 'idle' };
        },
      }),
    });

    const result = await gateway.executeCall(
      call('agent.wait', { id: 'worker' }),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(observed).toEqual({
      caller: { taskId: 'task_1', terminalId: 'term-caller' },
      until: ['idle', 'blocked', 'exited'],
      timeoutMs: 60_000,
    });
  });

  it('runs prompt self/depth preflight before permission or execution', async () => {
    let decisions = 0;
    let prompted = false;
    const gateway = new ToolGateway({
      root: '/tmp',
      mode: 'edit',
      permission: {
        async decide() {
          decisions += 1;
          return { kind: 'allow', scope: 'once' };
        },
      },
    });
    registerAgentTools(gateway, {
      control: control({
        preflightPrompt() {
          throw new ProductFailure(
            productError('TERMINAL_SELF_CONTROL', { userMessage: 'no self control' }),
          );
        },
        async prompt() {
          prompted = true;
          return {};
        },
      }),
    });

    const result = await gateway.executeCall(
      call('agent.prompt', { id: 'term_1', text: 'work' }),
      new AbortController().signal,
    );
    expect(result.code).toBe('TERMINAL_SELF_CONTROL');
    expect(decisions).toBe(0);
    expect(prompted).toBe(false);
  });

  it('validates semantic states and prompt bounds at the gateway', async () => {
    const gateway = new ToolGateway({ root: '/tmp', mode: 'ask' });
    registerAgentTools(gateway, { control: control() });
    const invalidWait = await gateway.executeCall(
      call('agent.wait', { id: 'worker', until: ['finished'] }),
      new AbortController().signal,
    );
    const invalidPrompt = await gateway.executeCall(
      call('agent.prompt', { id: 'worker', text: '' }),
      new AbortController().signal,
    );
    expect(invalidWait.code).toBe('TOOL_INVALID_INPUT');
    expect(invalidPrompt.code).toBe('TOOL_INVALID_INPUT');
  });
});
