import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { ToolCallRequest, ToolResultPayload } from '@pi-ide/agent-contract';
import type { TerminalControlPort, TerminalToolCaller } from '@pi-ide/tool-gateway';
import type { TerminalManager } from '@pi-ide/terminal-service';
import type { ToolGateway } from '@pi-ide/tool-gateway';
import type { ExternalLaunchIntents } from './external-launch-intents.js';
import { terminalControlRunId } from './terminal-control-run.js';

export const TERMINAL_BUFFER_BYTES = 200 * 1024;
export const DEFAULT_MAX_WORKERS = 5;
export const DEFAULT_MAX_SENDS_PER_MINUTE = 30;
const WORKER_STREAMING_GRACE_MS = 1_500;

const ANSI_RE =
  /[\u001B\u009B](?:\][^\u0007]*(?:\u0007|\u001B\\)|[()[\]#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;
const OSC_133_EXIT_RE = /\u001b\]133;D;(-?\d+)(?:\u0007|\u001b\\)/g;
const FOCUS_REPORTS_ONLY_RE = /^(?:\u001b\[[IO])+$/;

export function stripTerminalAnsi(value: string): string {
  return value
    .replace(ANSI_RE, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, '');
}

function byteTail(value: string, limit: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= limit) return value;
  let tail = bytes.subarray(bytes.byteLength - limit).toString('utf8');
  if (tail.charCodeAt(0) === 0xfffd) tail = tail.slice(1);
  return tail;
}

export interface TerminalControlIdentity {
  terminalId: string;
  token: string;
}

/** Terminal capability registry. A product-owned secret derives stable tokens
 * for daemon sessions so their already-running process environment remains
 * valid after Electron restarts; tests and legacy callers may stay ephemeral. */
export class TerminalControlIdentityRegistry {
  private readonly byToken = new Map<string, string>();
  private readonly byTerminal = new Map<string, string>();

  constructor(
    readonly endpoint: string,
    private readonly tokenOverride: string | null = null,
    private readonly stableSecret: Buffer | null = null,
  ) {}

  issue(terminalId: string): TerminalControlIdentity {
    const existing = this.byTerminal.get(terminalId);
    if (existing) return { terminalId, token: existing };
    const token =
      this.tokenOverride ??
      (this.stableSecret
        ? createHmac('sha256', this.stableSecret).update(terminalId).digest('base64url')
        : randomBytes(32).toString('base64url'));
    this.byTerminal.set(terminalId, token);
    this.byToken.set(token, terminalId);
    return { terminalId, token };
  }

  environment(terminalId: string): Record<string, string> {
    const identity = this.issue(terminalId);
    return {
      CHARTER_TERM_ID: terminalId,
      CHARTER_CTL: this.endpoint,
      CHARTER_CTL_TOKEN: identity.token,
    };
  }

  resolve(token: string): string | null {
    return this.byToken.get(token) ?? null;
  }

  revokeTerminal(terminalId: string): void {
    const token = this.byTerminal.get(terminalId);
    if (token) this.byToken.delete(token);
    this.byTerminal.delete(terminalId);
  }

  clear(): void {
    this.byToken.clear();
    this.byTerminal.clear();
  }
}

export interface OrchestrationWorkerSnapshot {
  terminalId: string;
  commanderTaskId: string;
  commanderTerminalId: string | null;
  createdAt: string;
  launch: string;
  title: string;
  projectName: string;
  taskId: string | null;
  status: 'streaming' | 'quiet' | 'completed' | 'failed' | 'exited';
  busy: boolean;
  paused: boolean;
  takeover: boolean;
  queuedSends: number;
  exitCode: number | null;
  outputTail: string;
  updatedAt: string;
}

export interface OrchestrationSnapshot {
  enabled: boolean;
  fleetPausedTaskIds: string[];
  workers: OrchestrationWorkerSnapshot[];
}

export interface OrchestrationFleetRestoreMember {
  terminalId: string;
  workerTaskId: string | null;
  launch: string;
  root: string;
  projectPath: string;
  title: string;
  idempotencyKey?: string | null;
}

/** A live worker relationship reconstructed from the durable task ledger. */
export interface OrchestrationFleetRelationRestore extends OrchestrationFleetRestoreMember {
  commanderTaskId: string;
  commanderTerminalId: string | null;
  turnPending: boolean;
}

export interface OrchestrationFleetResumeResult {
  requested: number;
  resumed: number;
  reused: number;
  failed: Array<{ taskId: string; message: string }>;
}

interface WorkerRelation {
  terminalId: string;
  commanderTaskId: string;
  commanderTerminalId: string | null;
  /** Durable external-task identity, present before the live detector catches up after restart. */
  taskId: string | null;
  createdAt: string;
  launch: string;
  title: string;
  projectName: string;
  idempotencyKey: string | null;
  closeRequested: boolean;
  starting: boolean;
  startupTimer: ReturnType<typeof setTimeout> | null;
  paused: boolean;
  takeover: boolean;
  queued: Array<{ callerTaskId: string; text: string; submit: boolean }>;
}

interface QueuedRuntimeNotification {
  text: string;
  submit: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface TerminalState {
  buffer: string;
  rawTail: string;
  bracketedPaste: boolean;
  lastOutputAt: number;
  exitSequence: number;
  lastExitCode: number | null;
  processExitCode: number | null;
  exited: boolean;
  turnSequence: number;
  turnPending: boolean;
  lastTurnStatus: 'ok' | 'error' | null;
  lastTurnSource: 'structured' | 'observed' | null;
  lastTurnTaskId: string | null;
  lastTurnAt: number | null;
}

interface Waiter {
  id: number;
  terminalId: string;
  mode: 'command' | 'quiet' | 'until' | 'turn';
  startedAt: number;
  startExitSequence: number;
  startTurnSequence: number;
  quietMs: number;
  regex: RegExp | null;
  output: string;
  timeout: ReturnType<typeof setTimeout>;
  quietTimer: ReturnType<typeof setTimeout> | null;
  cleanup: () => void;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface TerminalControlServiceOptions {
  enabled: () => boolean;
  maxWorkers?: () => number;
  maxSendsPerMinute?: () => number;
  launchIntents?: ExternalLaunchIntents | null;
  taskForTerminal?: (terminalId: string) => string | null;
  /** Current user-facing Session name for a live terminal, if it has one. */
  taskTitleForTerminal?: (terminalId: string) => string | null;
  onChanged?: (snapshot: OrchestrationSnapshot) => void;
  recordEvent?: (taskId: string, type: string, payload: Record<string, unknown>) => void;
  now?: () => number;
  settleMs?: number;
  /** Resolve an opaque Agent id through the trusted host Agent Registry. */
  resolveAgentLaunch?: (
    agentId: string,
    initialPrompt: string | null,
  ) => {
    executable: string;
    args: string[];
    sessionId: string | null;
    promptDelivery: 'argv' | 'deferred';
  } | null;
}

/** The one orchestration heart behind both Gateway tools and ctl.sock. */
export class TerminalControlService implements TerminalControlPort {
  private readonly states = new Map<string, TerminalState>();
  private readonly workers = new Map<string, WorkerRelation>();
  private readonly fleetPaused = new Set<string>();
  private readonly sendTimes = new Map<string, number[]>();
  private readonly lastSendExitSequence = new Map<string, number>();
  private readonly lastSendTurnSequence = new Map<string, number>();
  /** Mission runtimes may adopt an already-open user terminal, so they are
   * not necessarily present in the legacy worker graph. Keep their held input
   * here instead of pretending that every Mission member is a V1 worker. */
  private readonly heldRuntimeInput = new Map<string, Array<{ text: string; submit: boolean }>>();
  private readonly queuedRuntimeNotifications = new Map<string, QueuedRuntimeNotification[]>();
  private readonly waiters = new Map<number, Waiter>();
  private readonly externalCallers = new Map<string, string>();
  /** A recent-output worker snapshot is time-dependent. Publish the quiet edge
   * even when the PTY becomes completely silent and no later event arrives. */
  private readonly workerIdleRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private waiterSequence = 0;
  private readonly unsubscribeData: () => void;
  private readonly unsubscribeInput: () => void;
  private readonly unsubscribeExit: () => void;
  private readonly now: () => number;
  private readonly settleMs: number;

  constructor(
    private readonly terminals: TerminalManager,
    private readonly logger: Logger,
    private readonly options: TerminalControlServiceOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.settleMs = options.settleMs ?? 350;
    this.unsubscribeData = terminals.onDataEvent(({ id, data }) => this.onData(id, data));
    this.unsubscribeInput = terminals.onSourcedInputEvent(({ id, data, source }) => {
      const worker = this.workers.get(id);
      if (
        worker &&
        (worker.launch !== 'shell' || Boolean(this.terminals.agentFor(id))) &&
        /[\r\n]/.test(data)
      ) {
        this.markTurnStarted(id);
      }
      if (source !== 'user') return;
      // Focus reporting is emitted by xterm when a TUI gains or loses focus;
      // it is terminal protocol traffic, not evidence of manual control.
      if (FOCUS_REPORTS_ONLY_RE.test(data)) return;
      if (!worker || worker.takeover) return;
      worker.takeover = true;
      this.record(worker.commanderTaskId, 'orchestration.takeover', {
        terminalId: id,
        state: 'taken_over',
      });
      this.changed();
    });
    this.unsubscribeExit = terminals.onExitEvent(({ id, exitCode }) => {
      this.clearWorkerIdleRefresh(id);
      const state = this.stateFor(id);
      state.exited = true;
      state.processExitCode = exitCode;
      this.heldRuntimeInput.delete(id);
      this.rejectRuntimeNotifications(id, 'The terminal process exited before inbox delivery.');
      const worker = this.workers.get(id);
      if (worker) {
        if (worker.startupTimer) clearTimeout(worker.startupTimer);
        worker.startupTimer = null;
        worker.starting = false;
        this.record(worker.commanderTaskId, 'orchestration.workerExited', {
          terminalId: id,
          exitCode,
        });
      }
      this.rejectWaitersForTerminal(id, 'TERMINAL_EXITED', 'The terminal process exited.');
      this.changed();
    });
  }

  callerTerminalForCall(callId: string): string | null {
    return this.externalCallers.get(callId) ?? null;
  }

  async executeFromTerminal(input: {
    terminalId: string;
    taskId: string;
    gateway: ToolGateway;
    toolName: string;
    toolInput: unknown;
    signal: AbortSignal;
  }): Promise<ToolResultPayload> {
    const call: ToolCallRequest = {
      callId: `ctl_${randomUUID()}`,
      runId: terminalControlRunId(input.taskId, input.terminalId),
      taskId: input.taskId,
      toolName: input.toolName,
      input: input.toolInput,
    };
    this.externalCallers.set(call.callId, input.terminalId);
    try {
      return await input.gateway.executeCall(call, input.signal);
    } finally {
      this.externalCallers.delete(call.callId);
    }
  }

  targetKind(target: string): 'shell' | 'tui' | 'missing' {
    const id = this.tryResolveTargetId(target);
    if (!id) return 'missing';
    const terminal = this.terminals.list().find((item) => item.id === id);
    if (!terminal) return 'missing';
    return this.terminals.agentFor(id) || terminal.launch !== 'shell' ? 'tui' : 'shell';
  }

  preflight(
    caller: TerminalToolCaller,
    action: 'create' | 'send' | 'kill',
    targetId?: string,
  ): void {
    this.assertEnabled();
    if (action === 'create') this.assertTopLevel(caller);
    else this.assertMayControl(caller, targetId ?? '');
  }

  list(_caller: TerminalToolCaller): unknown {
    this.assertEnabled();
    const relations = this.snapshot().workers;
    const relationById = new Map(relations.map((worker) => [worker.terminalId, worker]));
    return {
      cwdSemantics: 'managed-context',
      terminals: this.terminals.list().map((terminal) => {
        const name = this.terminalName(terminal.id, terminal.title);
        return {
          id: terminal.id,
          name,
          title: name,
          terminalTitle: terminal.title,
          cwd: terminal.cwd,
          contextCwd: terminal.cwd,
          projectName: terminal.projectName,
          launch: terminal.launch,
          agent: this.terminals.agentFor(terminal.id),
          busy: this.isBusy(terminal.id),
          orchestration: relationById.get(terminal.id) ?? null,
        };
      }),
    };
  }

  async read(
    _caller: TerminalToolCaller,
    input: { id: string; maxBytes: number },
  ): Promise<unknown> {
    this.assertEnabled();
    const terminalId = this.resolveTargetId(input.id);
    const state = this.stateFor(terminalId);
    const screen = await this.terminals.screenText?.(terminalId, input.maxBytes);
    const content = screen?.content ?? byteTail(state.buffer, input.maxBytes);
    const totalBytes = screen?.totalBytes ?? Buffer.byteLength(state.buffer, 'utf8');
    return {
      terminalId,
      content,
      bytes: Buffer.byteLength(content, 'utf8'),
      truncated: totalBytes > input.maxBytes,
      busy: this.isBusy(terminalId),
      exited: state.exited,
    };
  }

  async send(
    caller: TerminalToolCaller,
    input: { id: string; text: string; submit: boolean },
  ): Promise<unknown> {
    this.assertEnabled();
    const terminalId = this.assertMayControl(caller, input.id);
    this.takeSendBudget(caller);
    this.lastSendExitSequence.set(
      `${caller.taskId}:${terminalId}`,
      this.stateFor(terminalId).exitSequence,
    );
    this.lastSendTurnSequence.set(
      `${caller.taskId}:${terminalId}`,
      this.stateFor(terminalId).turnSequence,
    );
    const worker = this.workers.get(terminalId);
    if (
      worker &&
      (worker.starting ||
        worker.paused ||
        worker.takeover ||
        this.fleetPaused.has(worker.commanderTaskId))
    ) {
      worker.queued.push({ callerTaskId: caller.taskId, text: input.text, submit: input.submit });
      this.record(caller.taskId, 'orchestration.sendQueued', {
        terminalId,
        reason: worker.starting
          ? 'starting'
          : worker.takeover
            ? 'takeover'
            : worker.paused
              ? 'worker_paused'
              : 'fleet_paused',
        queued: worker.queued.length,
      });
      this.changed();
      return {
        terminalId,
        queued: true,
        reason: worker.starting
          ? 'starting'
          : worker.takeover
            ? 'takeover'
            : worker.paused
              ? 'worker_paused'
              : 'fleet_paused',
        queueLength: worker.queued.length,
      };
    }
    this.writeInjection(terminalId, input.text, input.submit);
    this.record(caller.taskId, 'orchestration.sent', {
      terminalId,
      text: input.text,
      submit: input.submit,
    });
    this.changed();
    return { terminalId, queued: false, queueLength: 0 };
  }

  async create(
    caller: TerminalToolCaller,
    input: {
      root: string;
      launch: string;
      initialText?: string;
      submit: boolean;
      idempotencyKey?: string;
      bypassLegacyBudget?: boolean;
    },
  ): Promise<unknown> {
    this.assertEnabled();
    this.assertTopLevel(caller);
    if (input.idempotencyKey) {
      const existing = [...this.workers.values()].find(
        (worker) =>
          worker.idempotencyKey === input.idempotencyKey &&
          this.terminals.list().some((terminal) => terminal.id === worker.terminalId),
      );
      if (existing) {
        const terminal = this.terminals.list().find((item) => item.id === existing.terminalId)!;
        return { terminal, worker: this.workerSnapshot(existing), reused: true };
      }
    }
    const liveWorkers = [...this.workers.values()].filter(
      (worker) =>
        worker.commanderTaskId === caller.taskId &&
        this.terminals.list().some((terminal) => terminal.id === worker.terminalId),
    );
    const limit = this.options.maxWorkers?.() ?? DEFAULT_MAX_WORKERS;
    if (!input.bypassLegacyBudget && liveWorkers.length >= limit) {
      throw new ProductFailure(
        productError('TERMINAL_WORKER_BUDGET', {
          userMessage: `This session already has ${limit} live workers. Close one before creating another.`,
          retryable: true,
        }),
      );
    }

    const initialPrompt = input.initialText?.trim() ? input.initialText : null;
    const agentLaunch =
      input.launch === 'shell'
        ? null
        : (this.options.resolveAgentLaunch?.(input.launch, initialPrompt) ?? null);
    if (input.launch !== 'shell' && !agentLaunch) {
      throw new ProductFailure(
        productError('AGENT_NOT_AVAILABLE', {
          userMessage: `The ${input.launch} Agent is not installed or cannot be launched.`,
          retryable: true,
        }),
      );
    }
    const directAgent = agentLaunch ? input.launch : null;
    const info = this.terminals.create({
      cwd: input.root,
      projectName: basename(input.root),
      projectPath: input.root,
      contextKind: 'task',
      contextLabel: basename(input.root),
      contextTaskId: caller.taskId,
      launch: input.launch,
      ...(directAgent
        ? { executable: agentLaunch!.executable, args: agentLaunch!.args, knownAgent: directAgent }
        : {}),
    });
    const relation: WorkerRelation = {
      terminalId: info.id,
      commanderTaskId: caller.taskId,
      commanderTerminalId: caller.terminalId ?? null,
      taskId: null,
      createdAt: new Date(this.now()).toISOString(),
      launch: input.launch,
      title: info.title,
      projectName: info.projectName,
      idempotencyKey: input.idempotencyKey ?? null,
      closeRequested: false,
      starting: !directAgent && this.settleMs > 0,
      startupTimer: null,
      paused: false,
      takeover: false,
      queued: [],
    };
    this.workers.set(info.id, relation);
    const state = this.stateFor(info.id);
    if (directAgent && initialPrompt) {
      // A direct agent can finish before the caller reaches terminal.wait.
      // The launch prompt therefore gets the same race-safe cursor as send.
      this.lastSendTurnSequence.set(`${caller.taskId}:${info.id}`, 0);
      state.turnPending = state.turnSequence === 0;
    }

    if (directAgent) {
      this.options.launchIntents?.register(info.id, {
        cli: directAgent,
        sessionId: agentLaunch!.sessionId,
        prompt: initialPrompt,
        promptDelivery: agentLaunch!.promptDelivery,
      });
    } else if (relation.starting) {
      // Return immediately, but preserve input ordering until the shell has
      // installed its line editor and bracketed-paste handlers.
      relation.startupTimer = setTimeout(() => {
        relation.startupTimer = null;
        if (state.exited || !this.workers.has(info.id)) return;
        if (input.initialText) this.writeInjection(info.id, input.initialText, input.submit);
        relation.starting = false;
        this.releaseQueue(relation);
        this.flushRuntimeNotifications(info.id);
        this.changed();
      }, this.settleMs);
      relation.startupTimer.unref?.();
    } else if (input.initialText) {
      this.writeInjection(info.id, input.initialText, input.submit);
    }

    this.record(caller.taskId, 'orchestration.workerCreated', {
      terminalId: info.id,
      launch: input.launch,
      root: input.root,
      title: info.title,
      commanderTerminalId: caller.terminalId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    if (directAgent && initialPrompt) {
      // The first prompt was submitted through argv before the external-session
      // detector can bind its task. Persist the start edge now so a daemon
      // reattach can restore the working indicator without a fresh repaint.
      this.record(caller.taskId, 'orchestration.workerTurnStarted', {
        terminalId: info.id,
        workerTaskId: null,
        source: 'launch',
      });
    }
    this.changed();
    return { terminal: info, worker: this.workerSnapshot(relation) };
  }

  wait(
    caller: TerminalToolCaller,
    input: {
      id: string;
      mode: 'command' | 'quiet' | 'until' | 'turn';
      timeoutMs: number;
      quietMs: number;
      pattern?: string;
    },
    signal: AbortSignal,
  ): Promise<unknown> {
    this.assertEnabled();
    const terminalId = this.resolveTargetId(input.id);
    let regex: RegExp | null = null;
    if (input.mode === 'until') {
      try {
        regex = new RegExp(input.pattern ?? '');
      } catch {
        throw new ProductFailure(
          productError('TERMINAL_WAIT_PATTERN', { userMessage: 'The wait regex is invalid.' }),
        );
      }
    }
    const state = this.stateFor(terminalId);
    const callerTarget = `${caller.taskId}:${terminalId}`;
    const sentAtSequence = this.lastSendExitSequence.get(callerTarget);
    if (
      input.mode === 'command' &&
      sentAtSequence !== undefined &&
      state.exitSequence > sentAtSequence
    ) {
      this.lastSendExitSequence.delete(callerTarget);
      return Promise.resolve({
        terminalId,
        reason: 'command',
        exitCode: state.lastExitCode,
        durationMs: 0,
      });
    }
    if (input.mode === 'command') {
      this.lastSendExitSequence.delete(callerTarget);
    }
    const sentAtTurnSequence = this.lastSendTurnSequence.get(callerTarget);
    if (
      input.mode === 'turn' &&
      sentAtTurnSequence !== undefined &&
      state.turnSequence > sentAtTurnSequence
    ) {
      this.lastSendTurnSequence.delete(callerTarget);
      return Promise.resolve(this.turnWaitResult(terminalId, state, 0));
    }
    if (input.mode === 'turn') {
      this.lastSendTurnSequence.delete(callerTarget);
    }
    return new Promise((resolve, reject) => {
      const id = ++this.waiterSequence;
      const finish = (error: unknown | null, value?: unknown): void => {
        const waiter = this.waiters.get(id);
        if (!waiter) return;
        this.waiters.delete(id);
        clearTimeout(waiter.timeout);
        if (waiter.quietTimer) clearTimeout(waiter.quietTimer);
        waiter.cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = (): void =>
        finish(
          new ProductFailure(
            productError('CANCELLED', { userMessage: 'The terminal wait was cancelled.' }),
          ),
        );
      signal.addEventListener('abort', onAbort, { once: true });
      const timeout = setTimeout(
        () =>
          finish(
            new ProductFailure(
              productError('TERMINAL_WAIT_TIMEOUT', {
                userMessage: `Terminal ${input.id} did not satisfy the ${input.mode} wait before timeout.`,
                retryable: true,
              }),
            ),
          ),
        input.timeoutMs,
      );
      const waiter: Waiter = {
        id,
        terminalId,
        mode: input.mode,
        startedAt: this.now(),
        startExitSequence: state.exitSequence,
        startTurnSequence: state.turnSequence,
        quietMs: input.quietMs,
        regex,
        output: '',
        timeout,
        quietTimer: null,
        cleanup: () => signal.removeEventListener('abort', onAbort),
        resolve: (value) => finish(null, value),
        reject: (error) => finish(error),
      };
      this.waiters.set(id, waiter);
      if (input.mode === 'quiet') this.armQuiet(waiter);
      if (signal.aborted) onAbort();
    });
  }

  kill(caller: TerminalToolCaller, input: { id: string }): unknown {
    this.assertEnabled();
    const terminalId = this.assertMayControl(caller, input.id);
    const worker = this.workers.get(terminalId);
    if (worker) {
      worker.closeRequested = true;
      if (worker.startupTimer) clearTimeout(worker.startupTimer);
      worker.startupTimer = null;
      worker.starting = false;
    }
    this.terminals.kill(terminalId);
    const state = this.stateFor(terminalId);
    state.exited = true;
    this.record(caller.taskId, 'orchestration.workerKilled', { terminalId });
    this.rejectWaitersForTerminal(terminalId, 'TERMINAL_EXITED', 'The terminal was closed.');
    this.changed();
    return { terminalId, closed: true };
  }

  pauseWorker(terminalId: string, paused: boolean): OrchestrationSnapshot {
    this.assertEnabled();
    const worker = this.workers.get(terminalId);
    if (!worker) this.unknown(terminalId);
    worker!.paused = paused;
    this.record(worker!.commanderTaskId, 'orchestration.pauseChanged', {
      terminalId,
      scope: 'worker',
      paused,
    });
    if (!paused) this.releaseQueue(worker!);
    if (!paused) this.flushRuntimeNotifications(terminalId);
    this.changed();
    return this.snapshot();
  }

  /**
   * Mission-facing control for a visible runtime. Unlike pauseWorker, this
   * also supports a user-created external Agent terminal that was adopted as the
   * Mission Lead. "Pause" intentionally means hold future injected guidance;
   * it does not freeze an already-running model turn.
   */
  pauseRuntime(terminalId: string, paused: boolean): void {
    this.assertEnabled();
    this.assertLiveTerminal(terminalId);
    if (this.workers.has(terminalId)) {
      this.pauseWorker(terminalId, paused);
      return;
    }
    if (paused) {
      if (!this.heldRuntimeInput.has(terminalId)) this.heldRuntimeInput.set(terminalId, []);
      return;
    }
    const queued = this.heldRuntimeInput.get(terminalId) ?? [];
    this.heldRuntimeInput.delete(terminalId);
    for (const item of queued) this.writeInjection(terminalId, item.text, item.submit);
    this.flushRuntimeNotifications(terminalId);
  }

  /**
   * Deliver Mission guidance to either a recursively-created worker or an
   * adopted top-level terminal. Legacy takeover, fleet-pause and send-budget
   * behavior remains in force for workers.
   */
  async sendRuntime(terminalId: string, text: string, submit = true): Promise<void> {
    this.assertEnabled();
    this.assertLiveTerminal(terminalId);
    const worker = this.workers.get(terminalId);
    if (worker) {
      await this.send({ taskId: worker.commanderTaskId }, { id: terminalId, text, submit });
      return;
    }
    const held = this.heldRuntimeInput.get(terminalId);
    if (held) {
      held.push({ text, submit });
      return;
    }
    this.writeInjection(terminalId, text, submit);
  }

  /**
   * Deliver a control-plane doorbell at a safe turn boundary. The returned
   * promise resolves only after bytes have actually been handed to the PTY,
   * so the durable delivery row never claims that a merely queued message was
   * delivered.
   */
  async notifyRuntime(
    terminalId: string,
    text: string,
    submit = true,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertEnabled();
    this.assertLiveTerminal(terminalId);
    if (signal?.aborted) throw this.cancelledNotification();
    if (this.runtimeNotificationBlocked(terminalId)) {
      await new Promise<void>((resolve, reject) => {
        const queued = this.queuedRuntimeNotifications.get(terminalId) ?? [];
        const item: QueuedRuntimeNotification = { text, submit, resolve, reject };
        if (signal) {
          const onAbort = (): void => {
            const current = this.queuedRuntimeNotifications.get(terminalId);
            if (current) {
              const index = current.indexOf(item);
              if (index >= 0) current.splice(index, 1);
              if (current.length === 0) this.queuedRuntimeNotifications.delete(terminalId);
            }
            reject(this.cancelledNotification());
          };
          item.signal = signal;
          item.onAbort = onAbort;
          signal.addEventListener('abort', onAbort, { once: true });
        }
        queued.push(item);
        this.queuedRuntimeNotifications.set(terminalId, queued);
      });
      return;
    }
    this.writeInjection(terminalId, text, submit);
  }

  /**
   * Idempotently retire an exact Mission terminal. Reassignment and
   * cancellation must work for adopted Leads as well as created workers.
   */
  closeRuntime(terminalId: string): void {
    this.assertEnabled();
    const worker = this.workers.get(terminalId);
    if (worker) {
      this.kill({ taskId: worker.commanderTaskId }, { id: terminalId });
      return;
    }
    if (!this.terminals.list().some((terminal) => terminal.id === terminalId)) return;
    this.heldRuntimeInput.delete(terminalId);
    this.rejectRuntimeNotifications(terminalId, 'The Mission runtime was closed before delivery.');
    this.terminals.kill(terminalId);
    const state = this.stateFor(terminalId);
    state.exited = true;
    this.rejectWaitersForTerminal(terminalId, 'TERMINAL_EXITED', 'The terminal was closed.');
  }

  pauseFleet(taskId: string, paused: boolean): OrchestrationSnapshot {
    this.assertEnabled();
    if (paused) this.fleetPaused.add(taskId);
    else {
      this.fleetPaused.delete(taskId);
      for (const worker of this.workers.values()) {
        if (worker.commanderTaskId === taskId) {
          this.releaseQueue(worker);
          this.flushRuntimeNotifications(worker.terminalId);
        }
      }
    }
    this.record(taskId, 'orchestration.pauseChanged', { scope: 'fleet', paused });
    this.changed();
    return this.snapshot();
  }

  handBack(terminalId: string): OrchestrationSnapshot {
    this.assertEnabled();
    const worker = this.workers.get(terminalId);
    if (!worker) this.unknown(terminalId);
    worker!.takeover = false;
    this.record(worker!.commanderTaskId, 'orchestration.takeover', {
      terminalId,
      state: 'handed_back',
    });
    this.releaseQueue(worker!);
    this.flushRuntimeNotifications(terminalId);
    this.changed();
    return this.snapshot();
  }

  bindWorkerTask(terminalId: string, workerTaskId: string): void {
    const worker = this.workers.get(terminalId);
    if (!worker) return;
    worker.taskId = workerTaskId;
    this.record(worker.commanderTaskId, 'orchestration.workerBound', {
      terminalId,
      workerTaskId,
    });
    this.changed();
  }

  /**
   * Reattach workers whose daemon-backed PTYs survived an Electron restart.
   * This is a pure in-memory projection: the ledger already owns the history,
   * so startup must never append duplicate worker-created/bound events.
   */
  restoreFleetRelations(relations: readonly OrchestrationFleetRelationRestore[]): number {
    const terminals = new Map(this.terminals.list().map((terminal) => [terminal.id, terminal]));
    let restored = 0;
    for (const relation of relations) {
      const terminal = terminals.get(relation.terminalId);
      if (!terminal) continue;

      const previous = this.workers.get(relation.terminalId);
      if (previous?.startupTimer) clearTimeout(previous.startupTimer);
      this.workers.set(relation.terminalId, {
        terminalId: relation.terminalId,
        commanderTaskId: relation.commanderTaskId,
        commanderTerminalId: relation.commanderTerminalId,
        taskId: relation.workerTaskId,
        createdAt: previous?.createdAt ?? new Date(this.now()).toISOString(),
        launch: relation.launch,
        title: relation.title,
        projectName: terminal.projectName,
        idempotencyKey: relation.idempotencyKey ?? null,
        closeRequested: false,
        starting: false,
        startupTimer: null,
        paused: false,
        takeover: false,
        queued: previous?.queued ?? [],
      });
      // Daemon replay contains screen contents but not a reliable post-restart
      // output edge. The persisted turn boundary therefore owns the initial
      // activity state until the reattached CLI reports completion.
      this.stateFor(relation.terminalId).turnPending = relation.turnPending;
      this.scheduleWorkerIdleRefresh(relation.terminalId);
      restored += 1;
    }
    if (restored > 0) this.changed();
    return restored;
  }

  /** Restore a commander's durable fleet without allowing worker resumes to recurse. */
  async resumeFleet(input: {
    sourceTaskId: string;
    targetTaskId: string;
    commanderTerminalId: string;
    members: OrchestrationFleetRestoreMember[];
    resumeWorker: (taskId: string, terminalId: string) => Promise<{ taskId: string; cli: string }>;
  }): Promise<OrchestrationFleetResumeResult> {
    const result: OrchestrationFleetResumeResult = {
      requested: input.members.length,
      resumed: 0,
      reused: 0,
      failed: [],
    };
    if (!this.options.enabled()) {
      result.failed = input.members.map((member) => ({
        taskId: member.workerTaskId ?? member.terminalId,
        message: 'Session orchestration is disabled in Settings.',
      }));
      return result;
    }

    const limit = this.options.maxWorkers?.() ?? DEFAULT_MAX_WORKERS;
    const selected = input.members.slice(0, limit);
    for (const member of input.members.slice(limit)) {
      result.failed.push({
        taskId: member.workerTaskId ?? member.terminalId,
        message: `The fleet exceeds the ${limit}-worker orchestration limit.`,
      });
    }

    const outcomes = await Promise.all(
      selected.map((member) => this.resumeFleetMember(input, member)),
    );
    for (const outcome of outcomes) {
      if (outcome.kind === 'failed') result.failed.push(outcome.failure);
      else if (outcome.kind === 'resumed') result.resumed += 1;
      else result.reused += 1;
    }
    this.record(input.targetTaskId, 'orchestration.fleetResumed', {
      sourceTaskId: input.sourceTaskId,
      requested: result.requested,
      resumed: result.resumed,
      reused: result.reused,
      failed: result.failed.length,
    });
    this.changed();
    return result;
  }

  /** Bridges a real external-agent work edge into the worker projection. */
  notifyTurnStarted(
    terminalId: string,
    event: {
      taskId: string;
      source: 'input' | 'launch';
    },
  ): void {
    const state = this.stateFor(terminalId);
    if (state.turnPending) return;
    this.markTurnStarted(terminalId);

    const worker = this.workers.get(terminalId);
    if (worker) {
      this.record(worker.commanderTaskId, 'orchestration.workerTurnStarted', {
        terminalId,
        workerTaskId: event.taskId,
        source: event.source,
      });
    }
  }

  /** Bridges semantic external-Agent completion edges into orchestration waiters. */
  notifyTurnSettled(
    terminalId: string,
    event: {
      taskId: string;
      status: 'ok' | 'error';
      source: 'structured' | 'observed';
      at?: number;
    },
  ): void {
    this.clearWorkerIdleRefresh(terminalId);
    const state = this.stateFor(terminalId);
    state.turnSequence += 1;
    state.turnPending = false;
    state.lastTurnStatus = event.status;
    state.lastTurnSource = event.source;
    state.lastTurnTaskId = event.taskId;
    state.lastTurnAt = event.at ?? this.now();

    for (const waiter of [...this.waiters.values()]) {
      if (
        waiter.terminalId === terminalId &&
        waiter.mode === 'turn' &&
        state.turnSequence > waiter.startTurnSequence
      ) {
        waiter.resolve(this.turnWaitResult(terminalId, state, this.now() - waiter.startedAt));
      }
    }

    const worker = this.workers.get(terminalId);
    if (worker) {
      this.record(worker.commanderTaskId, 'orchestration.workerTurnSettled', {
        terminalId,
        workerTaskId: event.taskId,
        status: event.status,
        source: event.source,
        turnSequence: state.turnSequence,
      });
      this.changed();
    }
    this.flushRuntimeNotifications(terminalId);
  }

  directorCut(taskId: string, terminalId: string, reason: string): { recorded: boolean } {
    this.assertEnabled();
    const worker = this.workers.get(terminalId);
    if (!worker || worker.commanderTaskId !== taskId) this.unknown(terminalId);
    // Output is intentionally absent: director snapshots remain in-memory UI
    // state and terminal output never enters the durable ledger.
    this.record(taskId, 'orchestration.directorCut', { terminalId, reason });
    return { recorded: true };
  }

  snapshot(): OrchestrationSnapshot {
    return {
      enabled: this.options.enabled(),
      fleetPausedTaskIds: [...this.fleetPaused],
      workers: [...this.workers.values()].map((worker) => this.workerSnapshot(worker)),
    };
  }

  publishSnapshot(): void {
    this.changed();
  }

  pendingWaiterCount(): number {
    return this.waiters.size;
  }

  bufferBytes(terminalId: string): number {
    return Buffer.byteLength(this.stateFor(terminalId).buffer, 'utf8');
  }

  dispose(): void {
    this.unsubscribeData();
    this.unsubscribeInput();
    this.unsubscribeExit();
    for (const waiter of [...this.waiters.values()]) {
      waiter.reject(
        new ProductFailure(
          productError('CANCELLED', { userMessage: 'Terminal orchestration is shutting down.' }),
        ),
      );
    }
    for (const worker of this.workers.values()) {
      if (worker.startupTimer) clearTimeout(worker.startupTimer);
    }
    for (const timer of this.workerIdleRefreshTimers.values()) clearTimeout(timer);
    this.workerIdleRefreshTimers.clear();
    this.heldRuntimeInput.clear();
    for (const terminalId of this.queuedRuntimeNotifications.keys()) {
      this.rejectRuntimeNotifications(terminalId, 'Terminal orchestration is shutting down.');
    }
    this.externalCallers.clear();
  }

  private async resumeFleetMember(
    input: {
      sourceTaskId: string;
      targetTaskId: string;
      commanderTerminalId: string;
      resumeWorker: (
        taskId: string,
        terminalId: string,
      ) => Promise<{ taskId: string; cli: string }>;
    },
    member: OrchestrationFleetRestoreMember,
  ): Promise<
    | { kind: 'resumed' | 'reused' }
    | { kind: 'failed'; failure: { taskId: string; message: string } }
  > {
    const liveTerminal = this.terminals.list().find((item) => item.id === member.terminalId);
    const previousRelation = liveTerminal ? this.workers.get(liveTerminal.id) : undefined;
    const previousCommander = previousRelation
      ? {
          taskId: previousRelation.commanderTaskId,
          terminalId: previousRelation.commanderTerminalId,
        }
      : null;
    let terminal = liveTerminal;
    let relation = previousRelation;
    let createdTerminal = false;

    if (!terminal) {
      terminal = this.terminals.create({
        cwd: member.root,
        projectName: basename(member.projectPath),
        projectPath: member.projectPath,
        contextKind: 'task',
        contextLabel: basename(member.root),
        contextTaskId: input.targetTaskId,
        launch: member.launch,
      });
      createdTerminal = true;
    }
    if (!relation) {
      relation = {
        terminalId: terminal.id,
        commanderTaskId: input.targetTaskId,
        commanderTerminalId: input.commanderTerminalId,
        taskId: member.workerTaskId,
        createdAt: new Date(this.now()).toISOString(),
        launch: member.launch,
        title: member.title,
        projectName: terminal.projectName,
        idempotencyKey: member.idempotencyKey ?? null,
        closeRequested: false,
        starting: false,
        startupTimer: null,
        paused: false,
        takeover: false,
        queued: [],
      };
      this.workers.set(terminal.id, relation);
    } else {
      relation.commanderTaskId = input.targetTaskId;
      relation.commanderTerminalId = input.commanderTerminalId;
      relation.taskId = member.workerTaskId;
      relation.idempotencyKey = member.idempotencyKey ?? relation.idempotencyKey;
      relation.paused = false;
      relation.takeover = false;
    }

    const needsCreatedEvent =
      input.targetTaskId !== input.sourceTaskId || terminal.id !== member.terminalId;
    if (needsCreatedEvent) {
      this.record(input.targetTaskId, 'orchestration.workerCreated', {
        terminalId: terminal.id,
        workerTaskId: member.workerTaskId,
        launch: member.launch,
        root: member.root,
        title: member.title,
        idempotencyKey: member.idempotencyKey ?? null,
        commanderTerminalId: input.commanderTerminalId,
        restoredFromTerminalId: member.terminalId,
      });
    }
    const retireReplacedSource = (): void => {
      if (terminal!.id === member.terminalId) return;
      const replaced = this.workers.get(member.terminalId);
      if (replaced?.startupTimer) clearTimeout(replaced.startupTimer);
      this.workers.delete(member.terminalId);
      if (input.targetTaskId === input.sourceTaskId) {
        this.record(input.sourceTaskId, 'orchestration.workerKilled', {
          terminalId: member.terminalId,
          reason: 'resume-replaced',
          replacedByTerminalId: terminal!.id,
        });
      }
    };

    try {
      const activeWorkerTaskId = this.options.taskForTerminal?.(terminal.id) ?? null;
      if (activeWorkerTaskId) {
        this.bindWorkerTask(terminal.id, activeWorkerTaskId);
        this.record(input.targetTaskId, 'orchestration.workerResumed', {
          terminalId: terminal.id,
          workerTaskId: activeWorkerTaskId,
          sourceTaskId: member.workerTaskId,
          strategy: 'reused-active',
        });
        retireReplacedSource();
        return { kind: 'reused' };
      }
      if (member.launch === 'shell') {
        this.record(input.targetTaskId, 'orchestration.workerResumed', {
          terminalId: terminal.id,
          workerTaskId: null,
          strategy: createdTerminal ? 'recreated-shell' : 'reused-shell',
        });
        retireReplacedSource();
        return { kind: createdTerminal ? 'resumed' : 'reused' };
      }
      if (!member.workerTaskId) {
        throw new Error(`No resumable ${member.launch} session was recorded for this worker.`);
      }
      const resumed = await input.resumeWorker(member.workerTaskId, terminal.id);
      this.bindWorkerTask(terminal.id, resumed.taskId);
      this.record(input.targetTaskId, 'orchestration.workerResumed', {
        terminalId: terminal.id,
        workerTaskId: resumed.taskId,
        sourceTaskId: member.workerTaskId,
        strategy: createdTerminal ? 'recreated-terminal' : 'reused-terminal',
      });
      retireReplacedSource();
      return { kind: 'resumed' };
    } catch (error) {
      if (needsCreatedEvent) {
        this.record(input.targetTaskId, 'orchestration.workerKilled', {
          terminalId: terminal.id,
          reason: 'resume-failed',
        });
      }
      if (createdTerminal) {
        this.workers.delete(terminal.id);
        this.terminals.kill(terminal.id);
      } else if (previousRelation && previousCommander) {
        previousRelation.commanderTaskId = previousCommander.taskId;
        previousRelation.commanderTerminalId = previousCommander.terminalId;
      } else {
        this.workers.delete(terminal.id);
      }
      return {
        kind: 'failed',
        failure: {
          taskId: member.workerTaskId ?? member.terminalId,
          message: errorMessage(error),
        },
      };
    }
  }

  private stateFor(id: string): TerminalState {
    let state = this.states.get(id);
    if (!state) {
      state = {
        buffer: '',
        rawTail: '',
        bracketedPaste: false,
        lastOutputAt: this.now(),
        exitSequence: 0,
        lastExitCode: null,
        processExitCode: null,
        exited: false,
        turnSequence: 0,
        turnPending: false,
        lastTurnStatus: null,
        lastTurnSource: null,
        lastTurnTaskId: null,
        lastTurnAt: null,
      };
      this.states.set(id, state);
    }
    return state;
  }

  private onData(id: string, data: string): void {
    const state = this.stateFor(id);
    state.lastOutputAt = this.now();
    const cleaned = stripTerminalAnsi(data);
    if (data.includes('\u001b[?2004h')) state.bracketedPaste = true;
    if (data.includes('\u001b[?2004l')) state.bracketedPaste = false;
    state.buffer = byteTail(`${state.buffer}${cleaned}`, TERMINAL_BUFFER_BYTES);
    const raw = `${state.rawTail}${data}`;
    OSC_133_EXIT_RE.lastIndex = 0;
    for (let match = OSC_133_EXIT_RE.exec(raw); match; match = OSC_133_EXIT_RE.exec(raw)) {
      state.exitSequence += 1;
      state.lastExitCode = Number(match[1] ?? -1);
    }
    state.rawTail = raw.slice(-128);

    for (const waiter of [...this.waiters.values()]) {
      if (waiter.terminalId !== id) continue;
      if (waiter.mode === 'command' && state.exitSequence > waiter.startExitSequence) {
        waiter.resolve({
          terminalId: id,
          reason: 'command',
          exitCode: state.lastExitCode,
          durationMs: this.now() - waiter.startedAt,
        });
      } else if (waiter.mode === 'quiet') {
        this.armQuiet(waiter);
      } else if (waiter.mode === 'until') {
        waiter.output = byteTail(`${waiter.output}${cleaned}`, TERMINAL_BUFFER_BYTES);
        if (waiter.regex?.test(waiter.output)) {
          waiter.resolve({
            terminalId: id,
            reason: 'until',
            matched: waiter.regex.source,
            durationMs: this.now() - waiter.startedAt,
          });
        }
      }
    }
    if (this.workers.has(id)) {
      this.scheduleWorkerIdleRefresh(id);
      this.changed();
    }
  }

  private armQuiet(waiter: Waiter): void {
    if (waiter.quietTimer) clearTimeout(waiter.quietTimer);
    waiter.quietTimer = setTimeout(() => {
      waiter.resolve({
        terminalId: waiter.terminalId,
        reason: 'quiet',
        quietMs: waiter.quietMs,
        durationMs: this.now() - waiter.startedAt,
      });
    }, waiter.quietMs);
  }

  private turnWaitResult(terminalId: string, state: TerminalState, durationMs: number): unknown {
    return {
      terminalId,
      reason: 'turn',
      turnSequence: state.turnSequence,
      status: state.lastTurnStatus,
      source: state.lastTurnSource,
      taskId: state.lastTurnTaskId,
      completedAt: state.lastTurnAt === null ? null : new Date(state.lastTurnAt).toISOString(),
      durationMs,
    };
  }

  private markTurnStarted(terminalId: string): void {
    this.clearWorkerIdleRefresh(terminalId);
    const state = this.stateFor(terminalId);
    state.turnPending = true;
    if (this.workers.has(terminalId)) this.changed();
  }

  private rejectWaitersForTerminal(id: string, code: string, message: string): void {
    for (const waiter of [...this.waiters.values()]) {
      if (waiter.terminalId !== id) continue;
      waiter.reject(new ProductFailure(productError(code, { userMessage: message })));
    }
  }

  private writeInjection(id: string, text: string, submit: boolean): void {
    const controlOnly = /^[\u0000-\u001f\u007f]+$/.test(text);
    if (controlOnly) {
      this.terminals.write(id, text.replace(/\n/g, '\r'), 'orchestrator');
      return;
    }
    const normalized = text.replace(/\r?\n/g, '\r');
    const data = this.stateFor(id).bracketedPaste
      ? `\u001b[200~${normalized}\u001b[201~`
      : normalized;
    this.terminals.write(id, data, 'orchestrator');
    if (submit) this.terminals.write(id, '\r', 'orchestrator');
  }

  private releaseQueue(worker: WorkerRelation): void {
    if (
      worker.starting ||
      worker.paused ||
      worker.takeover ||
      this.fleetPaused.has(worker.commanderTaskId)
    ) {
      return;
    }
    const queued = worker.queued.splice(0);
    for (const item of queued) {
      this.lastSendTurnSequence.set(
        `${item.callerTaskId}:${worker.terminalId}`,
        this.stateFor(worker.terminalId).turnSequence,
      );
      this.writeInjection(worker.terminalId, item.text, item.submit);
    }
    if (queued.length > 0) {
      this.record(worker.commanderTaskId, 'orchestration.queueReleased', {
        terminalId: worker.terminalId,
        count: queued.length,
      });
    }
  }

  private flushRuntimeNotifications(terminalId: string): void {
    if (this.runtimeNotificationBlocked(terminalId)) return;
    const queued = this.queuedRuntimeNotifications.get(terminalId);
    if (!queued?.length) return;
    this.queuedRuntimeNotifications.delete(terminalId);
    const active = queued.filter((item) => !item.signal?.aborted);
    if (active.length === 0) return;
    try {
      const submit = active.some((item) => item.submit);
      this.writeInjection(terminalId, active.map((item) => item.text).join('\n\n'), submit);
      for (const item of active) {
        if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
        item.resolve();
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const item of active) {
        if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
        item.reject(failure);
      }
    }
  }

  private runtimeNotificationBlocked(terminalId: string): boolean {
    if (this.heldRuntimeInput.has(terminalId) || this.stateFor(terminalId).turnPending) return true;
    const worker = this.workers.get(terminalId);
    return Boolean(
      worker &&
      (worker.starting ||
        worker.paused ||
        worker.takeover ||
        this.fleetPaused.has(worker.commanderTaskId)),
    );
  }

  private rejectRuntimeNotifications(terminalId: string, message: string): void {
    const queued = this.queuedRuntimeNotifications.get(terminalId);
    if (!queued) return;
    this.queuedRuntimeNotifications.delete(terminalId);
    const error = new Error(message);
    for (const item of queued) {
      if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort);
      item.reject(error);
    }
  }

  private cancelledNotification(): Error {
    return new ProductFailure(
      productError('CANCELLED', { userMessage: 'Mission inbox delivery was cancelled.' }),
    );
  }

  private workerSnapshot(worker: WorkerRelation): OrchestrationWorkerSnapshot {
    const terminal = this.terminals.list().find((item) => item.id === worker.terminalId);
    const state = this.stateFor(worker.terminalId);
    const taskId = this.options.taskForTerminal?.(worker.terminalId) ?? worker.taskId;
    const busy = terminal ? this.isBusy(worker.terminalId) : false;
    const exitCode = state.processExitCode ?? state.lastExitCode;
    const hasSettledTurn = state.lastTurnStatus !== null && !state.turnPending;
    const status: OrchestrationWorkerSnapshot['status'] = state.exited
      ? worker.closeRequested
        ? 'exited'
        : exitCode && exitCode !== 0
          ? 'failed'
          : 'exited'
      : hasSettledTurn
        ? state.lastTurnStatus === 'error'
          ? 'failed'
          : 'completed'
        : state.turnPending
          ? 'streaming'
          : state.lastExitCode !== null && !busy
            ? state.lastExitCode === 0
              ? 'completed'
              : 'failed'
            : busy && this.now() - state.lastOutputAt < WORKER_STREAMING_GRACE_MS
              ? 'streaming'
              : 'quiet';
    return {
      terminalId: worker.terminalId,
      commanderTaskId: worker.commanderTaskId,
      commanderTerminalId: worker.commanderTerminalId,
      createdAt: worker.createdAt,
      launch: worker.launch,
      title: this.terminalName(worker.terminalId, terminal?.title ?? worker.title),
      projectName: terminal?.projectName ?? worker.projectName,
      taskId,
      status,
      busy,
      paused: worker.paused,
      takeover: worker.takeover,
      queuedSends: worker.queued.length,
      exitCode,
      outputTail: byteTail(state.buffer, 12 * 1024),
      updatedAt: new Date(Math.max(state.lastOutputAt, state.lastTurnAt ?? 0)).toISOString(),
    };
  }

  private isBusy(id: string): boolean {
    return Boolean(this.terminals.agentFor(id)) || this.terminals.hasRunningChildren(id);
  }

  private assertEnabled(): void {
    if (this.options.enabled()) return;
    throw new ProductFailure(
      productError('ORCHESTRATION_DISABLED', {
        userMessage: 'Session orchestration is disabled in Settings.',
      }),
    );
  }

  private terminalName(terminalId: string, fallback: string): string {
    return this.options.taskTitleForTerminal?.(terminalId)?.trim() || fallback;
  }

  private tryResolveTargetId(target: string): string | null {
    const reference = target.trim();
    if (!reference) return null;
    const terminals = this.terminals.list();
    if (terminals.some((terminal) => terminal.id === reference) || this.states.has(reference)) {
      return reference;
    }
    const exact = terminals.filter(
      (terminal) => this.terminalName(terminal.id, terminal.title) === reference,
    );
    if (exact.length === 1) return exact[0]!.id;
    if (exact.length > 1) return null;
    const folded = reference.toLocaleLowerCase();
    const insensitive = terminals.filter(
      (terminal) => this.terminalName(terminal.id, terminal.title).toLocaleLowerCase() === folded,
    );
    return insensitive.length === 1 ? insensitive[0]!.id : null;
  }

  private resolveTargetId(target: string): string {
    const reference = target.trim();
    const terminals = this.terminals.list();
    if (terminals.some((terminal) => terminal.id === reference) || this.states.has(reference)) {
      return reference;
    }
    const matches = terminals.filter(
      (terminal) =>
        this.terminalName(terminal.id, terminal.title).toLocaleLowerCase() ===
        reference.toLocaleLowerCase(),
    );
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) {
      throw new ProductFailure(
        productError('TERMINAL_NAME_AMBIGUOUS', {
          userMessage: `More than one terminal is named "${reference}". Use terminal.list and target its id instead.`,
          context: { target: reference, terminalIds: matches.map((terminal) => terminal.id) },
        }),
      );
    }
    return this.unknown(reference);
  }

  private unknown(id: string): never {
    throw new ProductFailure(
      productError('TERMINAL_NOT_FOUND', {
        userMessage: `Terminal ${id} is no longer available.`,
      }),
    );
  }

  private assertLiveTerminal(id: string): void {
    if (this.terminals.list().some((terminal) => terminal.id === id)) return;
    this.unknown(id);
  }

  private assertTopLevel(caller: TerminalToolCaller): void {
    if (!caller.terminalId || !this.workers.has(caller.terminalId)) return;
    throw new ProductFailure(
      productError('TERMINAL_DEPTH_LIMIT', {
        userMessage: 'A worker session cannot create or command another worker (depth limit: 2).',
      }),
    );
  }

  private assertMayControl(caller: TerminalToolCaller, target: string): string {
    this.assertTopLevel(caller);
    const targetId = this.resolveTargetId(target);
    if (caller.terminalId !== targetId) return targetId;
    throw new ProductFailure(
      productError('TERMINAL_SELF_CONTROL', {
        userMessage: 'A terminal cannot send to or close itself.',
      }),
    );
  }

  private takeSendBudget(caller: TerminalToolCaller): void {
    const key = caller.taskId;
    const cutoff = this.now() - 60_000;
    const recent = (this.sendTimes.get(key) ?? []).filter((at) => at > cutoff);
    const limit = this.options.maxSendsPerMinute?.() ?? DEFAULT_MAX_SENDS_PER_MINUTE;
    if (recent.length >= limit) {
      throw new ProductFailure(
        productError('TERMINAL_SEND_BUDGET', {
          userMessage: `This session reached the ${limit} sends/minute orchestration budget.`,
          retryable: true,
        }),
      );
    }
    recent.push(this.now());
    this.sendTimes.set(key, recent);
  }

  private record(taskId: string, type: string, payload: Record<string, unknown>): void {
    try {
      this.options.recordEvent?.(taskId, type, payload);
    } catch (error) {
      this.logger.warn('orchestration event record failed', { taskId, type, error: `${error}` });
    }
  }

  private clearWorkerIdleRefresh(terminalId: string): void {
    const timer = this.workerIdleRefreshTimers.get(terminalId);
    if (timer) clearTimeout(timer);
    this.workerIdleRefreshTimers.delete(terminalId);
  }

  private scheduleWorkerIdleRefresh(terminalId: string): void {
    this.clearWorkerIdleRefresh(terminalId);
    const state = this.states.get(terminalId);
    if (
      !state ||
      !this.workers.has(terminalId) ||
      state.exited ||
      state.turnPending ||
      state.lastTurnStatus !== null
    ) {
      return;
    }
    const outputAt = state.lastOutputAt;
    const remaining = Math.max(0, WORKER_STREAMING_GRACE_MS - (this.now() - outputAt));
    const timer = setTimeout(() => {
      this.workerIdleRefreshTimers.delete(terminalId);
      const current = this.states.get(terminalId);
      if (
        !current ||
        !this.workers.has(terminalId) ||
        current.exited ||
        current.turnPending ||
        current.lastTurnStatus !== null ||
        current.lastOutputAt !== outputAt
      ) {
        return;
      }
      // No output event exists to drive this transition. Recompute and publish
      // so renderers do not retain the final transient `streaming` snapshot.
      this.changed();
    }, remaining);
    timer.unref?.();
    this.workerIdleRefreshTimers.set(terminalId, timer);
  }

  private changed(): void {
    this.options.onChanged?.(this.snapshot());
  }
}
