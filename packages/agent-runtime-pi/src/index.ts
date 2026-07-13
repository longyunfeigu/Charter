/**
 * Pi SDK adapter (ADR-0001). This is the ONLY module in the product allowed to
 * import @earendil-works/* (enforced by the boundary linter). It maps the
 * product AgentRuntime contract onto pi's AgentSession:
 *
 * - An explicit tools allowlist exposes exactly the host-gateway proxied
 *   customTools; pi's built-in read/bash/edit/write can never activate.
 * - Credentials arrive in memory from the host Secret Store; pi never writes
 *   them to disk (AuthStorage.inMemory).
 * - Untrusted workspaces get an empty discovery cwd so project-local pi
 *   extensions/skills/prompts are never loaded (AG-014).
 * - Thinking deltas are never forwarded (AG-006): only visible text.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  VERSION as PI_VERSION,
  type AgentSessionEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  AGENT_EVENT_SCHEMA_VERSION,
  type AbortReason,
  type AgentEvent,
  type AgentRuntime,
  type CreateSessionInput,
  type CredentialCheck,
  type ModelDescriptor,
  type ModelUsage,
  type RuntimeInfo,
  type RuntimeInit,
  type RuntimeSessionRef,
  type StartRunInput,
  type ToolExecutor,
  type WorkerCredential,
} from '@pi-ide/agent-contract';
import { newId, productError, toProductError } from '@pi-ide/foundation';

interface SessionEntry {
  session: AgentSession;
  input: CreateSessionInput;
  currentRunId: string | null;
  /** The product system preamble is delivered with the session's first prompt. */
  preambleDelivered: boolean;
}

interface AsyncQueue<T> {
  push(value: T): void;
  close(): void;
  iterate(): AsyncIterable<T>;
}

function createQueue<T>(): AsyncQueue<T> {
  const values: T[] = [];
  let resolveWait: (() => void) | null = null;
  let closed = false;
  return {
    push(value) {
      if (closed) return;
      values.push(value);
      resolveWait?.();
      resolveWait = null;
    },
    close() {
      closed = true;
      resolveWait?.();
      resolveWait = null;
    },
    async *iterate() {
      for (;;) {
        while (values.length > 0) yield values.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
        });
      }
    },
  };
}

export interface PiRuntimeOptions {
  toolExecutor: ToolExecutor;
  credentials: WorkerCredential[];
}

export class PiAgentRuntime implements AgentRuntime {
  private readonly toolExecutor: ToolExecutor;
  private readonly credentials: WorkerCredential[];
  private auth!: AuthStorage;
  private registry!: ModelRegistry;
  private dataDir = '';
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly runs = new Map<string, { sessionId: string; aborted: AbortReason | null }>();

  constructor(options: PiRuntimeOptions) {
    this.toolExecutor = options.toolExecutor;
    this.credentials = options.credentials;
  }

  async initialize(input: RuntimeInit): Promise<RuntimeInfo> {
    this.dataDir = input.runtimeDataDir;
    mkdirSync(join(this.dataDir, 'sessions'), { recursive: true });
    mkdirSync(join(this.dataDir, 'sandbox'), { recursive: true });
    const data: Record<string, { type: 'api_key'; key: string }> = {};
    for (const credential of this.credentials) {
      data[credential.providerId] = { type: 'api_key', key: credential.value };
    }
    this.auth = AuthStorage.inMemory(data);
    this.registry = ModelRegistry.inMemory(this.auth);
    // Gateway/proxy support: a credential base URL re-points every model of
    // that provider at the custom endpoint (pi keeps the provider's API shape).
    for (const credential of this.credentials) {
      if (credential.baseUrl) {
        this.registry.registerProvider(credential.providerId, { baseUrl: credential.baseUrl });
      }
    }
    return { runtimeId: 'pi', runtimeVersion: PI_VERSION };
  }

  /** API shape for a provider when synthesizing gateway-listed models. */
  private apiFor(providerId: string): 'anthropic-messages' | 'openai-completions' {
    return providerId === 'openai' ? 'openai-completions' : 'anthropic-messages';
  }

  /**
   * A custom gateway may list model ids pi's registry does not know built-in.
   * Synthesize a registration for the missing id (keeping every existing model
   * of that provider) so the user can run exactly what their gateway offers.
   */
  private ensureModel(providerId: string, modelId: string): void {
    if (this.registry.find(providerId, modelId)) return;
    const credential = this.credentials.find((c) => c.providerId === providerId);
    if (!credential?.baseUrl) return; // only synthesize for custom endpoints
    type RegisteredModel = {
      id: string;
      name: string;
      reasoning: boolean;
      input: Array<'text' | 'image'>;
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
    };
    const existing = (
      this.registry.getAll() as Array<{
        provider: string;
        id: string;
        name?: string;
        reasoning?: boolean;
        input?: Array<'text' | 'image'>;
        cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
        contextWindow?: number;
        maxTokens?: number;
      }>
    ).filter((m) => m.provider === providerId);
    const models: RegisteredModel[] = existing.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      reasoning: Boolean(m.reasoning),
      input: m.input ?? ['text'],
      cost: {
        input: m.cost?.input ?? 0,
        output: m.cost?.output ?? 0,
        cacheRead: m.cost?.cacheRead ?? 0,
        cacheWrite: m.cost?.cacheWrite ?? 0,
      },
      contextWindow: m.contextWindow ?? 200000,
      maxTokens: m.maxTokens ?? 8192,
    }));
    models.push({
      id: modelId,
      name: modelId,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    });
    this.registry.registerProvider(providerId, {
      baseUrl: credential.baseUrl,
      api: this.apiFor(providerId),
      models,
    });
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeSessionRef> {
    this.ensureModel(input.model.providerId, input.model.modelId);
    const model = this.registry.find(input.model.providerId, input.model.modelId);
    if (!model) {
      throw toProductError(
        productError('AG_MODEL_NOT_FOUND', {
          userMessage: `Model ${input.model.providerId}/${input.model.modelId} is not available.`,
        }),
        'AG_MODEL_NOT_FOUND',
      );
    }

    const sessionId = newId('pisess');
    const customTools: ToolDefinition[] = input.tools.map((entry) => ({
      name: entry.name,
      label: entry.name,
      description: entry.description,
      // Raw JSON Schema is structurally a TSchema; pi serializes it for the LLM
      // and validates with typebox's standard-keyword interpreter.
      parameters: (entry.inputJsonSchema ?? { type: 'object', properties: {} }) as never,
      execute: async (toolCallId, params, signal) => {
        const entry2 = this.sessions.get(sessionId);
        const runId = entry2?.currentRunId ?? 'unknown';
        const result = await this.toolExecutor(
          {
            callId: toolCallId,
            runId,
            taskId: input.taskId,
            toolName: entry.name,
            input: params,
          },
          signal ?? new AbortController().signal,
        );
        const text = [
          `[${result.ok ? 'ok' : 'error'}:${result.code}] ${result.summary}`,
          typeof result.data === 'object' &&
          result.data !== null &&
          Object.keys(result.data as object).length > 0
            ? JSON.stringify(result.data).slice(0, 400000)
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        return {
          content: [{ type: 'text', text }],
          isError: !result.ok,
          details: result.data,
        } as never;
      },
    }));

    const sessionDir = join(this.dataDir, 'sessions', input.taskId);
    mkdirSync(sessionDir, { recursive: true });
    // Untrusted workspaces: discovery happens in an empty sandbox (AG-014).
    const discoveryCwd = join(this.dataDir, 'sandbox');

    const { session } = await createAgentSession({
      cwd: discoveryCwd,
      agentDir: join(this.dataDir, 'agent'),
      authStorage: this.auth,
      modelRegistry: this.registry,
      model,
      thinkingLevel: (input.model.thinkingLevel ?? 'medium') as never,
      // Explicit allowlist: exactly the gateway tools, nothing else. Pi's
      // built-in read/bash/edit/write can never activate (TOOL-001).
      tools: input.tools.map((t) => t.name),
      customTools,
      sessionManager: SessionManager.create(discoveryCwd, sessionDir),
      settingsManager: SettingsManager.inMemory(),
    });

    this.sessions.set(sessionId, { session, input, currentRunId: null, preambleDelivered: false });
    return {
      sessionId,
      runtimeId: 'pi',
      externalSessionId: session.sessionId,
      externalSessionFile: session.sessionFile ?? null,
    };
  }

  async resumeSession(ref: RuntimeSessionRef): Promise<RuntimeSessionRef> {
    if (this.sessions.has(ref.sessionId)) return ref;
    throw toProductError(
      productError('AG_SESSION_NOT_RESUMABLE', {
        userMessage:
          'The previous agent session cannot be resumed in this worker; a new session will be created.',
        retryable: true,
      }),
      'AG_SESSION_NOT_RESUMABLE',
    );
  }

  startRun(input: StartRunInput): AsyncIterable<AgentEvent> {
    const entry = this.sessions.get(input.sessionRef.sessionId);
    const queue = createQueue<AgentEvent>();
    let sequence = 0;
    const base = () => ({
      sequence: ++sequence,
      at: new Date().toISOString(),
      runId: input.runId,
      schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    });

    if (!entry) {
      queue.push({
        ...base(),
        type: 'run.failed',
        error: productError('AG_SESSION_NOT_FOUND', { userMessage: 'Agent session not found.' }),
      });
      queue.close();
      return queue.iterate();
    }

    this.runs.set(input.runId, { sessionId: input.sessionRef.sessionId, aborted: null });
    entry.currentRunId = input.runId;

    const messageBuffers = new Map<string, string>();
    let lastUsage: ModelUsage | null = null;
    let sawError: string | null = null;

    const unsubscribe = entry.session.subscribe((event: AgentSessionEvent) => {
      try {
        switch (event.type) {
          case 'message_update': {
            const message = event.message as { role?: string; content?: unknown };
            if (message.role !== 'assistant') break;
            const streamEvent = event.assistantMessageEvent as {
              type?: string;
              delta?: string;
              text?: string;
            };
            // Visible text only — thinking deltas are never forwarded (AG-006).
            if (streamEvent?.type === 'text_delta') {
              const delta = streamEvent.delta ?? streamEvent.text ?? '';
              if (delta) {
                const id = messageIdOf(event.message) ?? 'assistant';
                messageBuffers.set(id, (messageBuffers.get(id) ?? '') + delta);
                queue.push({ ...base(), type: 'message.delta', messageId: id, text: delta });
              }
            }
            break;
          }
          case 'message_end': {
            const message = event.message as {
              role?: string;
              content?: Array<{ type: string; text?: string }>;
              usage?: {
                input?: number;
                output?: number;
                cacheRead?: number;
                cacheWrite?: number;
                cost?: { total?: number };
              };
              stopReason?: string;
              errorMessage?: string;
            };
            if (message.role !== 'assistant') break;
            const text = (message.content ?? [])
              .filter((c) => c.type === 'text')
              .map((c) => c.text ?? '')
              .join('');
            const id = messageIdOf(event.message) ?? newId('msg');
            if (text.trim().length > 0) {
              queue.push({
                ...base(),
                type: 'message.completed',
                message: { messageId: id, role: 'assistant', text, at: new Date().toISOString() },
              });
            }
            if (message.usage) {
              lastUsage = {
                provider: entry.input.model.providerId,
                model: entry.input.model.modelId,
                inputTokens: message.usage.input ?? null,
                outputTokens: message.usage.output ?? null,
                cacheReadTokens: message.usage.cacheRead ?? null,
                cacheWriteTokens: message.usage.cacheWrite ?? null,
                totalTokens:
                  message.usage.input !== undefined || message.usage.output !== undefined
                    ? (message.usage.input ?? 0) + (message.usage.output ?? 0)
                    : null,
                costUsd: message.usage.cost?.total ?? null,
              };
              queue.push({ ...base(), type: 'usage.updated', usage: lastUsage });
            }
            if (message.stopReason === 'error' && message.errorMessage) {
              sawError = message.errorMessage;
            }
            break;
          }
          case 'tool_execution_start': {
            queue.push({
              ...base(),
              type: 'tool.proposed',
              call: { callId: event.toolCallId, toolName: event.toolName, input: event.args },
            });
            queue.push({ ...base(), type: 'tool.started', callId: event.toolCallId });
            break;
          }
          case 'tool_execution_end': {
            const result = event.result as {
              content?: Array<{ type: string; text?: string }>;
              details?: unknown;
            };
            const summaryText =
              result?.content?.find((c) => c.type === 'text')?.text?.slice(0, 300) ?? '';
            queue.push({
              ...base(),
              type: 'tool.completed',
              callId: event.toolCallId,
              result: {
                callId: event.toolCallId,
                ok: !event.isError,
                code: event.isError ? 'TOOL_ERROR' : 'OK',
                summary: summaryText,
                data: (result?.details as unknown) ?? {},
              },
            });
            break;
          }
          case 'compaction_end': {
            queue.push({
              ...base(),
              type: 'context.compacted',
              metadata: {
                reason: event.reason,
                beforeTokens: null,
                afterTokens: null,
              },
            });
            break;
          }
          case 'auto_retry_start': {
            queue.push({
              ...base(),
              type: 'runtime.diagnostic',
              code: 'AG_AUTO_RETRY',
              detail: `Provider error, retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage.slice(0, 200)}`,
            });
            break;
          }
          default:
            break;
        }
      } catch {
        queue.push({
          ...base(),
          type: 'runtime.diagnostic',
          code: 'AG_EVENT_MAP_FAILED',
          detail: `Unmapped runtime event: ${String((event as { type?: string }).type)}`,
        });
      }
    });

    queue.push({ ...base(), type: 'run.started' });

    // The pi SDK has no per-session system-prompt hook, so the product preamble
    // (mode rules, plan gate, Charter identity — AG-001/007, PIVOT-008) rides in
    // front of the session's first prompt exactly once.
    let promptText = input.prompt;
    if (!entry.preambleDelivered && entry.input.systemPreamble.trim().length > 0) {
      entry.preambleDelivered = true;
      promptText = `<charter-instructions>\n${entry.input.systemPreamble}\n</charter-instructions>\n\n${input.prompt}`;
    }

    void entry.session
      .prompt(promptText)
      .then(() => {
        const run = this.runs.get(input.runId);
        if (run?.aborted) {
          queue.push({ ...base(), type: 'run.aborted', reason: run.aborted });
        } else if (sawError) {
          queue.push({
            ...base(),
            type: 'run.failed',
            error: productError('AG_PROVIDER_ERROR', {
              userMessage: sawError.slice(0, 500),
              retryable: true,
            }),
          });
        } else {
          queue.push({ ...base(), type: 'run.completed', stopReason: 'end_turn' });
        }
      })
      .catch((e) => {
        const run = this.runs.get(input.runId);
        if (run?.aborted) {
          queue.push({ ...base(), type: 'run.aborted', reason: run.aborted });
        } else {
          queue.push({ ...base(), type: 'run.failed', error: toProductError(e, 'AG_RUN_FAILED') });
        }
      })
      .finally(() => {
        unsubscribe();
        entry.currentRunId = null;
        this.runs.delete(input.runId);
        queue.close();
      });

    return queue.iterate();
  }

  async steer(runId: string, text: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    const entry = this.sessions.get(run.sessionId);
    await entry?.session.prompt(text, { streamingBehavior: 'steer' });
  }

  async followUp(runId: string, text: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    const entry = this.sessions.get(run.sessionId);
    await entry?.session.prompt(text, { streamingBehavior: 'followUp' });
  }

  async abort(runId: string, reason: AbortReason): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    run.aborted = reason;
    const entry = this.sessions.get(run.sessionId);
    await entry?.session.abort();
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const models = this.registry.getAvailable() as Array<{
      provider: string;
      id: string;
      name?: string;
      contextWindow?: number;
      reasoning?: boolean;
    }>;
    const configured = new Set(this.credentials.map((c) => c.providerId));
    return models.map((model) => ({
      providerId: model.provider,
      providerName: model.provider,
      modelId: model.id,
      displayName: model.name ?? model.id,
      contextWindow: model.contextWindow ?? null,
      supportsThinking: Boolean(model.reasoning),
      configured: configured.has(model.provider),
      authKind: configured.has(model.provider) ? 'api-key' : 'unknown',
    }));
  }

  async validateCredential(providerId: string): Promise<CredentialCheck> {
    const credential = this.auth.get(providerId);
    return {
      providerId,
      ok: credential !== undefined,
      checkedAt: new Date().toISOString(),
      ...(credential === undefined
        ? {
            errorKind: 'invalid-credential' as const,
            error: productError('AG_NO_CREDENTIAL', {
              userMessage: 'No credential is stored for this provider.',
            }),
          }
        : {}),
    };
  }

  /** Test-only accessor for contract tests. */
  sessionForTest(sessionId: string): AgentSession | null {
    return this.sessions.get(sessionId)?.session ?? null;
  }

  async dispose(): Promise<void> {
    for (const [runId] of this.runs) {
      await this.abort(runId, 'app_quit');
    }
    for (const entry of this.sessions.values()) {
      entry.session.dispose();
    }
    this.sessions.clear();
  }
}

function messageIdOf(message: unknown): string | null {
  const m = message as { id?: string; messageId?: string };
  return m.id ?? m.messageId ?? null;
}
