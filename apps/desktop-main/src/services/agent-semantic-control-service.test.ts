import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@pi-ide/foundation';
import type { AgentPresenceExplain, AgentPresenceSnapshot } from '@pi-ide/ipc-contracts';
import { AgentSemanticControlService } from './agent-semantic-control-service.js';
import type { AgentPresenceService } from './agent-presence-service.js';
import type { TerminalControlService } from './terminal-control-service.js';

function logger() {
  return createLogger('agent-semantic-control-test', { write: () => undefined });
}

function snapshot(patch: Partial<AgentPresenceSnapshot> = {}): AgentPresenceSnapshot {
  return {
    terminalId: 'term-1',
    taskId: 'task-worker',
    agent: 'claude',
    processState: 'running',
    lifecycle: 'idle',
    attention: 'none',
    source: 'structured',
    identitySeq: 1,
    stateChangeSeq: 10,
    changedAt: '2026-08-11T10:00:00.000Z',
    message: 'Ready for input',
    matchedRuleId: 'structured_turn_settled',
    manifestVersion: '1',
    ...patch,
  };
}

class FakePresence {
  current: AgentPresenceSnapshot | null = snapshot();
  readonly listeners = new Set<(presence: AgentPresenceSnapshot) => void>();
  onSubscribe: (() => void) | null = null;

  get(terminalId: string): AgentPresenceSnapshot | null {
    return this.current?.terminalId === terminalId ? this.current : null;
  }

  async explain(terminalId: string): Promise<AgentPresenceExplain | null> {
    const current = this.get(terminalId);
    if (!current) return null;
    return {
      snapshot: current,
      matchedRule: null,
      evaluatedRules: [],
      screenPreview: 'visible evidence',
      oscTitle: '',
      fallbackReason: null,
      stabilization: { candidate: null, samples: 0, requiredSamples: 3 },
    };
  }

  onChanged(listener: (presence: AgentPresenceSnapshot) => void): () => void {
    this.listeners.add(listener);
    this.onSubscribe?.();
    return () => this.listeners.delete(listener);
  }

  publish(next: AgentPresenceSnapshot): void {
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}

class FakeTerminals {
  sent: Array<{ id: string; text: string; submit: boolean }> = [];
  preflights = 0;
  sendResult: unknown = { terminalId: 'term-1', queued: false };
  onSend: (() => void) | null = null;
  viewportResult: unknown = {
    content: 'current screen',
    bytes: 14,
    totalBytes: 14,
    truncated: false,
    capturedRows: 24,
    activeBuffer: 'alternate',
  };
  transcriptResult: any = {
    ok: true,
    content: 'older\ncurrent\n',
    bytes: 14,
    totalBytes: 14,
    truncated: false,
    capturedRows: 80,
    reachedTop: true,
    restored: true,
  };
  onTranscript: ((signal: AbortSignal) => void) | null = null;

  resolveTarget(target: string): string {
    if (target === 'Reviewer' || target === 'term-1') return 'term-1';
    return target;
  }

  preflight(): void {
    this.preflights += 1;
  }

  async readAgentViewport(): Promise<unknown> {
    return this.viewportResult;
  }

  async readAgentTranscript(_terminalId: string, input: { signal: AbortSignal }): Promise<any> {
    this.onTranscript?.(input.signal);
    return this.transcriptResult;
  }

  async send(
    _caller: unknown,
    input: { id: string; text: string; submit: boolean; queueIfBlocked?: boolean },
  ): Promise<unknown> {
    this.sent.push(input);
    this.onSend?.();
    return this.sendResult;
  }
}

function service(presence: FakePresence, terminals: FakeTerminals) {
  return new AgentSemanticControlService(
    presence as unknown as AgentPresenceService,
    terminals as unknown as TerminalControlService,
    logger(),
  );
}

const caller = { taskId: 'task-caller', terminalId: 'term-caller' };

afterEach(() => vi.useRealTimers());

describe('AgentSemanticControlService', () => {
  it('returns semantic status and explain metadata by Session name', async () => {
    const presence = new FakePresence();
    const control = service(presence, new FakeTerminals());

    expect(control.status(caller, { id: 'Reviewer' })).toMatchObject({
      terminalId: 'term-1',
      state: 'idle',
      ready: true,
      needsUser: false,
      identitySeq: 1,
      stateChangeSeq: 10,
    });
    await expect(control.explain(caller, { id: 'Reviewer' })).resolves.toMatchObject({
      terminalId: 'term-1',
      state: 'idle',
      identitySeq: 1,
      stateChangeSeq: 10,
      explanation: { screenPreview: 'visible evidence' },
    });
  });

  it('keeps screen reads passive and gates transcript traversal on semantic Idle', async () => {
    const presence = new FakePresence();
    const terminals = new FakeTerminals();
    const control = service(presence, terminals);

    presence.current = snapshot({ lifecycle: 'working' });
    await expect(
      control.read(
        caller,
        { id: 'Reviewer', mode: 'screen', lines: 20, maxBytes: 4096, unwrap: true },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      terminalId: 'term-1',
      mode: 'screen',
      content: 'current screen',
      restored: true,
    });

    await expect(
      control.read(
        caller,
        { id: 'Reviewer', mode: 'transcript', lines: 200, maxBytes: 4096, unwrap: true },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ error: { code: 'AGENT_TRANSCRIPT_NOT_IDLE' } });
  });

  it('returns Adapter-native results without provider branching and records a discovered id', async () => {
    const presence = new FakePresence();
    presence.current = snapshot({ agent: 'gemini' });
    const terminals = new FakeTerminals();
    const recorded: Array<[string, string]> = [];
    const control = new AgentSemanticControlService(
      presence as unknown as AgentPresenceService,
      terminals as unknown as TerminalControlService,
      logger(),
      {
        resultReader: {
          async read(session, maxBytes) {
            expect(session).toMatchObject({ agent: 'gemini', connector: 'gemini-history' });
            expect(maxBytes).toBe(4096);
            return {
              answer: 'native final answer',
              connector: 'gemini-history',
              sessionId: 'gemini-session-1',
              bytes: 19,
              totalBytes: 19,
              truncated: false,
            };
          },
        },
        resultSessionForTerminal: () => ({
          taskId: 'task-worker',
          agent: 'gemini',
          connector: 'gemini-history',
          dataHome: '/tmp/gemini',
          cwd: '/repo',
          sessionId: null,
          startedAtMs: 1,
          endedAtMs: 2,
          remote: false,
        }),
        recordSessionId: (taskId, sessionId) => recorded.push([taskId, sessionId]),
      },
    );

    await expect(
      control.result(caller, { id: 'Reviewer', maxBytes: 4096 }, new AbortController().signal),
    ).resolves.toMatchObject({
      agent: 'gemini',
      source: 'native_history',
      fidelity: 'native',
      answer: 'native final answer',
      connector: 'gemini-history',
    });
    expect(recorded).toEqual([['task-worker', 'gemini-session-1']]);
  });

  it('supports any recognized Agent through an explicitly observed screen fallback', async () => {
    const presence = new FakePresence();
    presence.current = snapshot({ agent: 'aider' });
    const control = service(presence, new FakeTerminals());

    await expect(
      control.result(caller, { id: 'Reviewer', maxBytes: 4096 }, new AbortController().signal),
    ).resolves.toMatchObject({
      agent: 'aider',
      source: 'screen',
      fidelity: 'observed',
      answer: 'current screen',
      warning: expect.stringContaining('not exact provider history'),
    });
  });

  it('refuses an active result and marks an unknown Agent fallback unsettled', async () => {
    const presence = new FakePresence();
    const control = service(presence, new FakeTerminals());
    presence.current = snapshot({ lifecycle: 'working' });
    await expect(
      control.result(caller, { id: 'Reviewer', maxBytes: 4096 }, new AbortController().signal),
    ).rejects.toMatchObject({ error: { code: 'AGENT_RESULT_NOT_SETTLED' } });

    presence.current = snapshot({ agent: 'future-agent', lifecycle: 'unknown' });
    await expect(
      control.result(caller, { id: 'Reviewer', maxBytes: 4096 }, new AbortController().signal),
    ).resolves.toMatchObject({
      agent: 'future-agent',
      source: 'screen',
      fidelity: 'observed',
      settled: false,
      warning: expect.stringContaining('confirmed-settled'),
    });
  });

  it('does not return a stale answer when a newer turn starts during native reading', async () => {
    const presence = new FakePresence();
    const control = new AgentSemanticControlService(
      presence as unknown as AgentPresenceService,
      new FakeTerminals() as unknown as TerminalControlService,
      logger(),
      {
        resultReader: {
          async read() {
            presence.publish(snapshot({ lifecycle: 'working', stateChangeSeq: 11 }));
            return {
              answer: 'older answer',
              connector: 'custom-history',
              sessionId: 'session-1',
              bytes: 12,
              totalBytes: 12,
              truncated: false,
            };
          },
        },
        resultSessionForTerminal: () => ({
          taskId: 'task-worker',
          agent: 'custom',
          connector: 'custom-history',
          dataHome: '/tmp/custom',
          cwd: '/repo',
          sessionId: 'session-1',
          startedAtMs: 1,
          endedAtMs: 2,
          remote: false,
        }),
      },
    );

    await expect(
      control.result(caller, { id: 'Reviewer', maxBytes: 4096 }, new AbortController().signal),
    ).rejects.toMatchObject({ error: { code: 'AGENT_RESULT_NOT_SETTLED' } });
  });

  it('returns a verified transcript and maps traversal/restoration failures explicitly', async () => {
    const presence = new FakePresence();
    const terminals = new FakeTerminals();
    const control = service(presence, terminals);
    const input = {
      id: 'Reviewer',
      mode: 'transcript' as const,
      lines: 200,
      maxBytes: 4096,
      unwrap: true,
    };

    await expect(control.read(caller, input, new AbortController().signal)).resolves.toMatchObject({
      terminalId: 'term-1',
      mode: 'transcript',
      content: 'older\ncurrent\n',
      restored: true,
      identitySeq: 1,
    });
    expect(presence.listeners.size).toBe(0);

    terminals.transcriptResult = {
      ok: false,
      reason: 'viewport_not_at_bottom',
      restoreAttempted: true,
      restored: true,
    };
    await expect(control.read(caller, input, new AbortController().signal)).rejects.toMatchObject({
      error: { code: 'AGENT_TRANSCRIPT_UNAVAILABLE' },
    });

    terminals.transcriptResult = {
      ok: false,
      reason: 'restore_failed',
      restoreAttempted: true,
      restored: false,
    };
    await expect(control.read(caller, input, new AbortController().signal)).rejects.toMatchObject({
      error: { code: 'AGENT_TRANSCRIPT_RESTORE_FAILED' },
    });
  });

  it('preempts transcript traversal when Presence leaves Idle', async () => {
    const presence = new FakePresence();
    const terminals = new FakeTerminals();
    terminals.onTranscript = (signal) => {
      presence.publish(snapshot({ lifecycle: 'working', stateChangeSeq: 11 }));
      terminals.transcriptResult = {
        ok: false,
        reason: 'interrupted',
        interruptedBy: signal.aborted ? 'cancelled' : 'unknown',
        restoreAttempted: true,
        restored: false,
      };
    };
    await expect(
      service(presence, terminals).read(
        caller,
        {
          id: 'Reviewer',
          mode: 'transcript',
          lines: 200,
          maxBytes: 4096,
          unwrap: true,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ error: { code: 'AGENT_TRANSCRIPT_ABORTED' } });
    expect(presence.listeners.size).toBe(0);
  });

  it('resolves current state immediately unless afterSeq requires a newer edge', async () => {
    const presence = new FakePresence();
    const control = service(presence, new FakeTerminals());

    await expect(
      control.wait(
        caller,
        { id: 'term-1', until: ['idle'], timeoutMs: 100 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ matched: 'idle', durationMs: expect.any(Number) });

    const pending = control.wait(
      caller,
      { id: 'term-1', until: ['blocked'], timeoutMs: 1_000, afterSeq: 10, identitySeq: 1 },
      new AbortController().signal,
    );
    presence.publish(snapshot({ lifecycle: 'blocked', stateChangeSeq: 10 }));
    expect(presence.listeners.size).toBe(1);
    presence.publish(snapshot({ lifecycle: 'working', stateChangeSeq: 11 }));
    presence.publish(snapshot({ lifecycle: 'blocked', stateChangeSeq: 12 }));
    await expect(pending).resolves.toMatchObject({
      matched: 'blocked',
      presence: { stateChangeSeq: 12 },
    });
    expect(presence.listeners.size).toBe(0);
  });

  it('fails closed when the Agent is replaced or exits before the requested state', async () => {
    const presence = new FakePresence();
    const control = service(presence, new FakeTerminals());
    const replaced = control.wait(
      caller,
      { id: 'term-1', until: ['idle'], timeoutMs: 1_000, afterSeq: 10, identitySeq: 1 },
      new AbortController().signal,
    );
    presence.publish(snapshot({ identitySeq: 2, stateChangeSeq: 11, lifecycle: 'idle' }));
    await expect(replaced).rejects.toMatchObject({ error: { code: 'AGENT_REPLACED' } });

    presence.current = snapshot();
    const exited = control.wait(
      caller,
      { id: 'term-1', until: ['idle'], timeoutMs: 1_000, afterSeq: 10, identitySeq: 1 },
      new AbortController().signal,
    );
    presence.publish(
      snapshot({ processState: 'exited', lifecycle: 'unknown', stateChangeSeq: 11 }),
    );
    await expect(exited).rejects.toMatchObject({ error: { code: 'AGENT_PROCESS_EXITED' } });

    presence.current = snapshot({
      processState: 'exited',
      lifecycle: 'unknown',
      stateChangeSeq: 11,
    });
    await expect(
      control.wait(
        caller,
        { id: 'term-1', until: ['exited'], timeoutMs: 100, identitySeq: 1 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ matched: 'exited' });
  });

  it('detaches cleanly on timeout and cancellation', async () => {
    vi.useFakeTimers();
    const presence = new FakePresence();
    const control = service(presence, new FakeTerminals());
    const timedOut = control.wait(
      caller,
      { id: 'term-1', until: ['working'], timeoutMs: 50, afterSeq: 10 },
      new AbortController().signal,
    );
    void timedOut.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(51);
    await expect(timedOut).rejects.toMatchObject({ error: { code: 'AGENT_WAIT_TIMEOUT' } });
    expect(presence.listeners.size).toBe(0);

    const controller = new AbortController();
    const cancelled = control.wait(
      caller,
      { id: 'term-1', until: ['working'], timeoutMs: 1_000, afterSeq: 10 },
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ error: { code: 'CANCELLED' } });
    expect(presence.listeners.size).toBe(0);
  });

  it('installs the waiter before send and confirms a synchronous Ready-to-Working edge', async () => {
    const presence = new FakePresence();
    const terminals = new FakeTerminals();
    terminals.onSend = () =>
      presence.publish(
        snapshot({ lifecycle: 'working', source: 'turn', stateChangeSeq: 11, message: 'Working' }),
      );
    const control = service(presence, terminals);

    await expect(
      control.prompt(
        caller,
        { id: 'Reviewer', text: 'Review the patch.', timeoutMs: 1_000 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      accepted: true,
      fromStateChangeSeq: 10,
      startedStateChangeSeq: 11,
      presence: { lifecycle: 'working' },
    });
    expect(terminals.preflights).toBe(1);
    expect(terminals.sent).toEqual([
      {
        id: 'term-1',
        text: 'Review the patch.',
        submit: true,
        queueIfBlocked: false,
      },
    ]);
  });

  it('reports queued and stalled prompts instead of claiming success', async () => {
    const queuedPresence = new FakePresence();
    const queuedTerminals = new FakeTerminals();
    queuedTerminals.sendResult = { terminalId: 'term-1', queued: true };
    await expect(
      service(queuedPresence, queuedTerminals).prompt(
        caller,
        { id: 'term-1', text: 'Work.', timeoutMs: 1_000 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ error: { code: 'AGENT_PROMPT_QUEUED' } });
    expect(queuedPresence.listeners.size).toBe(0);

    vi.useFakeTimers();
    const stalledPresence = new FakePresence();
    const stalled = service(stalledPresence, new FakeTerminals()).prompt(
      caller,
      { id: 'term-1', text: 'Work.', timeoutMs: 50 },
      new AbortController().signal,
    );
    void stalled.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(51);
    await expect(stalled).rejects.toMatchObject({ error: { code: 'AGENT_PROMPT_STALLED' } });
    expect(stalledPresence.listeners.size).toBe(0);
  });

  it('refuses to inject a prompt while the Agent is already working', async () => {
    const presence = new FakePresence();
    presence.current = snapshot({ lifecycle: 'working' });
    const terminals = new FakeTerminals();
    await expect(
      service(presence, terminals).prompt(
        caller,
        { id: 'term-1', text: 'Interrupt.', timeoutMs: 1_000 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ error: { code: 'AGENT_NOT_READY' } });
    expect(terminals.sent).toEqual([]);
  });

  it('does not send when cancellation or replacement wins the pre-delivery race', async () => {
    const cancelledPresence = new FakePresence();
    const cancelledTerminals = new FakeTerminals();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      service(cancelledPresence, cancelledTerminals).prompt(
        caller,
        { id: 'term-1', text: 'Do not send.', timeoutMs: 1_000 },
        cancelled.signal,
      ),
    ).rejects.toMatchObject({ error: { code: 'CANCELLED' } });
    expect(cancelledTerminals.sent).toEqual([]);

    const replacedPresence = new FakePresence();
    replacedPresence.onSubscribe = () => {
      replacedPresence.onSubscribe = null;
      replacedPresence.publish(snapshot({ identitySeq: 2, stateChangeSeq: 11 }));
    };
    const replacedTerminals = new FakeTerminals();
    await expect(
      service(replacedPresence, replacedTerminals).prompt(
        caller,
        { id: 'term-1', text: 'Do not cross identities.', timeoutMs: 1_000 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ error: { code: 'AGENT_REPLACED' } });
    expect(replacedTerminals.sent).toEqual([]);
    expect(replacedPresence.listeners.size).toBe(0);
  });
});
