import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { app } from 'electron';
import {
  deferred,
  newId,
  productError,
  ProductFailure,
  type Deferred,
  type Logger,
  type ProductError,
} from '@pi-ide/foundation';
import type {
  AgentEvent,
  CreateSessionInput,
  ModelDescriptor,
  ModelRef,
  PromptImage,
  RuntimeSessionRef,
  StartRunInput,
  ToolCallRequest,
  WorkerInbound,
  WorkerOutbound,
} from '@pi-ide/agent-contract';
import type { ToolGateway } from '@pi-ide/tool-gateway';
import type { SecretService } from './secret-service.js';
import { broadcast } from '../broadcast.js';

export type RuntimeKind = 'pi' | 'mock';

export interface AgentHostDelegate {
  onAgentEvent(taskId: string, runId: string, event: AgentEvent): void;
  onRunEnded(taskId: string, runId: string): void;
  onWorkerCrashed(activeRunTaskIds: string[]): void;
  gatewayForTask(taskId: string): ToolGateway | null;
  onToolLifecycle(
    taskId: string,
    call: ToolCallRequest,
    result: { ok: boolean; code: string; summary: string } | null,
  ): void;
}

interface ActiveRun {
  taskId: string;
  runId: string;
  toolControllers: Map<string, AbortController>;
}

/** Supervises the agent utility process (AG-002, REL-002). */
export class AgentHost {
  private worker: UtilityProcess | null = null;
  private runtimeKind: RuntimeKind | null = null;
  /** In-flight spawn+init; concurrent ensure() calls join it instead of
   * racing requests into a worker whose runtime is not initialized yet. */
  private spawnPromise: Promise<void> | null = null;
  private initialized = false;
  private readonly pending = new Map<string, Deferred<unknown>>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private restarts = 0;
  private lastCrashAt = 0;
  private disposed = false;
  delegate: AgentHostDelegate | null = null;

  constructor(
    private readonly runtimeDataDir: string,
    private readonly secrets: SecretService,
    private readonly logger: Logger,
  ) {}

  get alive(): boolean {
    return this.worker !== null && this.initialized;
  }

  get restartCount(): number {
    return this.restarts;
  }

  get degraded(): boolean {
    return this.restarts >= 5 && Date.now() - this.lastCrashAt < 5 * 60 * 1000;
  }

  activeRunForTask(taskId: string): string | null {
    for (const run of this.activeRuns.values()) {
      if (run.taskId === taskId) return run.runId;
    }
    return null;
  }

  hasActiveRuns(): boolean {
    return this.activeRuns.size > 0;
  }

  activeRunCount(): number {
    return this.activeRuns.size;
  }

  async ensure(kind: RuntimeKind): Promise<void> {
    // Bounded by construction: each pass either returns, joins an in-flight
    // spawn, or spawns itself; a successful spawn satisfies the first check.
    let joinFailed = false;
    for (;;) {
      if (this.disposed) {
        throw new ProductFailure(
          productError('AG_HOST_DISPOSED', { userMessage: 'The agent host is shutting down.' }),
        );
      }
      if (this.worker && this.runtimeKind === kind && this.initialized) return;
      // Join the spawn already in flight — returning early here (the previous
      // "worker exists" fast path) posted requests to a worker whose runtime
      // had not been initialized yet: the cold-start models.list failure.
      if (this.spawnPromise) {
        try {
          await this.spawnPromise;
        } catch (e) {
          // A joined spawn can die through no fault of ours — stopWorker()
          // kills a mid-handshake worker when credentials change. Retry with
          // a fresh spawn once; a second failure is the caller's to see.
          if (joinFailed) throw e;
          joinFailed = true;
        }
        continue;
      }
      if (this.worker && this.runtimeKind !== kind) {
        this.logger.info('switching runtime kind, restarting worker', {
          from: this.runtimeKind,
          to: kind,
        });
        await this.stopWorker();
      }
      // A worker without a completed init and no spawn in flight is a stale
      // zombie (its spawn already failed); left alone this loop would spin
      // without awaiting — stop it so the next pass respawns cleanly.
      if (this.worker && !this.initialized) {
        this.logger.warn('restarting uninitialized agent worker', { kind });
        await this.stopWorker();
      }
      if (!this.worker) {
        this.spawnPromise = this.spawn(kind).finally(() => {
          this.spawnPromise = null;
        });
        await this.spawnPromise;
      }
    }
  }

  private async spawn(kind: RuntimeKind): Promise<void> {
    const workerPath = join(app.getAppPath(), 'apps/agent-worker/dist/worker.mjs');
    const ready = deferred<void>();
    this.runtimeKind = kind;
    this.initialized = false;

    const child = utilityProcess.fork(workerPath, [], {
      serviceName: 'pi-ide-agent-worker',
      stdio: 'pipe',
    });
    this.worker = child;
    child.stdout?.on('data', (chunk: Buffer) =>
      this.logger.debug(`worker stdout: ${chunk.toString().slice(0, 400)}`),
    );
    child.stderr?.on('data', (chunk: Buffer) =>
      this.logger.warn(`worker stderr: ${chunk.toString().slice(0, 400)}`),
    );

    child.on('message', (raw: unknown) => {
      const message = raw as WorkerOutbound;
      // Resolve the handshake of THIS spawn only — a late 'ready' from a
      // worker being replaced must not vouch for its successor.
      if (message.type === 'ready') {
        ready.resolve();
        return;
      }
      this.onMessage(message);
    });
    child.on('exit', (code) => {
      // Abort an in-flight handshake at once — without this a worker killed
      // mid-spawn (stopWorker on a credential change) stalls every joined
      // ensure() for the full ready timeout while models.list serves an
      // empty catalog. Settling twice is a no-op, so a late exit is safe.
      ready.reject(
        new ProductFailure(
          productError('AG_WORKER_EXIT', {
            userMessage: 'The agent worker exited during startup.',
            retryable: true,
          }),
        ),
      );
      // A stale exit from a worker that has already been replaced must not
      // tear down its successor's state or reject the successor's requests.
      if (this.worker !== null && this.worker !== child) return;
      const wasInitialized = this.initialized;
      this.worker = null;
      this.initialized = false;
      const affected = [...this.activeRuns.values()].map((r) => r.taskId);
      for (const run of this.activeRuns.values()) {
        for (const controller of run.toolControllers.values()) controller.abort();
      }
      this.activeRuns.clear();
      for (const [reqId, pendingReq] of this.pending) {
        pendingReq.reject(
          new ProductFailure(
            productError('AG_WORKER_EXIT', {
              userMessage: 'The agent worker exited unexpectedly.',
              retryable: true,
            }),
          ),
        );
        this.pending.delete(reqId);
      }
      if (!this.disposed) {
        this.restarts += 1;
        this.lastCrashAt = Date.now();
        this.logger.error('agent worker exited', { code, restarts: this.restarts });
        broadcast('agent.workerStatus', {
          alive: false,
          restarts: this.restarts,
          degraded: this.degraded,
        });
        if (wasInitialized && affected.length > 0) {
          this.delegate?.onWorkerCrashed(affected);
        }
      }
    });

    // Wait for ready handshake.
    const readyTimeout = setTimeout(() => {
      ready.reject(
        new ProductFailure(
          productError('AG_WORKER_START_TIMEOUT', {
            userMessage: 'The agent worker did not start in time.',
            retryable: true,
          }),
        ),
      );
    }, 15000);
    try {
      await ready.promise.finally(() => clearTimeout(readyTimeout));

      // Initialize the runtime.
      const credentials = kind === 'pi' ? this.secrets.credentialsForWorker() : [];
      await this.request({
        type: 'init',
        reqId: newId('req'),
        runtimeKind: kind,
        runtimeDataDir: this.runtimeDataDir,
        appVersion: app.getVersion(),
        credentials,
      });
    } catch (e) {
      // A worker that failed its handshake or init is a zombie — a late
      // 'ready' resolves nothing, so it would never initialize or broadcast.
      // Kill it so the exit handler reports status and ensure() can respawn.
      try {
        child.kill();
      } catch {
        // already gone
      }
      throw e;
    }
    this.initialized = true;
    broadcast('agent.workerStatus', {
      alive: true,
      restarts: this.restarts,
      degraded: this.degraded,
    });
    this.logger.info('agent worker ready', { kind });
  }

  private onMessage(message: WorkerOutbound): void {
    switch (message.type) {
      case 'response': {
        const pendingReq = this.pending.get(message.reqId);
        if (pendingReq) {
          this.pending.delete(message.reqId);
          if (message.ok) pendingReq.resolve(message.data);
          else
            pendingReq.reject(
              new ProductFailure(
                (message.error as ProductError) ??
                  productError('AG_WORKER_ERROR', { userMessage: 'Agent worker error.' }),
              ),
            );
        }
        break;
      }
      case 'event':
        this.delegate?.onAgentEvent(message.taskId, message.runId, message.event);
        break;
      case 'runEnded': {
        const run = this.activeRuns.get(message.runId);
        if (run) {
          for (const controller of run.toolControllers.values()) controller.abort();
          this.activeRuns.delete(message.runId);
        }
        this.delegate?.onRunEnded(message.taskId, message.runId);
        break;
      }
      case 'toolRequest':
        void this.executeTool(message.taskId, message.call);
        break;
      case 'log':
        this.logger[
          message.level === 'error' ? 'error' : message.level === 'warn' ? 'warn' : 'info'
        ](`worker: ${message.message}`);
        break;
    }
  }

  private async executeTool(taskId: string, call: ToolCallRequest): Promise<void> {
    const gateway = this.delegate?.gatewayForTask(taskId);
    const run = this.activeRuns.get(call.runId);
    const controller = new AbortController();
    run?.toolControllers.set(call.callId, controller);
    this.delegate?.onToolLifecycle(taskId, call, null);
    let result;
    if (!gateway) {
      result = {
        callId: call.callId,
        ok: false,
        code: 'TOOL_NO_GATEWAY',
        summary: 'No tool gateway is available for this task (workspace closed?).',
        data: {},
      };
    } else {
      result = await gateway.executeCall(call, controller.signal);
    }
    run?.toolControllers.delete(call.callId);
    this.delegate?.onToolLifecycle(taskId, call, {
      ok: result.ok,
      code: result.code,
      summary: result.summary,
    });
    this.post({ type: 'toolResult', callId: call.callId, result });
  }

  private post(message: WorkerInbound): void {
    this.worker?.postMessage(message);
  }

  private request<T>(message: WorkerInbound & { reqId: string }): Promise<T> {
    const pendingReq = deferred<unknown>();
    this.pending.set(message.reqId, pendingReq);
    this.post(message);
    const timeout = setTimeout(() => {
      if (this.pending.delete(message.reqId)) {
        pendingReq.reject(
          new ProductFailure(
            productError('AG_WORKER_TIMEOUT', {
              userMessage: 'The agent worker did not respond in time.',
              retryable: true,
            }),
          ),
        );
      }
    }, 60000);
    return pendingReq.promise.finally(() => clearTimeout(timeout)) as Promise<T>;
  }

  async createSession(input: CreateSessionInput): Promise<RuntimeSessionRef> {
    return this.request<RuntimeSessionRef>({
      type: 'createSession',
      reqId: newId('req'),
      input,
    });
  }

  startRun(taskId: string, input: StartRunInput): void {
    this.activeRuns.set(input.runId, { taskId, runId: input.runId, toolControllers: new Map() });
    this.post({ type: 'startRun', taskId, input });
  }

  steer(runId: string, text: string, images?: PromptImage[]): void {
    this.post({ type: 'steer', runId, text, ...(images?.length ? { images } : {}) });
  }

  followUp(runId: string, text: string, images?: PromptImage[]): void {
    this.post({ type: 'followUp', runId, text, ...(images?.length ? { images } : {}) });
  }

  /** ADR-0016: switch a live session's model/effort; rejects loudly on failure. */
  async setSessionModel(sessionId: string, model: ModelRef): Promise<void> {
    await this.request({ type: 'setSessionModel', reqId: newId('req'), sessionId, model });
  }

  abort(
    runId: string,
    reason: 'user_stop' | 'app_quit' | 'timeout' | 'superseded' | 'error',
  ): void {
    const run = this.activeRuns.get(runId);
    if (run) {
      for (const controller of run.toolControllers.values()) controller.abort();
    }
    this.post({ type: 'abort', runId, reason });
  }

  async listModels(kind: RuntimeKind): Promise<ModelDescriptor[]> {
    await this.ensure(kind);
    return this.request<ModelDescriptor[]>({ type: 'listModels', reqId: newId('req') });
  }

  async stopWorker(): Promise<void> {
    const child = this.worker;
    if (!child) return;
    child.postMessage({ type: 'shutdown' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      child.kill();
    } catch {
      // already gone
    }
    // Only clear state that still belongs to this worker — ensure() may have
    // spawned a successor while we waited out the graceful-shutdown window.
    if (this.worker === child) {
      this.worker = null;
      this.initialized = false;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopWorker();
  }

  /** Test hook (E2E-019): report the worker pid so tests can SIGKILL it. */
  workerPid(): number | null {
    return this.worker?.pid ?? null;
  }
}
