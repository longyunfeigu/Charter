import type {
  AbortReason,
  AgentEvent,
  AgentRuntime,
  CreateSessionInput,
  CredentialCheck,
  ModelDescriptor,
  ModelUsage,
  RuntimeInfo,
  RuntimeInit,
  RuntimeSessionRef,
  StartRunInput,
  ToolExecutor,
  ToolResultPayload,
  VisibleMessage,
} from '@pi-ide/agent-contract';
import { AGENT_EVENT_SCHEMA_VERSION } from '@pi-ide/agent-contract';
import { delay, newId, productError } from '@pi-ide/foundation';
import { resolveScenario, type ScenarioStep } from './scenarios.js';

interface RunHandle {
  controller: AbortController;
  abortReason: AbortReason | null;
  steerQueue: string[];
  followUpQueue: string[];
}

export interface MockRuntimeOptions {
  toolExecutor: ToolExecutor;
  /** Delay between emitted events; keep at 0-1ms in tests, higher for realistic demos. */
  pacingMs?: number;
}

/**
 * Deterministic AgentRuntime used by unit tests, E2E and dev mode (AG-012).
 * It exercises the exact same host ToolExecutor path as the real Pi runtime,
 * so permission, gateway and change flows are fully covered without a model.
 */
export class MockAgentRuntime implements AgentRuntime {
  private readonly toolExecutor: ToolExecutor;
  private readonly pacingMs: number;
  private readonly sessions = new Map<string, CreateSessionInput>();
  private readonly runs = new Map<string, RunHandle>();

  constructor(opts: MockRuntimeOptions) {
    this.toolExecutor = opts.toolExecutor;
    this.pacingMs = opts.pacingMs ?? 1;
  }

  async initialize(_input: RuntimeInit): Promise<RuntimeInfo> {
    return { runtimeId: 'mock', runtimeVersion: '1.0.0' };
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeSessionRef> {
    const ref: RuntimeSessionRef = {
      sessionId: newId('mocksess'),
      runtimeId: 'mock',
      externalSessionId: null,
      externalSessionFile: null,
    };
    this.sessions.set(ref.sessionId, input);
    return ref;
  }

  async resumeSession(ref: RuntimeSessionRef): Promise<RuntimeSessionRef> {
    if (!this.sessions.has(ref.sessionId)) {
      // Recreate a minimal session context for restored references.
      this.sessions.set(ref.sessionId, {
        taskId: 'restored',
        workspaceRoot: '/',
        mode: 'ask',
        model: { providerId: 'mock', modelId: 'mock-1' },
        tools: [],
        systemPreamble: '',
      });
    }
    return ref;
  }

  startRun(input: StartRunInput): AsyncIterable<AgentEvent> {
    const session = this.sessions.get(input.sessionRef.sessionId);
    const handle: RunHandle = {
      controller: new AbortController(),
      abortReason: null,
      steerQueue: [],
      followUpQueue: [],
    };
    this.runs.set(input.runId, handle);
    return this.generate(input, session, handle);
  }

  private async *generate(
    input: StartRunInput,
    session: CreateSessionInput | undefined,
    handle: RunHandle,
  ): AsyncGenerator<AgentEvent> {
    let sequence = 0;
    const base = () => ({
      sequence: ++sequence,
      at: new Date().toISOString(),
      runId: input.runId,
      schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    });
    const aborted = () => handle.abortReason !== null;

    try {
      yield { ...base(), type: 'run.started' };
      if (!session) {
        yield {
          ...base(),
          type: 'run.failed',
          error: productError('AG_SESSION_NOT_FOUND', {
            userMessage: 'The agent session no longer exists.',
          }),
        };
        return;
      }

      const { steps } = resolveScenario({ prompt: input.prompt, session });
      const usage: ModelUsage = {
        provider: 'mock',
        model: session.model.modelId,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: 0,
        costUsd: null,
      };
      let sawFailure = false;

      for (const step of steps) {
        if (aborted()) break;
        const emitted = yield* this.emitStep(step, base, handle, session, input);
        if (emitted === 'failed') {
          sawFailure = true;
          break;
        }
        // Steering: acknowledge queued steer messages between steps.
        while (handle.steerQueue.length > 0 && !aborted()) {
          const steer = handle.steerQueue.shift()!;
          const message: VisibleMessage = {
            messageId: newId('msg'),
            role: 'assistant',
            text: `Adjusting approach based on your instruction: ${steer}`,
            at: new Date().toISOString(),
          };
          yield { ...base(), type: 'message.completed', message };
        }
        if (step.kind === 'usage') {
          usage.inputTokens = (usage.inputTokens ?? 0) + step.inputTokens;
          usage.outputTokens = (usage.outputTokens ?? 0) + step.outputTokens;
          usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
          yield { ...base(), type: 'usage.updated', usage: { ...usage } };
        }
      }

      // Follow-ups queue one extra assistant turn.
      while (handle.followUpQueue.length > 0 && !aborted() && !sawFailure) {
        const followUp = handle.followUpQueue.shift()!;
        const message: VisibleMessage = {
          messageId: newId('msg'),
          role: 'assistant',
          text: `Follow-up handled: ${followUp} (deterministic mock answer)`,
          at: new Date().toISOString(),
        };
        yield { ...base(), type: 'message.completed', message };
      }

      if (aborted()) {
        yield { ...base(), type: 'run.aborted', reason: handle.abortReason ?? 'user_stop' };
        return;
      }
      if (!sawFailure) {
        yield { ...base(), type: 'run.completed', stopReason: 'end_turn' };
      }
    } finally {
      this.runs.delete(input.runId);
    }
  }

  private async *emitStep(
    step: ScenarioStep,
    base: () => {
      sequence: number;
      at: string;
      runId: string;
      schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
    },
    handle: RunHandle,
    session: CreateSessionInput,
    input: StartRunInput,
  ): AsyncGenerator<AgentEvent, 'ok' | 'failed'> {
    const aborted = () => handle.abortReason !== null;
    switch (step.kind) {
      case 'wait': {
        await delay(step.ms, handle.controller.signal);
        return 'ok';
      }
      case 'assistant': {
        const messageId = newId('msg');
        const chunkSize = step.chunkSize ?? 32;
        for (let i = 0; i < step.text.length; i += chunkSize) {
          if (aborted()) return 'ok';
          yield {
            ...base(),
            type: 'message.delta',
            messageId,
            text: step.text.slice(i, i + chunkSize),
          };
          if (this.pacingMs > 0) await delay(this.pacingMs, handle.controller.signal);
        }
        if (aborted()) return 'ok';
        const message: VisibleMessage = {
          messageId,
          role: 'assistant',
          text: step.text,
          at: new Date().toISOString(),
        };
        yield { ...base(), type: 'message.completed', message };
        return 'ok';
      }
      case 'plan':
      case 'plan-update': {
        yield {
          ...base(),
          type: step.kind === 'plan' ? 'plan.proposed' : 'plan.updated',
          plan: step.plan,
        };
        return 'ok';
      }
      case 'tool': {
        const callId = newId('call');
        yield {
          ...base(),
          type: 'tool.proposed',
          call: { callId, toolName: step.toolName, input: step.input, reason: step.reason },
        };
        if (aborted()) return 'ok';
        yield { ...base(), type: 'tool.started', callId };
        let result: ToolResultPayload;
        try {
          result = await this.toolExecutor(
            {
              callId,
              runId: input.runId,
              taskId: session.taskId,
              toolName: step.toolName,
              input: step.input,
            },
            handle.controller.signal,
          );
        } catch (e) {
          result = {
            callId,
            ok: false,
            code: 'TOOL_EXECUTOR_ERROR',
            summary: e instanceof Error ? e.message : String(e),
            data: {},
          };
        }
        yield { ...base(), type: 'tool.completed', callId, result };
        return 'ok';
      }
      case 'usage':
        return 'ok'; // emitted by caller so usage accumulates
      case 'compaction': {
        yield {
          ...base(),
          type: 'context.compacted',
          metadata: { reason: 'threshold', beforeTokens: 8000, afterTokens: 2000 },
        };
        return 'ok';
      }
      case 'fail': {
        yield {
          ...base(),
          type: 'run.failed',
          error: productError(step.code, { userMessage: step.message, retryable: true }),
        };
        return 'failed';
      }
    }
  }

  async steer(runId: string, text: string): Promise<void> {
    this.runs.get(runId)?.steerQueue.push(text);
  }

  async followUp(runId: string, text: string): Promise<void> {
    this.runs.get(runId)?.followUpQueue.push(text);
  }

  async abort(runId: string, reason: AbortReason): Promise<void> {
    const handle = this.runs.get(runId);
    if (!handle) return;
    handle.abortReason = reason;
    handle.controller.abort();
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      {
        providerId: 'mock',
        providerName: 'Deterministic Mock',
        modelId: 'mock-1',
        displayName: 'Mock Model 1',
        contextWindow: 128000,
        supportsThinking: true,
        configured: true,
        authKind: 'none',
      },
    ];
  }

  async validateCredential(providerId: string): Promise<CredentialCheck> {
    return { providerId, ok: providerId === 'mock', checkedAt: new Date().toISOString() };
  }

  async dispose(): Promise<void> {
    for (const [runId, handle] of this.runs) {
      handle.abortReason = 'app_quit';
      handle.controller.abort();
      this.runs.delete(runId);
    }
  }
}
