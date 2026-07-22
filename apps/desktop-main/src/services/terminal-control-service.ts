import { randomBytes, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { ToolCallRequest, ToolResultPayload } from '@pi-ide/agent-contract';
import type { TerminalControlPort, TerminalToolCaller } from '@pi-ide/tool-gateway';
import type { TerminalManager } from '@pi-ide/terminal-service';
import type { ToolGateway } from '@pi-ide/tool-gateway';
import type { ExternalLaunchIntents } from './external-launch-intents.js';

export const TERMINAL_BUFFER_BYTES = 200 * 1024;
export const DEFAULT_MAX_WORKERS = 5;
export const DEFAULT_MAX_SENDS_PER_MINUTE = 30;

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

/** Per-launch, memory-only terminal capability registry (ADR-0044). */
export class TerminalControlIdentityRegistry {
  private readonly byToken = new Map<string, string>();
  private readonly byTerminal = new Map<string, string>();

  constructor(
    readonly endpoint: string,
    private readonly tokenOverride: string | null = null,
  ) {}

  issue(terminalId: string): TerminalControlIdentity {
    const existing = this.byTerminal.get(terminalId);
    if (existing) return { terminalId, token: existing };
    const token = this.tokenOverride ?? randomBytes(32).toString('base64url');
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
  launch: 'shell' | 'claude' | 'codex';
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

interface WorkerRelation {
  terminalId: string;
  commanderTaskId: string;
  commanderTerminalId: string | null;
  createdAt: string;
  launch: 'shell' | 'claude' | 'codex';
  title: string;
  projectName: string;
  closeRequested: boolean;
  paused: boolean;
  takeover: boolean;
  queued: Array<{ text: string; submit: boolean }>;
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
}

interface Waiter {
  id: number;
  terminalId: string;
  mode: 'command' | 'quiet' | 'until';
  startedAt: number;
  startExitSequence: number;
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
  onChanged?: (snapshot: OrchestrationSnapshot) => void;
  recordEvent?: (taskId: string, type: string, payload: Record<string, unknown>) => void;
  now?: () => number;
  settleMs?: number;
}

/** The one orchestration heart behind both Gateway tools and ctl.sock. */
export class TerminalControlService implements TerminalControlPort {
  private readonly states = new Map<string, TerminalState>();
  private readonly workers = new Map<string, WorkerRelation>();
  private readonly fleetPaused = new Set<string>();
  private readonly sendTimes = new Map<string, number[]>();
  private readonly lastSendExitSequence = new Map<string, number>();
  private readonly waiters = new Map<number, Waiter>();
  private readonly externalCallers = new Map<string, string>();
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
      if (source !== 'user') return;
      // Focus reporting is emitted by xterm when a TUI gains or loses focus;
      // it is terminal protocol traffic, not evidence of manual control.
      if (FOCUS_REPORTS_ONLY_RE.test(data)) return;
      const worker = this.workers.get(id);
      if (!worker || worker.takeover) return;
      worker.takeover = true;
      this.record(worker.commanderTaskId, 'orchestration.takeover', {
        terminalId: id,
        state: 'taken_over',
      });
      this.changed();
    });
    this.unsubscribeExit = terminals.onExitEvent(({ id, exitCode }) => {
      const state = this.stateFor(id);
      state.exited = true;
      state.processExitCode = exitCode;
      const worker = this.workers.get(id);
      if (worker) {
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
      runId: `terminal:${input.terminalId}`,
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

  targetKind(id: string): 'shell' | 'tui' | 'missing' {
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
      terminals: this.terminals.list().map((terminal) => ({
        id: terminal.id,
        title: terminal.title,
        cwd: terminal.cwd,
        projectName: terminal.projectName,
        launch: terminal.launch,
        agent: this.terminals.agentFor(terminal.id),
        busy: this.isBusy(terminal.id),
        orchestration: relationById.get(terminal.id) ?? null,
      })),
    };
  }

  read(_caller: TerminalToolCaller, input: { id: string; maxBytes: number }): unknown {
    this.assertEnabled();
    this.assertKnown(input.id);
    const state = this.stateFor(input.id);
    const content = byteTail(state.buffer, input.maxBytes);
    return {
      terminalId: input.id,
      content,
      bytes: Buffer.byteLength(content, 'utf8'),
      truncated: Buffer.byteLength(state.buffer, 'utf8') > input.maxBytes,
      busy: this.isBusy(input.id),
      exited: state.exited,
    };
  }

  async send(
    caller: TerminalToolCaller,
    input: { id: string; text: string; submit: boolean },
  ): Promise<unknown> {
    this.assertEnabled();
    this.assertMayControl(caller, input.id);
    this.takeSendBudget(caller);
    this.lastSendExitSequence.set(
      `${caller.taskId}:${input.id}`,
      this.stateFor(input.id).exitSequence,
    );
    const worker = this.workers.get(input.id);
    if (
      worker &&
      (worker.paused || worker.takeover || this.fleetPaused.has(worker.commanderTaskId))
    ) {
      worker.queued.push({ text: input.text, submit: input.submit });
      this.record(caller.taskId, 'orchestration.sendQueued', {
        terminalId: input.id,
        reason: worker.takeover ? 'takeover' : worker.paused ? 'worker_paused' : 'fleet_paused',
        queued: worker.queued.length,
      });
      this.changed();
      return { terminalId: input.id, queued: true, queueLength: worker.queued.length };
    }
    this.writeInjection(input.id, input.text, input.submit);
    this.record(caller.taskId, 'orchestration.sent', {
      terminalId: input.id,
      text: input.text,
      submit: input.submit,
    });
    this.changed();
    return { terminalId: input.id, queued: false, queueLength: 0 };
  }

  async create(
    caller: TerminalToolCaller,
    input: {
      root: string;
      launch: 'shell' | 'claude' | 'codex';
      initialText?: string;
      submit: boolean;
    },
  ): Promise<unknown> {
    this.assertEnabled();
    this.assertTopLevel(caller);
    const liveWorkers = [...this.workers.values()].filter(
      (worker) =>
        worker.commanderTaskId === caller.taskId &&
        this.terminals.list().some((terminal) => terminal.id === worker.terminalId),
    );
    const limit = this.options.maxWorkers?.() ?? DEFAULT_MAX_WORKERS;
    if (liveWorkers.length >= limit) {
      throw new ProductFailure(
        productError('TERMINAL_WORKER_BUDGET', {
          userMessage: `This session already has ${limit} live workers. Close one before creating another.`,
          retryable: true,
        }),
      );
    }

    const directAgent = input.launch === 'claude' || input.launch === 'codex' ? input.launch : null;
    const sessionId = input.launch === 'claude' ? randomUUID() : null;
    const initialPrompt = input.initialText?.trim() ? input.initialText : null;
    const agentArgs =
      input.launch === 'claude'
        ? [
            ...(sessionId ? ['--session-id', sessionId] : []),
            ...(initialPrompt ? ['--', initialPrompt] : []),
          ]
        : input.launch === 'codex' && initialPrompt
          ? ['--', initialPrompt]
          : [];
    const info = this.terminals.create({
      cwd: input.root,
      projectName: basename(input.root),
      projectPath: input.root,
      contextKind: 'task',
      contextLabel: basename(input.root),
      contextTaskId: caller.taskId,
      launch: input.launch,
      ...(directAgent ? { executable: directAgent, args: agentArgs, knownAgent: directAgent } : {}),
    });
    const relation: WorkerRelation = {
      terminalId: info.id,
      commanderTaskId: caller.taskId,
      commanderTerminalId: caller.terminalId ?? null,
      createdAt: new Date(this.now()).toISOString(),
      launch: input.launch,
      title: info.title,
      projectName: info.projectName,
      closeRequested: false,
      paused: false,
      takeover: false,
      queued: [],
    };
    this.workers.set(info.id, relation);
    this.stateFor(info.id);

    if (directAgent) {
      this.options.launchIntents?.register(info.id, {
        cli: directAgent,
        sessionId,
        prompt: initialPrompt,
        promptDelivery: 'argv',
      });
    } else if (input.initialText) {
      setTimeout(
        () => this.writeInjection(info.id, input.initialText!, input.submit),
        this.settleMs,
      ).unref?.();
    }

    // Let the interactive shell install its line editor and bracketed-paste
    // handlers before a fast caller follows create immediately with send.
    if (!directAgent && this.settleMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.settleMs));
    }

    this.record(caller.taskId, 'orchestration.workerCreated', {
      terminalId: info.id,
      launch: input.launch,
      commanderTerminalId: caller.terminalId ?? null,
    });
    this.changed();
    return { terminal: info, worker: this.workerSnapshot(relation) };
  }

  wait(
    caller: TerminalToolCaller,
    input: {
      id: string;
      mode: 'command' | 'quiet' | 'until';
      timeoutMs: number;
      quietMs: number;
      pattern?: string;
    },
    signal: AbortSignal,
  ): Promise<unknown> {
    this.assertEnabled();
    this.assertKnown(input.id);
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
    const state = this.stateFor(input.id);
    const sentAtSequence = this.lastSendExitSequence.get(`${caller.taskId}:${input.id}`);
    if (
      input.mode === 'command' &&
      sentAtSequence !== undefined &&
      state.exitSequence > sentAtSequence
    ) {
      this.lastSendExitSequence.delete(`${caller.taskId}:${input.id}`);
      return Promise.resolve({
        terminalId: input.id,
        reason: 'command',
        exitCode: state.lastExitCode,
        durationMs: 0,
      });
    }
    if (input.mode === 'command') {
      this.lastSendExitSequence.delete(`${caller.taskId}:${input.id}`);
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
        terminalId: input.id,
        mode: input.mode,
        startedAt: this.now(),
        startExitSequence: state.exitSequence,
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
    this.assertMayControl(caller, input.id);
    const worker = this.workers.get(input.id);
    if (worker) worker.closeRequested = true;
    this.terminals.kill(input.id);
    const state = this.stateFor(input.id);
    state.exited = true;
    this.record(caller.taskId, 'orchestration.workerKilled', { terminalId: input.id });
    this.rejectWaitersForTerminal(input.id, 'TERMINAL_EXITED', 'The terminal was closed.');
    this.changed();
    return { terminalId: input.id, closed: true };
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
    this.changed();
    return this.snapshot();
  }

  pauseFleet(taskId: string, paused: boolean): OrchestrationSnapshot {
    this.assertEnabled();
    if (paused) this.fleetPaused.add(taskId);
    else {
      this.fleetPaused.delete(taskId);
      for (const worker of this.workers.values()) {
        if (worker.commanderTaskId === taskId) this.releaseQueue(worker);
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
    this.changed();
    return this.snapshot();
  }

  bindWorkerTask(terminalId: string): void {
    if (this.workers.has(terminalId)) this.changed();
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
    this.externalCallers.clear();
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
      };
      this.states.set(id, state);
    }
    return state;
  }

  private onData(id: string, data: string): void {
    const state = this.stateFor(id);
    state.lastOutputAt = this.now();
    if (data.includes('\u001b[?2004h')) state.bracketedPaste = true;
    if (data.includes('\u001b[?2004l')) state.bracketedPaste = false;
    state.buffer = byteTail(`${state.buffer}${stripTerminalAnsi(data)}`, TERMINAL_BUFFER_BYTES);
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
        waiter.output = byteTail(
          `${waiter.output}${stripTerminalAnsi(data)}`,
          TERMINAL_BUFFER_BYTES,
        );
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
    if (this.workers.has(id)) this.changed();
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
    if (worker.paused || worker.takeover || this.fleetPaused.has(worker.commanderTaskId)) return;
    const queued = worker.queued.splice(0);
    for (const item of queued) this.writeInjection(worker.terminalId, item.text, item.submit);
    if (queued.length > 0) {
      this.record(worker.commanderTaskId, 'orchestration.queueReleased', {
        terminalId: worker.terminalId,
        count: queued.length,
      });
    }
  }

  private workerSnapshot(worker: WorkerRelation): OrchestrationWorkerSnapshot {
    const terminal = this.terminals.list().find((item) => item.id === worker.terminalId);
    const state = this.stateFor(worker.terminalId);
    const taskId = this.options.taskForTerminal?.(worker.terminalId) ?? null;
    const busy = terminal ? this.isBusy(worker.terminalId) : false;
    const exitCode = state.processExitCode ?? state.lastExitCode;
    const status: OrchestrationWorkerSnapshot['status'] = state.exited
      ? worker.closeRequested
        ? 'exited'
        : exitCode && exitCode !== 0
          ? 'failed'
          : 'exited'
      : state.lastExitCode !== null && !busy
        ? state.lastExitCode === 0
          ? 'completed'
          : 'failed'
        : busy && this.now() - state.lastOutputAt < 1500
          ? 'streaming'
          : 'quiet';
    return {
      terminalId: worker.terminalId,
      commanderTaskId: worker.commanderTaskId,
      commanderTerminalId: worker.commanderTerminalId,
      createdAt: worker.createdAt,
      launch: worker.launch,
      title: terminal?.title ?? worker.title,
      projectName: terminal?.projectName ?? worker.projectName,
      taskId,
      status,
      busy,
      paused: worker.paused,
      takeover: worker.takeover,
      queuedSends: worker.queued.length,
      exitCode,
      outputTail: byteTail(state.buffer, 12 * 1024),
      updatedAt: new Date(state.lastOutputAt).toISOString(),
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

  private assertKnown(id: string): void {
    if (this.terminals.list().some((terminal) => terminal.id === id) || this.states.has(id)) return;
    this.unknown(id);
  }

  private unknown(id: string): never {
    throw new ProductFailure(
      productError('TERMINAL_NOT_FOUND', {
        userMessage: `Terminal ${id} is no longer available.`,
      }),
    );
  }

  private assertTopLevel(caller: TerminalToolCaller): void {
    if (!caller.terminalId || !this.workers.has(caller.terminalId)) return;
    throw new ProductFailure(
      productError('TERMINAL_DEPTH_LIMIT', {
        userMessage: 'A worker session cannot create or command another worker (depth limit: 2).',
      }),
    );
  }

  private assertMayControl(caller: TerminalToolCaller, targetId: string): void {
    this.assertTopLevel(caller);
    this.assertKnown(targetId);
    if (caller.terminalId !== targetId) return;
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

  private changed(): void {
    this.options.onChanged?.(this.snapshot());
  }
}
