import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { AgentPresenceSnapshot } from '@pi-ide/ipc-contracts';
import type {
  AgentControlPort,
  AgentReadMode,
  AgentWaitState,
  TerminalToolCaller,
} from '@pi-ide/tool-gateway';
import type { AgentPresenceService } from './agent-presence-service.js';
import type { TerminalControlService } from './terminal-control-service.js';
import type {
  AgentResultReader,
  AgentResultSession,
  NativeAgentResult,
} from './agent-result-reader.js';

interface AgentWaitInput {
  id: string;
  until: AgentWaitState[];
  timeoutMs: number;
  afterSeq?: number;
  identitySeq?: number;
}

interface AgentReadInput {
  id: string;
  mode: AgentReadMode;
  lines: number;
  maxBytes: number;
  unwrap: boolean;
}

export interface AgentSemanticControlOptions {
  now?: () => number;
  resultReader?: Pick<AgentResultReader, 'read'>;
  resultSessionForTerminal?: (terminalId: string, agent: string) => AgentResultSession | null;
  recordSessionId?: (taskId: string, sessionId: string) => void;
}

function failure(
  code: string,
  userMessage: string,
  context?: Record<string, unknown>,
  retryable = false,
): ProductFailure {
  return new ProductFailure(productError(code, { userMessage, context, retryable }));
}

function semanticState(snapshot: AgentPresenceSnapshot): AgentWaitState {
  return snapshot.processState === 'exited' ? 'exited' : snapshot.lifecycle;
}

function queued(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && 'queued' in result && result.queued);
}

function queueReason(result: unknown): string {
  if (!result || typeof result !== 'object' || !('reason' in result)) return 'remote control hold';
  return typeof result.reason === 'string' ? result.reason : 'remote control hold';
}

/**
 * Semantic control is intentionally a narrow facade over Presence + Terminal
 * Control. It can observe, wait, and submit a prompt; it cannot complete a
 * Task, settle a Mission Assignment, or infer product workflow success.
 */
export class AgentSemanticControlService implements AgentControlPort {
  private readonly now: () => number;
  private readonly resultReader: Pick<AgentResultReader, 'read'> | null;

  constructor(
    private readonly presence: AgentPresenceService,
    private readonly terminals: TerminalControlService,
    private readonly logger: Logger,
    private readonly options: AgentSemanticControlOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.resultReader = options.resultReader ?? null;
  }

  preflightPrompt(caller: TerminalToolCaller, input: { id: string }): void {
    this.terminals.preflight(caller, 'send', input.id);
  }

  status(_caller: TerminalToolCaller, input: { id: string }): unknown {
    const terminalId = this.terminals.resolveTarget(input.id);
    const snapshot = this.requirePresence(terminalId);
    return this.statusResult(snapshot);
  }

  async explain(_caller: TerminalToolCaller, input: { id: string }): Promise<unknown> {
    const terminalId = this.terminals.resolveTarget(input.id);
    this.requirePresence(terminalId);
    const explanation = await this.presence.explain(terminalId);
    if (!explanation) throw this.notFound(terminalId);
    return {
      terminalId,
      state: semanticState(explanation.snapshot),
      identitySeq: explanation.snapshot.identitySeq,
      stateChangeSeq: explanation.snapshot.stateChangeSeq,
      explanation,
    };
  }

  async result(
    _caller: TerminalToolCaller,
    input: { id: string; maxBytes: number },
    signal: AbortSignal,
  ): Promise<unknown> {
    const terminalId = this.terminals.resolveTarget(input.id);
    const before = this.requirePresence(terminalId);
    const state = semanticState(before);
    if (signal.aborted) throw failure('CANCELLED', `Reading Agent ${terminalId} was cancelled.`);
    if (state === 'working') {
      throw failure(
        'AGENT_RESULT_NOT_SETTLED',
        `Agent ${terminalId} is working; wait for idle, blocked, or exited before reading its result.`,
        {
          terminalId,
          state,
          identitySeq: before.identitySeq,
          stateChangeSeq: before.stateChangeSeq,
        },
        true,
      );
    }

    const session = this.options.resultSessionForTerminal?.(terminalId, before.agent) ?? null;
    const native = session ? await this.resultReader?.read(session, input.maxBytes) : null;
    if (signal.aborted) throw failure('CANCELLED', `Reading Agent ${terminalId} was cancelled.`);
    const afterNative = this.requirePresence(terminalId);
    if (afterNative.identitySeq !== before.identitySeq) {
      throw failure(
        'AGENT_REPLACED',
        `Agent ${terminalId} was replaced or restarted while its result was being read.`,
        {
          terminalId,
          expectedIdentitySeq: before.identitySeq,
          actualIdentitySeq: afterNative.identitySeq,
        },
      );
    }
    if (semanticState(afterNative) === 'working') {
      throw failure(
        'AGENT_RESULT_NOT_SETTLED',
        `Agent ${terminalId} started working while its result was being read; wait for the newer turn to settle.`,
        {
          terminalId,
          identitySeq: afterNative.identitySeq,
          stateChangeSeq: afterNative.stateChangeSeq,
        },
        true,
      );
    }
    if (native) {
      this.recordDiscoveredSession(session, native);
      return {
        terminalId,
        agent: before.agent,
        state,
        settled: true,
        source: 'native_history',
        fidelity: 'native',
        answer: native.answer,
        bytes: native.bytes,
        totalBytes: native.totalBytes,
        truncated: native.truncated,
        connector: native.connector,
        sessionId: native.sessionId,
        identitySeq: afterNative.identitySeq,
        stateChangeSeq: afterNative.stateChangeSeq,
      };
    }

    const viewport = (await this.terminals.readAgentViewport(terminalId, {
      lines: 200,
      maxBytes: input.maxBytes,
      unwrap: true,
    })) as {
      content?: unknown;
      bytes?: unknown;
      totalBytes?: unknown;
      truncated?: unknown;
      capturedRows?: unknown;
      activeBuffer?: unknown;
    } | null;
    if (!viewport || typeof viewport.content !== 'string') throw this.notFound(terminalId);
    const afterScreen = this.requirePresence(terminalId);
    if (afterScreen.identitySeq !== before.identitySeq) {
      throw failure(
        'AGENT_REPLACED',
        `Agent ${terminalId} was replaced or restarted while its screen result was being read.`,
        { terminalId, expectedIdentitySeq: before.identitySeq },
      );
    }
    if (semanticState(afterScreen) === 'working') {
      throw failure(
        'AGENT_RESULT_NOT_SETTLED',
        `Agent ${terminalId} started working while its screen result was being read; wait for the newer turn to settle.`,
        {
          terminalId,
          identitySeq: afterScreen.identitySeq,
          stateChangeSeq: afterScreen.stateChangeSeq,
        },
        true,
      );
    }
    return {
      terminalId,
      agent: before.agent,
      state,
      settled: state !== 'unknown',
      source: 'screen',
      fidelity: 'observed',
      answer: viewport.content,
      bytes:
        typeof viewport.bytes === 'number'
          ? viewport.bytes
          : Buffer.byteLength(viewport.content, 'utf8'),
      totalBytes:
        typeof viewport.totalBytes === 'number'
          ? viewport.totalBytes
          : Buffer.byteLength(viewport.content, 'utf8'),
      truncated: viewport.truncated === true,
      identitySeq: afterScreen.identitySeq,
      stateChangeSeq: afterScreen.stateChangeSeq,
      warning:
        state === 'unknown'
          ? 'No native result connector/session or settled lifecycle evidence was available; this is the passive visible Agent screen, not an exact or confirmed-settled result.'
          : 'No native result connector/session was available; this is the passive visible Agent screen, not exact provider history.',
    };
  }

  async read(
    _caller: TerminalToolCaller,
    input: AgentReadInput,
    signal: AbortSignal,
  ): Promise<unknown> {
    const terminalId = this.terminals.resolveTarget(input.id);
    const before = this.requirePresence(terminalId);
    if (signal.aborted) throw failure('CANCELLED', `Reading Agent ${terminalId} was cancelled.`);

    if (input.mode === 'screen') {
      const viewport = await this.terminals.readAgentViewport(terminalId, input);
      if (!viewport) throw this.notFound(terminalId);
      return {
        terminalId,
        mode: 'screen',
        restored: true,
        identitySeq: before.identitySeq,
        stateChangeSeq: before.stateChangeSeq,
        ...viewport,
      };
    }

    const state = semanticState(before);
    if (state === 'exited') {
      throw failure('AGENT_PROCESS_EXITED', `Agent ${terminalId} has exited.`, { terminalId });
    }
    if (state !== 'idle') {
      throw failure(
        'AGENT_TRANSCRIPT_NOT_IDLE',
        `Agent ${terminalId} is ${state}; transcript traversal is allowed only while it is idle.`,
        {
          terminalId,
          state,
          identitySeq: before.identitySeq,
          stateChangeSeq: before.stateChangeSeq,
        },
        true,
      );
    }

    const controller = new AbortController();
    let semanticAbort: 'cancelled' | 'replaced' | 'exited' | 'left_idle' | null = null;
    const abort = (reason: NonNullable<typeof semanticAbort>): void => {
      if (semanticAbort) return;
      semanticAbort = reason;
      controller.abort();
    };
    const forwardAbort = (): void => abort('cancelled');
    signal.addEventListener('abort', forwardAbort, { once: true });
    const unsubscribe = this.presence.onChanged((snapshot) => {
      if (snapshot.terminalId !== terminalId) return;
      if (snapshot.identitySeq !== before.identitySeq) abort('replaced');
      else if (snapshot.processState === 'exited') abort('exited');
      else if (snapshot.lifecycle !== 'idle') abort('left_idle');
    });
    try {
      const latest = this.requirePresence(terminalId);
      if (latest.identitySeq !== before.identitySeq) abort('replaced');
      else if (latest.processState === 'exited') abort('exited');
      else if (latest.lifecycle !== 'idle') abort('left_idle');

      const result = await this.terminals.readAgentTranscript(terminalId, {
        ...input,
        signal: controller.signal,
      });
      if (!result.ok) {
        if (semanticAbort === 'cancelled') {
          throw failure('CANCELLED', `Reading Agent ${terminalId} was cancelled.`);
        }
        if (semanticAbort === 'replaced') {
          throw failure(
            'AGENT_REPLACED',
            `Agent ${terminalId} was replaced or restarted during transcript traversal.`,
            { terminalId, expectedIdentitySeq: before.identitySeq },
          );
        }
        if (semanticAbort === 'exited') {
          throw failure(
            'AGENT_PROCESS_EXITED',
            `Agent ${terminalId} exited during transcript traversal.`,
            {
              terminalId,
            },
          );
        }
        if (result.reason === 'restore_failed') {
          throw failure(
            'AGENT_TRANSCRIPT_RESTORE_FAILED',
            `Charter could not verify that Agent ${terminalId} returned to the bottom after transcript traversal. Open the Session before continuing.`,
            { terminalId, ...result },
          );
        }
        if (
          result.reason === 'not_alternate_screen' ||
          result.reason === 'mouse_reporting_unavailable' ||
          result.reason === 'viewport_not_at_bottom' ||
          result.reason === 'read_in_progress'
        ) {
          throw failure(
            'AGENT_TRANSCRIPT_UNAVAILABLE',
            this.transcriptUnavailableMessage(terminalId, result.reason),
            { terminalId, ...result },
            true,
          );
        }
        throw failure(
          'AGENT_TRANSCRIPT_ABORTED',
          `Transcript traversal for Agent ${terminalId} stopped (${result.interruptedBy ?? result.reason}).${result.restored ? ' Its viewport was restored.' : ''}`,
          { terminalId, ...result, semanticAbort },
          true,
        );
      }

      const after = this.requirePresence(terminalId);
      if (after.identitySeq !== before.identitySeq) {
        throw failure(
          'AGENT_REPLACED',
          `Agent ${terminalId} was replaced or restarted during transcript traversal.`,
          {
            terminalId,
            expectedIdentitySeq: before.identitySeq,
            actualIdentitySeq: after.identitySeq,
          },
        );
      }
      this.logger.info('semantic agent transcript read completed', {
        terminalId,
        capturedRows: result.capturedRows,
        bytes: result.bytes,
        restored: result.restored,
      });
      return {
        terminalId,
        mode: 'transcript',
        identitySeq: after.identitySeq,
        stateChangeSeq: after.stateChangeSeq,
        ...result,
      };
    } finally {
      unsubscribe();
      signal.removeEventListener('abort', forwardAbort);
    }
  }

  wait(_caller: TerminalToolCaller, input: AgentWaitInput, signal: AbortSignal): Promise<unknown> {
    const terminalId = this.terminals.resolveTarget(input.id);
    const initial = this.requirePresence(terminalId);
    const expectedIdentitySeq = input.identitySeq ?? initial.identitySeq;
    const afterSeq = input.afterSeq ?? -1;
    const requested = new Set(input.until);
    const startedAt = this.now();

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe = (): void => undefined;

      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout);
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
      };
      const finish = (error: ProductFailure | null, snapshot?: AgentPresenceSnapshot): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve({
          terminalId,
          matched: semanticState(snapshot!),
          durationMs: Math.max(0, this.now() - startedAt),
          presence: snapshot!,
        });
      };
      const inspect = (snapshot: AgentPresenceSnapshot | null): void => {
        if (settled || !snapshot || snapshot.terminalId !== terminalId) return;
        if (snapshot.identitySeq !== expectedIdentitySeq) {
          finish(
            failure(
              'AGENT_REPLACED',
              `Agent ${terminalId} was replaced or restarted while waiting. Read its status before continuing.`,
              {
                terminalId,
                expectedIdentitySeq,
                actualIdentitySeq: snapshot.identitySeq,
              },
            ),
          );
          return;
        }
        if (snapshot.stateChangeSeq <= afterSeq) return;
        const state = semanticState(snapshot);
        if (requested.has(state)) {
          finish(null, snapshot);
          return;
        }
        if (state === 'exited') {
          finish(
            failure(
              'AGENT_PROCESS_EXITED',
              `Agent ${terminalId} exited before reaching ${input.until.join(', ')}.`,
              { terminalId, stateChangeSeq: snapshot.stateChangeSeq },
            ),
          );
        }
      };
      const onAbort = (): void =>
        finish(failure('CANCELLED', `Waiting for Agent ${terminalId} was cancelled.`));

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      const stop = this.presence.onChanged(inspect);
      unsubscribe = stop;
      // The production Presence subscription is passive, but keeping this
      // safe for synchronous event sources prevents a completed waiter from
      // retaining the just-installed listener.
      if (settled) {
        stop();
        return;
      }
      timeout = setTimeout(() => {
        finish(
          failure(
            'AGENT_WAIT_TIMEOUT',
            `Agent ${terminalId} did not reach ${input.until.join(', ')} within ${input.timeoutMs}ms.`,
            { terminalId, expectedIdentitySeq, afterSeq, until: input.until },
            true,
          ),
        );
      }, input.timeoutMs);
      timeout.unref?.();
      // Subscribe before the re-read so an edge between target resolution and
      // waiter installation cannot be lost.
      inspect(this.presence.get(terminalId));
    });
  }

  async prompt(
    caller: TerminalToolCaller,
    input: { id: string; text: string; timeoutMs: number },
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) {
      throw failure('CANCELLED', `Prompting Agent ${input.id} was cancelled.`);
    }
    this.preflightPrompt(caller, input);
    const terminalId = this.terminals.resolveTarget(input.id);
    const before = this.requirePresence(terminalId);
    const state = semanticState(before);
    if (state === 'exited') {
      throw failure('AGENT_PROCESS_EXITED', `Agent ${terminalId} has exited.`, { terminalId });
    }
    if (state !== 'idle' && state !== 'blocked') {
      throw failure(
        'AGENT_NOT_READY',
        `Agent ${terminalId} is ${state}; wait until it is idle or blocked before prompting it.`,
        {
          terminalId,
          state,
          identitySeq: before.identitySeq,
          stateChangeSeq: before.stateChangeSeq,
        },
        true,
      );
    }

    const waiterController = new AbortController();
    const forwardAbort = (): void => waiterController.abort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    // The waiter must exist before input is injected: a fast Agent can publish
    // Working synchronously with terminal.send.
    const started = this.wait(
      caller,
      {
        id: terminalId,
        until: ['working'],
        timeoutMs: input.timeoutMs,
        afterSeq: before.stateChangeSeq,
        identitySeq: before.identitySeq,
      },
      waiterController.signal,
    );
    // Attach a handler immediately: replacement/exit may arrive while the
    // asynchronous terminal write is still settling.
    void started.catch(() => undefined);
    try {
      // A pre-existing working edge, replacement, or exit must not be
      // mistaken for activity caused by this prompt. No async boundary exists
      // between this final identity/readiness check and terminal.send.
      const latest = this.requirePresence(terminalId);
      if (latest.identitySeq !== before.identitySeq) {
        throw failure(
          'AGENT_REPLACED',
          `Agent ${terminalId} was replaced or restarted before the prompt could be delivered.`,
          {
            terminalId,
            expectedIdentitySeq: before.identitySeq,
            actualIdentitySeq: latest.identitySeq,
          },
        );
      }
      const latestState = semanticState(latest);
      if (latestState === 'exited') {
        throw failure('AGENT_PROCESS_EXITED', `Agent ${terminalId} exited before delivery.`, {
          terminalId,
        });
      }
      if (latestState !== 'idle' && latestState !== 'blocked') {
        throw failure(
          'AGENT_NOT_READY',
          `Agent ${terminalId} became ${latestState} before delivery; the prompt was not sent.`,
          {
            terminalId,
            state: latestState,
            identitySeq: latest.identitySeq,
            stateChangeSeq: latest.stateChangeSeq,
          },
          true,
        );
      }
      const result = await this.terminals.send(caller, {
        id: terminalId,
        text: input.text,
        submit: true,
        queueIfBlocked: false,
      });
      if (queued(result)) {
        const reason = queueReason(result);
        waiterController.abort();
        await started.catch(() => undefined);
        throw failure(
          'AGENT_PROMPT_QUEUED',
          `The prompt for Agent ${terminalId} could not be delivered because of ${reason}. It was not retained for later delivery.`,
          { terminalId, reason },
          true,
        );
      }
      try {
        const transition = (await started) as {
          matched: AgentWaitState;
          presence: AgentPresenceSnapshot;
          durationMs: number;
        };
        this.logger.info('semantic agent prompt started', {
          terminalId,
          taskId: caller.taskId,
          identitySeq: transition.presence.identitySeq,
          stateChangeSeq: transition.presence.stateChangeSeq,
        });
        return {
          terminalId,
          accepted: true,
          fromStateChangeSeq: before.stateChangeSeq,
          identitySeq: transition.presence.identitySeq,
          startedStateChangeSeq: transition.presence.stateChangeSeq,
          durationMs: transition.durationMs,
          presence: transition.presence,
        };
      } catch (error) {
        if (error instanceof ProductFailure && error.error.code === 'AGENT_WAIT_TIMEOUT') {
          throw failure(
            'AGENT_PROMPT_STALLED',
            `The prompt was delivered to Agent ${terminalId}, but no newer Working transition was observed within ${input.timeoutMs}ms.`,
            {
              terminalId,
              identitySeq: before.identitySeq,
              afterSeq: before.stateChangeSeq,
            },
            true,
          );
        }
        throw error;
      }
    } catch (error) {
      waiterController.abort();
      await started.catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener('abort', forwardAbort);
    }
  }

  private requirePresence(terminalId: string): AgentPresenceSnapshot {
    const snapshot = this.presence.get(terminalId);
    if (!snapshot) throw this.notFound(terminalId);
    return snapshot;
  }

  private recordDiscoveredSession(
    session: AgentResultSession | null,
    native: NativeAgentResult,
  ): void {
    if (!session?.taskId || session.sessionId === native.sessionId) return;
    this.options.recordSessionId?.(session.taskId, native.sessionId);
  }

  private notFound(terminalId: string): ProductFailure {
    return failure(
      'AGENT_NOT_FOUND',
      `Terminal ${terminalId} does not currently contain a recognized Agent process.`,
      { terminalId },
    );
  }

  private transcriptUnavailableMessage(
    terminalId: string,
    reason:
      | 'not_alternate_screen'
      | 'mouse_reporting_unavailable'
      | 'viewport_not_at_bottom'
      | 'read_in_progress',
  ): string {
    if (reason === 'not_alternate_screen') {
      return `Agent ${terminalId} is not using an alternate-screen TUI; use mode=screen.`;
    }
    if (reason === 'mouse_reporting_unavailable') {
      return `Agent ${terminalId} does not expose supported mouse-wheel transcript scrolling; use mode=screen.`;
    }
    if (reason === 'viewport_not_at_bottom') {
      return `Agent ${terminalId} was already scrolled above the bottom. Return it to the bottom, then retry.`;
    }
    return `Agent ${terminalId} already has a transcript read in progress; retry after it completes.`;
  }

  private statusResult(snapshot: AgentPresenceSnapshot): unknown {
    const state = semanticState(snapshot);
    return {
      terminalId: snapshot.terminalId,
      state,
      ready: state === 'idle' || state === 'blocked',
      needsUser: state === 'blocked',
      identitySeq: snapshot.identitySeq,
      stateChangeSeq: snapshot.stateChangeSeq,
      presence: snapshot,
    };
  }
}
