import { describe, expect, it } from 'vitest';
import type { TerminalControlPort, TerminalToolCaller } from './tools-terminal.js';
import { classifyTerminalSend, registerTerminalTools } from './tools-terminal.js';
import { ToolGateway } from './gateway.js';
import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { ToolCallRequest } from '@pi-ide/agent-contract';

function call(toolName: string, input: unknown): ToolCallRequest {
  return { callId: `call_${toolName}`, runId: 'run_1', taskId: 'task_1', toolName, input };
}

function control(overrides: Partial<TerminalControlPort> = {}): TerminalControlPort {
  return {
    targetKind: () => 'shell',
    preflight: () => undefined,
    list: () => ({ terminals: [] }),
    read: () => ({ content: '' }),
    send: async () => ({ queued: false }),
    create: async () => ({ terminal: { id: 'term_2' } }),
    wait: async () => ({ reason: 'quiet' }),
    kill: () => ({ closed: true }),
    ...overrides,
  };
}

describe('terminal.* gateway tools (ADR-0044)', () => {
  it('classifies TUI content, shell commands, control keys and forbidden commands dynamically', () => {
    expect(classifyTerminalSend('tui', 'please review this').level).toBe('R1');
    expect(classifyTerminalSend('shell', 'npm test').level).toBe('R2');
    expect(classifyTerminalSend('shell', 'npm install').level).toBe('R3');
    expect(classifyTerminalSend('tui', '\u0003').level).toBe('R2');
    expect(classifyTerminalSend('shell', 'sudo rm -rf /').level).toBe('R4');
  });

  it('exposes only R0 list/wait in Ask catalog', () => {
    const gateway = new ToolGateway({ root: '/tmp', mode: 'ask' });
    registerTerminalTools(gateway, { root: '/tmp', control: control() });
    const names = gateway.catalog('ask').map((entry) => entry.name);
    expect(names).toContain('terminal.list');
    expect(names).toContain('terminal.wait');
    expect(names).not.toContain('terminal.read');
    expect(names).not.toContain('terminal.send');
  });

  it('runs depth/self-control preflight before asking for permission', async () => {
    let decisions = 0;
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
    registerTerminalTools(gateway, {
      root: '/tmp',
      control: control({
        preflight(_caller: TerminalToolCaller, action) {
          if (action === 'send') {
            throw new ProductFailure(
              productError('TERMINAL_SELF_CONTROL', { userMessage: 'no self control' }),
            );
          }
        },
      }),
    });
    const result = await gateway.executeCall(
      call('terminal.send', { id: 'term_1', text: 'hello', submit: true }),
      new AbortController().signal,
    );
    expect(result.code).toBe('TERMINAL_SELF_CONTROL');
    expect(decisions).toBe(0);
  });

  it('returns a typed refusal when the user denies an R3 shell injection', async () => {
    let sent = false;
    let requestedRisk = '';
    const gateway = new ToolGateway({
      root: '/tmp',
      mode: 'edit',
      permission: {
        async decide(request) {
          requestedRisk = request.risk.level;
          return { kind: 'deny', reason: 'not in this worker', permanent: false };
        },
      },
    });
    registerTerminalTools(gateway, {
      root: '/tmp',
      control: control({
        async send() {
          sent = true;
          return { queued: false };
        },
      }),
    });

    const result = await gateway.executeCall(
      call('terminal.send', { id: 'term_1', text: 'npm install left-pad', submit: true }),
      new AbortController().signal,
    );

    expect(requestedRisk).toBe('R3');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(sent).toBe(false);
  });

  it('refuses agent-driven worker closure at R4 without permission or side effects', async () => {
    let decisions = 0;
    let killed = false;
    const gateway = new ToolGateway({
      root: '/tmp',
      mode: 'full',
      permission: {
        async decide() {
          decisions += 1;
          return { kind: 'allow', scope: 'once' };
        },
      },
    });
    registerTerminalTools(gateway, {
      root: '/tmp',
      control: control({
        kill() {
          killed = true;
          return { closed: true };
        },
      }),
    });

    const result = await gateway.executeCall(
      call('terminal.kill', { id: 'term_1' }),
      new AbortController().signal,
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.data).toEqual({ risk: 'R4', permanent: true });
    expect(decisions).toBe(0);
    expect(killed).toBe(false);
  });

  it('binds the authenticated external terminal identity to the control call', async () => {
    let seen: TerminalToolCaller | null = null;
    const gateway = new ToolGateway({ root: '/tmp', mode: 'ask' });
    registerTerminalTools(gateway, {
      root: '/tmp',
      callerTerminalForCall: () => 'term_caller',
      control: control({
        list(caller) {
          seen = caller;
          return { terminals: [] };
        },
      }),
    });
    const result = await gateway.executeCall(
      call('terminal.list', {}),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual({ taskId: 'task_1', terminalId: 'term_caller' });
  });
});

void ({} as Logger);
