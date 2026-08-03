import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { Logger } from '@pi-ide/foundation';
import type {
  AgentCapabilities,
  ClientConnection,
  ClientContext,
  InitializeResponse,
  McpServer,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { MissionRepository } from '@pi-ide/persistence';
import type {
  OrchestrationRuntimeAdapter,
  RuntimeObservation,
  RuntimeReconciliation,
  RuntimeSessionBinding,
  RuntimeStartRequest,
} from './orchestration-runtime-registry.js';
import { missionWorkerPrompt } from './visible-terminal-runtime.js';

/** Opaque Agent Catalog id. Provider behavior is resolved by the process command factory. */
export type AcpProvider = string;

export interface AcpProcessCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AcpSessionMcp {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AcpRuntimeOptions {
  missionMcp(input: RuntimeStartRequest, virtualIdentity: string): AcpSessionMcp;
  bindVirtualIdentity(identity: string, input: RuntimeStartRequest): void;
  releaseVirtualIdentity(identity: string): void;
}

interface AcpSession {
  provider: AcpProvider;
  sessionId: string;
  processKey: string;
  initialPrompt: string;
  attemptId: string;
  runtimeRecordId: string;
  busy: boolean;
  paused: boolean;
  ended: boolean;
  queued: QueuedAcpPrompt[];
}

interface QueuedAcpPrompt {
  text: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface AcpProcess {
  provider: AcpProvider;
  key: string;
  child: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  context: ClientContext;
  initialized: InitializeResponse;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('The ACP delivery was aborted.');
  error.name = 'AbortError';
  return error;
}

const ACP_RUNTIME_EVENT_MAX_BYTES = 16 * 1024;
const ACP_SUMMARY_KEYS = [
  'sessionUpdate',
  'toolCallId',
  'title',
  'kind',
  'status',
  'name',
  'path',
  'locations',
  'content',
] as const;

function compactAcpMetadata(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length <= 512
      ? value
      : { preview: value.slice(0, 512), truncated: true, originalChars: value.length };
  }
  if (depth >= 2) return { truncated: true };
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => compactAcpMetadata(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return String(value);
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 12)
      .map(([key, item]) => [key, compactAcpMetadata(item, depth + 1)]),
  );
}

/**
 * ACP tool updates can contain complete command output and base64 images.
 * Persist useful lifecycle metadata, but never let one protocol notification
 * turn into a multi-megabyte SQLite write and Mission IPC payload.
 */
export function compactAcpRuntimeEvent(value: unknown): Record<string, unknown> {
  const payload = jsonObject(value);
  const serialized = JSON.stringify(payload);
  const originalBytes = Buffer.byteLength(serialized);
  if (originalBytes <= ACP_RUNTIME_EVENT_MAX_BYTES) return payload;

  const compact = Object.fromEntries(
    ACP_SUMMARY_KEYS.flatMap((key) =>
      key in payload ? [[key, compactAcpMetadata(payload[key])] as const] : [],
    ),
  ) as Record<string, unknown>;
  compact.truncated = true;
  compact.originalBytes = originalBytes;
  if (Buffer.byteLength(JSON.stringify(compact)) <= ACP_RUNTIME_EVENT_MAX_BYTES) return compact;
  return {
    sessionUpdate:
      typeof payload.sessionUpdate === 'string' ? payload.sessionUpdate : 'unknown_update',
    truncated: true,
    originalBytes,
  };
}

/** One long-lived ACP process per provider, with multiple independent sessions. */
export class AcpProcessPool {
  private readonly processes = new Map<AcpProvider, Promise<AcpProcess>>();
  private readonly updateHandlers = new Map<string, (notification: SessionNotification) => void>();

  constructor(
    private readonly command: (provider: AcpProvider) => AcpProcessCommand,
    private readonly logger: Logger,
  ) {}

  async newSession(
    provider: AcpProvider,
    cwd: string,
    mcpServers: McpServer[],
    onUpdate: (notification: SessionNotification) => void,
  ): Promise<{
    sessionId: string;
    processKey: string;
    capabilities: AgentCapabilities;
  }> {
    const process = await this.process(provider);
    const result = await process.context.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers,
    });
    this.updateHandlers.set(result.sessionId, onUpdate);
    return {
      sessionId: result.sessionId,
      processKey: process.key,
      capabilities: process.initialized.agentCapabilities ?? {},
    };
  }

  async prompt(provider: AcpProvider, sessionId: string, text: string) {
    const process = await this.process(provider);
    return await process.context.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
  }

  async loadSession(
    provider: AcpProvider,
    sessionId: string,
    cwd: string,
    mcpServers: McpServer[],
    onUpdate: (notification: SessionNotification) => void,
  ): Promise<{ processKey: string; capabilities: AgentCapabilities } | null> {
    const process = await this.process(provider);
    if (!process.initialized.agentCapabilities?.loadSession) return null;
    this.updateHandlers.set(sessionId, onUpdate);
    try {
      await process.context.request(acp.methods.agent.session.load, {
        sessionId,
        cwd,
        mcpServers,
      });
    } catch (error) {
      this.updateHandlers.delete(sessionId);
      throw error;
    }
    return {
      processKey: process.key,
      capabilities: process.initialized.agentCapabilities ?? {},
    };
  }

  async cancel(provider: AcpProvider, sessionId: string): Promise<void> {
    const process = await this.process(provider);
    await process.context.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  async close(provider: AcpProvider, sessionId: string): Promise<void> {
    const process = await this.process(provider);
    const supportsClose = Boolean(
      process.initialized.agentCapabilities?.sessionCapabilities?.close,
    );
    if (supportsClose) {
      await process.context.request(acp.methods.agent.session.close, { sessionId });
    } else {
      await process.context.notify(acp.methods.agent.session.cancel, { sessionId });
    }
    this.updateHandlers.delete(sessionId);
  }

  observation(provider: AcpProvider): RuntimeObservation {
    const process = this.processes.get(provider);
    return process ? { state: 'running', detail: 'ACP process connected' } : { state: 'missing' };
  }

  async shutdown(): Promise<void> {
    const processes = await Promise.allSettled(this.processes.values());
    this.processes.clear();
    this.updateHandlers.clear();
    for (const result of processes) {
      if (result.status !== 'fulfilled') continue;
      result.value.connection.close();
      result.value.child.kill();
    }
  }

  private process(provider: AcpProvider): Promise<AcpProcess> {
    const existing = this.processes.get(provider);
    if (existing) return existing;
    const created = this.spawnProcess(provider).catch((error) => {
      this.processes.delete(provider);
      throw error;
    });
    this.processes.set(provider, created);
    return created;
  }

  private async spawnProcess(provider: AcpProvider): Promise<AcpProcess> {
    const spec = this.command(provider);
    const child = spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.logger.debug('ACP agent stderr', { provider, output: chunk.slice(-4_000) });
    });
    const app = acp
      .client({ name: 'charter-mission-fabric' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        const selected =
          params.options.find((option) => option.kind === 'allow_always') ??
          params.options.find((option) => option.kind === 'allow_once') ??
          params.options[0];
        return selected
          ? { outcome: { outcome: 'selected' as const, optionId: selected.optionId } }
          : { outcome: { outcome: 'cancelled' as const } };
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        this.updateHandlers.get(params.sessionId)?.(params);
      });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    child.once('exit', (code, signal) => {
      connection.close(new Error(`ACP ${provider} exited (${code ?? signal ?? 'unknown'}).`));
      this.processes.delete(provider);
    });
    const initialized = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'charter-mission-fabric', version: '1.0.0' },
    });
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      connection.close();
      child.kill();
      throw new Error(
        `ACP ${provider} negotiated unsupported protocol ${initialized.protocolVersion}.`,
      );
    }
    const key = `${provider}:${child.pid ?? 'process'}`;
    this.logger.info('ACP agent connected', {
      provider,
      processKey: key,
      agent: initialized.agentInfo?.name ?? provider,
    });
    return { provider, key, child, connection, context: connection.agent, initialized };
  }
}

export class AcpRuntimeAdapter implements OrchestrationRuntimeAdapter {
  readonly kind = 'external-cli' as const;
  private readonly sessions = new Map<string, AcpSession>();

  constructor(
    private readonly provider: AcpProvider,
    private readonly pool: AcpProcessPool,
    private readonly repository: MissionRepository,
    private readonly options: AcpRuntimeOptions,
    private readonly logger: Logger,
  ) {}

  async start(input: RuntimeStartRequest): Promise<RuntimeSessionBinding> {
    const virtualIdentity = `acp:${input.attempt.id}`;
    this.options.bindVirtualIdentity(virtualIdentity, input);
    try {
      const mcp = this.options.missionMcp(input, virtualIdentity);
      const session = await this.pool.newSession(
        this.provider,
        input.workspaceRoot,
        [
          {
            name: 'charter',
            command: mcp.command,
            args: mcp.args,
            env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })),
          },
        ],
        (notification) => this.onUpdate(input, notification),
      );
      const runtimeSessionId = `acp:${this.provider}:${session.sessionId}`;
      this.sessions.set(runtimeSessionId, {
        provider: this.provider,
        sessionId: session.sessionId,
        processKey: session.processKey,
        initialPrompt: missionWorkerPrompt(input),
        attemptId: input.attempt.id,
        runtimeRecordId: `runtime:${input.attempt.id}`,
        busy: false,
        paused: false,
        ended: false,
        queued: [],
      });
      return {
        runtimeSessionId,
        terminalId: virtualIdentity,
        transport: 'acp',
        provider: this.provider,
        externalSessionId: session.sessionId,
        processKey: session.processKey,
        capabilities: {
          protocolVersion: acp.PROTOCOL_VERSION,
          ...jsonObject(session.capabilities),
        },
      };
    } catch (error) {
      this.options.releaseVirtualIdentity(virtualIdentity);
      throw error;
    }
  }

  async activate(runtimeSessionId: string): Promise<void> {
    const session = this.requireSession(runtimeSessionId);
    const prompt = session.initialPrompt;
    session.initialPrompt = '';
    this.runPrompt(session, prompt);
  }

  async deliver(runtimeSessionId: string, message: string, signal?: AbortSignal): Promise<void> {
    const session = this.requireSession(runtimeSessionId);
    await this.enqueueOrPrompt(session, message, signal);
  }

  async steer(runtimeSessionId: string, text: string, signal?: AbortSignal): Promise<void> {
    const session = this.requireSession(runtimeSessionId);
    await this.enqueueOrPrompt(session, text, signal);
  }

  async pause(runtimeSessionId: string): Promise<void> {
    this.requireSession(runtimeSessionId).paused = true;
  }

  async resume(runtimeSessionId: string): Promise<void> {
    const session = this.requireSession(runtimeSessionId);
    session.paused = false;
    this.flush(session);
  }

  async cancel(runtimeSessionId: string, reason: string): Promise<void> {
    const session = this.requireSession(runtimeSessionId);
    session.ended = true;
    this.rejectQueued(session, new Error(`The ACP session was cancelled: ${reason}`));
    await this.pool.cancel(session.provider, session.sessionId);
    await this.pool.close(session.provider, session.sessionId);
    this.options.releaseVirtualIdentity(`acp:${session.attemptId}`);
    this.repository.appendRuntimeEvent(
      session.runtimeRecordId,
      session.attemptId,
      'session.closed',
      {
        reason,
      },
    );
    this.sessions.delete(runtimeSessionId);
  }

  async inspect(runtimeSessionId: string): Promise<RuntimeObservation> {
    const session = this.sessions.get(runtimeSessionId);
    if (!session) return { state: 'missing' };
    if (session.ended) return { state: 'ended' };
    return session.busy
      ? { state: 'running', detail: `ACP ${session.provider} turn` }
      : { state: 'waiting', detail: `ACP ${session.provider} session` };
  }

  async reconcile(runtimeSessionId: string): Promise<RuntimeReconciliation> {
    const observation = await this.inspect(runtimeSessionId);
    if (observation.state !== 'missing') {
      return { state: 'alive', binding: { runtimeSessionId, transport: 'acp' } };
    }
    const assignment = this.repository.getAssignmentForRuntime(runtimeSessionId);
    if (!assignment?.activeAttemptId) return { state: 'missing' };
    const attempt = this.repository.getAttempt(assignment.activeAttemptId);
    if (!attempt) return { state: 'missing' };
    const snapshot = this.repository.snapshot(assignment.missionId);
    const task = snapshot.tasks.find((candidate) => candidate.id === assignment.taskId);
    if (!task) return { state: 'missing' };
    const request: RuntimeStartRequest = {
      idempotencyKey: `recover:${attempt.id}`,
      mission: snapshot.mission,
      task,
      assignment,
      attempt,
      workspaceRoot: snapshot.mission.executionPolicy.workspaceRoot,
    };
    const virtualIdentity = `acp:${attempt.id}`;
    this.options.bindVirtualIdentity(virtualIdentity, request);
    const mcp = this.options.missionMcp(request, virtualIdentity);
    const externalSessionId = runtimeSessionId.slice(`acp:${this.provider}:`.length);
    const restored = await this.pool.loadSession(
      this.provider,
      externalSessionId,
      request.workspaceRoot,
      [
        {
          name: 'charter',
          command: mcp.command,
          args: mcp.args,
          env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })),
        },
      ],
      (notification) => this.onUpdate(request, notification),
    );
    if (!restored) {
      this.options.releaseVirtualIdentity(virtualIdentity);
      return { state: 'missing', detail: `ACP ${this.provider} does not support session/load.` };
    }
    this.sessions.set(runtimeSessionId, {
      provider: this.provider,
      sessionId: externalSessionId,
      processKey: restored.processKey,
      initialPrompt: '',
      attemptId: attempt.id,
      runtimeRecordId: `runtime:${attempt.id}`,
      busy: false,
      paused: assignment.state === 'PAUSED',
      ended: false,
      queued: [],
    });
    this.repository.upsertRuntimeSession({
      id: `runtime:${attempt.id}`,
      attemptId: attempt.id,
      provider: this.provider,
      transport: 'acp',
      externalSessionId,
      processKey: restored.processKey,
      state: assignment.state === 'PAUSED' ? 'PAUSED' : 'WAITING',
      cwd: request.workspaceRoot,
      capabilities: jsonObject(restored.capabilities),
    });
    this.repository.appendRuntimeEvent(`runtime:${attempt.id}`, attempt.id, 'session.recovered', {
      processKey: restored.processKey,
    });
    return {
      state: 'alive',
      binding: {
        runtimeSessionId,
        terminalId: virtualIdentity,
        transport: 'acp',
        provider: this.provider,
        externalSessionId,
        processKey: restored.processKey,
        capabilities: jsonObject(restored.capabilities),
      },
    };
  }

  private enqueueOrPrompt(session: AcpSession, text: string, signal?: AbortSignal): Promise<void> {
    if (session.ended) return Promise.reject(new Error('The ACP session has ended.'));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (session.busy || session.paused) {
      return new Promise<void>((resolve, reject) => {
        const queued: QueuedAcpPrompt = { text, resolve, reject, signal };
        if (signal) {
          queued.abortListener = () => {
            const index = session.queued.indexOf(queued);
            if (index >= 0) session.queued.splice(index, 1);
            reject(abortError(signal));
          };
          signal.addEventListener('abort', queued.abortListener, { once: true });
        }
        session.queued.push(queued);
      });
    }
    try {
      this.runPrompt(session, text);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private runPrompt(session: AcpSession, text: string): void {
    if (!text || session.ended) return;
    session.busy = true;
    this.repository.updateRuntimeSessionState(session.attemptId, 'RUNNING');
    this.repository.appendRuntimeEvent(session.runtimeRecordId, session.attemptId, 'turn.started', {
      queued: session.queued.length,
    });
    void this.pool
      .prompt(session.provider, session.sessionId, text)
      .then((result) => {
        session.busy = false;
        this.repository.updateRuntimeSessionState(session.attemptId, 'WAITING');
        this.repository.appendRuntimeEvent(
          session.runtimeRecordId,
          session.attemptId,
          'turn.stopped',
          { stopReason: result.stopReason },
        );
        this.flush(session);
      })
      .catch((error: unknown) => {
        session.busy = false;
        session.ended = true;
        this.rejectQueued(session, error);
        this.repository.updateRuntimeSessionState(session.attemptId, 'FAILED');
        this.repository.appendRuntimeEvent(
          session.runtimeRecordId,
          session.attemptId,
          'turn.failed',
          {
            message: error instanceof Error ? error.message : String(error),
          },
        );
        this.logger.warn('ACP prompt failed', {
          provider: session.provider,
          attemptId: session.attemptId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private flush(session: AcpSession): void {
    if (session.busy || session.paused || session.ended || session.queued.length === 0) return;
    const queued = session.queued.splice(0);
    for (const item of queued) {
      if (item.abortListener) item.signal?.removeEventListener('abort', item.abortListener);
    }
    const active = queued.filter((item) => !item.signal?.aborted);
    for (const item of queued) {
      if (item.signal?.aborted) item.reject(abortError(item.signal));
    }
    if (active.length === 0) return;
    try {
      this.runPrompt(session, active.map((item) => item.text).join('\n\n'));
      for (const item of active) item.resolve();
    } catch (error) {
      for (const item of active) item.reject(error);
    }
  }

  private rejectQueued(session: AcpSession, error: unknown): void {
    const queued = session.queued.splice(0);
    for (const item of queued) {
      if (item.abortListener) item.signal?.removeEventListener('abort', item.abortListener);
      item.reject(error);
    }
  }

  private onUpdate(input: RuntimeStartRequest, notification: SessionNotification): void {
    const runtimeRecordId = `runtime:${input.attempt.id}`;
    this.repository.appendRuntimeEvent(
      runtimeRecordId,
      input.attempt.id,
      `acp.${notification.update.sessionUpdate}`,
      compactAcpRuntimeEvent(notification.update),
    );
  }

  private requireSession(runtimeSessionId: string): AcpSession {
    const session = this.sessions.get(runtimeSessionId);
    if (!session) throw new Error(`Unknown ACP session: ${runtimeSessionId}`);
    return session;
  }
}

export interface FallbackRuntimeAdapterOptions {
  startWith?: 'primary' | 'fallback';
  fallbackOnStartFailure?: boolean;
}

/**
 * Routes existing bindings by their durable runtime id while allowing new
 * sessions to prefer either adapter. Charter uses this to keep legacy ACP
 * sessions recoverable without putting new Claude/Codex Missions on ACP.
 */
export class FallbackRuntimeAdapter implements OrchestrationRuntimeAdapter {
  readonly kind = 'external-cli' as const;

  constructor(
    private readonly primary: OrchestrationRuntimeAdapter,
    private readonly fallback: OrchestrationRuntimeAdapter,
    private readonly options: FallbackRuntimeAdapterOptions = {},
  ) {}

  async start(input: RuntimeStartRequest, signal: AbortSignal): Promise<RuntimeSessionBinding> {
    const preferred = this.options.startWith === 'fallback' ? this.fallback : this.primary;
    const secondary = preferred === this.primary ? this.fallback : this.primary;
    try {
      return await preferred.start(input, signal);
    } catch (error) {
      if (this.options.fallbackOnStartFailure === false) throw error;
      return await secondary.start(input, signal);
    }
  }

  async activate(runtimeSessionId: string): Promise<void> {
    await this.adapter(runtimeSessionId).activate?.(runtimeSessionId);
  }

  deliver(runtimeSessionId: string, message: string, signal: AbortSignal): Promise<void> {
    const adapter = this.adapter(runtimeSessionId);
    if (!adapter.deliver) throw new Error('The selected runtime does not support inbox delivery.');
    return adapter.deliver(runtimeSessionId, message, signal);
  }

  steer(runtimeSessionId: string, text: string, signal: AbortSignal): Promise<void> {
    const adapter = this.adapter(runtimeSessionId);
    if (!adapter.steer) throw new Error('The selected runtime does not support steering.');
    return adapter.steer(runtimeSessionId, text, signal);
  }

  async pause(runtimeSessionId: string): Promise<void> {
    await this.adapter(runtimeSessionId).pause?.(runtimeSessionId);
  }

  async resume(runtimeSessionId: string): Promise<void> {
    await this.adapter(runtimeSessionId).resume?.(runtimeSessionId);
  }

  cancel(runtimeSessionId: string, reason: string): Promise<void> {
    return this.adapter(runtimeSessionId).cancel(runtimeSessionId, reason);
  }

  async inspect(runtimeSessionId: string): Promise<RuntimeObservation> {
    return (
      (await this.adapter(runtimeSessionId).inspect?.(runtimeSessionId)) ?? { state: 'unknown' }
    );
  }

  async reconcile(runtimeSessionId: string): Promise<RuntimeReconciliation> {
    return (
      (await this.adapter(runtimeSessionId).reconcile?.(runtimeSessionId)) ?? { state: 'unknown' }
    );
  }

  private adapter(runtimeSessionId: string): OrchestrationRuntimeAdapter {
    return runtimeSessionId.startsWith('acp:') ? this.primary : this.fallback;
  }
}
