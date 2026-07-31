import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CreateTerminalOptions,
  TerminalInfo,
  TerminalInputSource,
  TerminalManager,
} from '@pi-ide/terminal-service';
import type { Logger } from '@pi-ide/foundation';
import {
  TERMINAL_BUFFER_BYTES,
  TerminalControlIdentityRegistry,
  TerminalControlService,
  stripTerminalAnsi,
} from './terminal-control-service.js';
import { ExternalLaunchIntents } from './external-launch-intents.js';

class FakeTerminals {
  infos = new Map<string, TerminalInfo>();
  creates: CreateTerminalOptions[] = [];
  writes: Array<{ id: string; data: string; source: TerminalInputSource }> = [];
  agents = new Map<string, string | null>();
  children = new Set<string>();
  screens = new Map<string, string>();
  private sequence = 0;
  private dataListeners = new Set<(event: { id: string; data: string }) => void>();
  private inputListeners = new Set<
    (event: { id: string; data: string; source: TerminalInputSource }) => void
  >();
  private exitListeners = new Set<(event: { id: string; exitCode: number }) => void>();

  create(options: CreateTerminalOptions): TerminalInfo {
    this.creates.push(options);
    const id = `term_${++this.sequence}`;
    const info: TerminalInfo = {
      id,
      title: options.launch ?? 'shell',
      shell: '/bin/zsh',
      pid: this.sequence,
      cwd: options.cwd,
      projectName: options.projectName ?? 'project',
      projectPath: options.projectPath ?? options.cwd,
      contextKind: options.contextKind ?? 'focused',
      contextLabel: options.contextLabel ?? 'project',
      contextTaskId: options.contextTaskId ?? null,
      launch: options.launch ?? 'shell',
      persistence: 'process',
    };
    this.infos.set(id, info);
    return info;
  }

  list(): TerminalInfo[] {
    return [...this.infos.values()];
  }
  agentFor(id: string): string | null {
    return this.agents.get(id) ?? null;
  }
  hasRunningChildren(id: string): boolean {
    return this.children.has(id);
  }
  async screenText(
    id: string,
    maxBytes: number,
  ): Promise<{ content: string; totalBytes: number } | null> {
    const content = this.screens.get(id);
    if (content === undefined) return null;
    return {
      content: Buffer.from(content, 'utf8').subarray(-maxBytes).toString('utf8'),
      totalBytes: Buffer.byteLength(content, 'utf8'),
    };
  }
  write(id: string, data: string, source: TerminalInputSource = 'host'): void {
    this.writes.push({ id, data, source });
    for (const listener of this.inputListeners) listener({ id, data, source });
  }
  kill(id: string): void {
    this.infos.delete(id);
    for (const listener of this.exitListeners) listener({ id, exitCode: 0 });
  }
  onDataEvent(listener: (event: { id: string; data: string }) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onSourcedInputEvent(
    listener: (event: { id: string; data: string; source: TerminalInputSource }) => void,
  ): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }
  onExitEvent(listener: (event: { id: string; exitCode: number }) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  emitData(id: string, data: string): void {
    for (const listener of this.dataListeners) listener({ id, data });
  }
  emitUser(id: string, data = 'x'): void {
    for (const listener of this.inputListeners) listener({ id, data, source: 'user' });
  }
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => logger,
} as unknown as Logger;

describe('TerminalControlService (ORCH-001/004/005/006/007/009)', () => {
  let terminals: FakeTerminals;
  let service: TerminalControlService;
  let now: number;

  beforeEach(() => {
    terminals = new FakeTerminals();
    now = 10_000;
    service = new TerminalControlService(terminals as unknown as TerminalManager, logger, {
      enabled: () => true,
      maxWorkers: () => 2,
      maxSendsPerMinute: () => 2,
      now: () => now,
      settleMs: 0,
    });
  });

  it('labels listed cwd values as host-managed context rather than live shell state', () => {
    terminals.create({ cwd: '/repo', projectName: 'repo' });

    expect(service.list({ taskId: 'task_1' })).toMatchObject({
      cwdSemantics: 'managed-context',
      terminals: [{ cwd: '/repo', contextCwd: '/repo' }],
    });
  });

  it('lists live Session names and controls unique names case-insensitively', async () => {
    const names = new Map<string, string>();
    const namedService = new TerminalControlService(
      terminals as unknown as TerminalManager,
      logger,
      {
        enabled: () => true,
        maxSendsPerMinute: () => 10,
        taskTitleForTerminal: (terminalId) => names.get(terminalId) ?? null,
        settleMs: 0,
      },
    );
    const target = terminals.create({ cwd: '/repo', launch: 'codex' });
    names.set(target.id, 'Initial Worker');
    terminals.children.add(target.id);
    terminals.emitData(target.id, 'ready\n');

    expect(namedService.list({ taskId: 'commander' })).toMatchObject({
      terminals: [{ id: target.id, name: 'Initial Worker' }],
    });
    names.set(target.id, 'API Reviewer');

    expect(namedService.list({ taskId: 'commander' })).toMatchObject({
      terminals: [
        {
          id: target.id,
          name: 'API Reviewer',
          title: 'API Reviewer',
          terminalTitle: 'codex',
        },
      ],
    });
    await expect(
      namedService.read({ taskId: 'commander' }, { id: 'api reviewer', maxBytes: 1024 }),
    ).resolves.toMatchObject({ terminalId: target.id, content: 'ready\n', busy: true });
    await expect(
      namedService.send(
        { taskId: 'commander' },
        { id: 'Api Reviewer', text: 'review this', submit: true },
      ),
    ).resolves.toMatchObject({ terminalId: target.id, queued: false });
    expect(terminals.writes.at(-1)).toMatchObject({ id: target.id, data: '\r' });

    const wait = namedService.wait(
      { taskId: 'commander' },
      {
        id: 'API REVIEWER',
        mode: 'until',
        pattern: '^DONE$',
        timeoutMs: 5_000,
        quietMs: 1_000,
      },
      new AbortController().signal,
    );
    terminals.emitData(target.id, 'DONE');
    await expect(wait).resolves.toMatchObject({ terminalId: target.id, reason: 'until' });

    const disposable = terminals.create({ cwd: '/repo', launch: 'shell' });
    names.set(disposable.id, 'Disposable Worker');
    expect(namedService.kill({ taskId: 'commander' }, { id: 'disposable worker' })).toEqual({
      terminalId: disposable.id,
      closed: true,
    });
    expect(terminals.infos.has(disposable.id)).toBe(false);
    namedService.dispose();
  });

  it('rejects duplicate Session names and still enforces self-control by name', async () => {
    const names = new Map<string, string>();
    const namedService = new TerminalControlService(
      terminals as unknown as TerminalManager,
      logger,
      {
        enabled: () => true,
        taskTitleForTerminal: (terminalId) => names.get(terminalId) ?? null,
        settleMs: 0,
      },
    );
    const self = terminals.create({ cwd: '/repo' });
    names.set(self.id, 'Primary Agent');
    await expect(
      namedService.send(
        { taskId: 'self_task', terminalId: self.id },
        { id: 'primary agent', text: 'loop', submit: true },
      ),
    ).rejects.toMatchObject({ error: { code: 'TERMINAL_SELF_CONTROL' } });

    const duplicate = terminals.create({ cwd: '/repo' });
    names.set(duplicate.id, 'PRIMARY AGENT');
    await expect(
      namedService.read({ taskId: 'commander' }, { id: 'Primary Agent', maxBytes: 1024 }),
    ).rejects.toMatchObject({ error: { code: 'TERMINAL_NAME_AMBIGUOUS' } });
    namedService.dispose();
  });

  it('strips ANSI and caps each in-memory rolling buffer at 200KB', async () => {
    const terminal = terminals.create({ cwd: '/tmp' });
    terminals.emitData(terminal.id, '\u001b[31mred\u001b[0m\n');
    terminals.emitData(terminal.id, 'x'.repeat(TERMINAL_BUFFER_BYTES + 100));
    expect(service.bufferBytes(terminal.id)).toBeLessThanOrEqual(TERMINAL_BUFFER_BYTES);
    const read = (await service.read(
      { taskId: 'task_1' },
      { id: terminal.id, maxBytes: 1024 },
    )) as {
      content: string;
      bytes: number;
    };
    expect(read.content).not.toContain('\u001b');
    expect(read.bytes).toBeLessThanOrEqual(1024);
    expect(stripTerminalAnsi('\u001b]133;D;0\u0007ok')).toBe('ok');
  });

  it('prefers the emulated VT screen over the lossy ANSI-stripped stream', async () => {
    const terminal = terminals.create({ cwd: '/tmp', launch: 'codex' });
    terminals.emitData(terminal.id, 'qqqq Working Working');
    terminals.screens.set(terminal.id, '┌────┐\n完成：中文 review');

    await expect(
      service.read({ taskId: 'task_1' }, { id: terminal.id, maxBytes: 1024 }),
    ).resolves.toMatchObject({
      content: '┌────┐\n完成：中文 review',
      truncated: false,
    });
  });

  it('queues paused/taken-over sends and releases them in order on hand-back', async () => {
    const created = (await service.create(
      { taskId: 'task_1' },
      { root: '/repo', launch: 'shell', submit: true },
    )) as { terminal: TerminalInfo };
    terminals.emitData(created.terminal.id, '\u001b[?2004h');
    service.pauseWorker(created.terminal.id, true);
    await service.send(
      { taskId: 'task_1' },
      { id: created.terminal.id, text: 'first', submit: true },
    );
    await service.send(
      { taskId: 'task_1' },
      { id: created.terminal.id, text: 'second', submit: false },
    );
    expect(terminals.writes).toHaveLength(0);
    service.pauseWorker(created.terminal.id, false);
    expect(terminals.writes.map((entry) => entry.data)).toEqual([
      '\u001b[200~first\u001b[201~',
      '\r',
      '\u001b[200~second\u001b[201~',
    ]);

    now += 60_001;
    terminals.emitUser(created.terminal.id);
    await expect(
      service.send({ taskId: 'task_1' }, { id: created.terminal.id, text: 'third', submit: true }),
    ).resolves.toMatchObject({ queued: true });
    service.handBack(created.terminal.id);
    expect(terminals.writes.at(-2)?.data).toContain('third');
    expect(terminals.writes.at(-1)?.data).toBe('\r');
  });

  it('controls a user-created terminal after it is adopted as a Mission runtime', async () => {
    const adopted = terminals.create({ cwd: '/repo', launch: 'codex' });

    service.pauseRuntime(adopted.id, true);
    await service.sendRuntime(adopted.id, 'new Mission guidance');
    expect(terminals.writes).toHaveLength(0);

    service.pauseRuntime(adopted.id, false);
    expect(terminals.writes.map((entry) => entry.data)).toEqual(['new Mission guidance', '\r']);

    service.closeRuntime(adopted.id);
    expect(terminals.infos.has(adopted.id)).toBe(false);
    expect(() => service.pauseRuntime(adopted.id, true)).toThrowError(
      expect.objectContaining({ error: expect.objectContaining({ code: 'TERMINAL_NOT_FOUND' }) }),
    );
  });

  it('coalesces Mission doorbells until an adopted Agent turn settles', async () => {
    const adopted = terminals.create({ cwd: '/repo', launch: 'codex' });
    service.notifyTurnStarted(adopted.id, { taskId: 'task', source: 'input' });
    await service.notifyRuntime(adopted.id, 'message 1');
    await service.notifyRuntime(adopted.id, 'message 2');
    expect(terminals.writes).toHaveLength(0);

    service.notifyTurnSettled(adopted.id, {
      taskId: 'task',
      status: 'ok',
      source: 'structured',
    });
    expect(terminals.writes.map((entry) => entry.data)).toEqual(['message 1\r\rmessage 2', '\r']);
  });

  it('ignores terminal focus reports but treats real user input as takeover', async () => {
    const created = (await service.create(
      { taskId: 'task_1' },
      { root: '/repo', launch: 'shell', submit: true },
    )) as { terminal: TerminalInfo };

    terminals.emitUser(created.terminal.id, '\u001b[I');
    terminals.emitUser(created.terminal.id, '\u001b[O');
    terminals.emitUser(created.terminal.id, '\u001b[I\u001b[O');
    expect(service.snapshot().workers[0]?.takeover).toBe(false);

    terminals.emitUser(created.terminal.id, 'x');
    expect(service.snapshot().workers[0]?.takeover).toBe(true);
  });

  it('direct-spawns Claude and Codex workers with argv prompts and no startup typing delay', async () => {
    vi.useFakeTimers();
    try {
      const intents = new ExternalLaunchIntents();
      const fastService = new TerminalControlService(
        terminals as unknown as TerminalManager,
        logger,
        {
          enabled: () => true,
          maxWorkers: () => 3,
          launchIntents: intents,
          resolveAgentExecutable: (launch) => `/charter-wrappers/${launch}`,
          settleMs: 30_000,
        },
      );

      const claudePromise = fastService.create(
        { taskId: 'task_direct' },
        { root: '/repo', launch: 'claude', initialText: 'review claude', submit: true },
      );
      const codexPromise = fastService.create(
        { taskId: 'task_direct' },
        { root: '/repo', launch: 'codex', initialText: 'review codex', submit: true },
      );
      let resolved = false;
      void Promise.all([claudePromise, codexPromise]).then(() => {
        resolved = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(true);

      const claude = (await claudePromise) as { terminal: TerminalInfo };
      const codex = (await codexPromise) as { terminal: TerminalInfo };
      expect(terminals.creates[0]).toMatchObject({
        executable: '/charter-wrappers/claude',
        knownAgent: 'claude',
      });
      expect(terminals.creates[0]?.args?.[0]).toBe('--session-id');
      expect(terminals.creates[0]?.args?.[1]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(terminals.creates[0]?.args?.slice(2)).toEqual(['--', 'review claude']);
      expect(terminals.creates[1]).toMatchObject({
        executable: '/charter-wrappers/codex',
        args: ['--', 'review codex'],
        knownAgent: 'codex',
      });
      expect(intents.consume(claude.terminal.id, 'claude')).toMatchObject({
        prompt: 'review claude',
        promptDelivery: 'argv',
      });
      expect(intents.consume(codex.terminal.id, 'codex')).toEqual({
        cli: 'codex',
        sessionId: null,
        prompt: 'review codex',
        promptDelivery: 'argv',
      });
      expect(terminals.writes).toEqual([]);
      fastService.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves live workers and resumes ended workers with their commander', async () => {
    const activeTasks = new Map<string, string>();
    const events: Array<{ taskId: string; type: string; payload: Record<string, unknown> }> = [];
    const restoreService = new TerminalControlService(
      terminals as unknown as TerminalManager,
      logger,
      {
        enabled: () => true,
        maxWorkers: () => 3,
        taskForTerminal: (terminalId) => activeTasks.get(terminalId) ?? null,
        recordEvent: (taskId, type, payload) => events.push({ taskId, type, payload }),
        settleMs: 0,
      },
    );
    const live = (await restoreService.create(
      { taskId: 'commander_old', terminalId: 'commander_terminal_old' },
      { root: '/repo', launch: 'claude', submit: true },
    )) as { terminal: TerminalInfo };
    activeTasks.set(live.terminal.id, 'worker_live');
    const resumeWorker = vi.fn(async () => ({ taskId: 'worker_resumed', cli: 'codex' }));

    const restored = await restoreService.resumeFleet({
      sourceTaskId: 'commander_old',
      targetTaskId: 'commander_new',
      commanderTerminalId: 'commander_terminal_new',
      members: [
        {
          terminalId: live.terminal.id,
          workerTaskId: 'worker_live',
          launch: 'claude',
          root: '/repo',
          projectPath: '/repo',
          title: 'live worker',
        },
        {
          terminalId: 'term_ended',
          workerTaskId: 'worker_ended',
          launch: 'codex',
          root: '/repo/packages/api',
          projectPath: '/repo',
          title: 'ended worker',
        },
      ],
      resumeWorker,
    });

    expect(restored).toEqual({ requested: 2, resumed: 1, reused: 1, failed: [] });
    expect(resumeWorker).toHaveBeenCalledOnce();
    expect(resumeWorker).toHaveBeenCalledWith('worker_ended', 'term_2');
    expect(restoreService.snapshot().workers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          terminalId: live.terminal.id,
          commanderTaskId: 'commander_new',
          commanderTerminalId: 'commander_terminal_new',
        }),
        expect.objectContaining({
          terminalId: 'term_2',
          commanderTaskId: 'commander_new',
          taskId: 'worker_resumed',
        }),
      ]),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ taskId: 'commander_new', type: 'orchestration.fleetResumed' }),
    );
    restoreService.dispose();
  });

  it('restores only surviving daemon workers without writing duplicate ledger events', () => {
    const events: Array<{ taskId: string; type: string; payload: Record<string, unknown> }> = [];
    const restoredService = new TerminalControlService(
      terminals as unknown as TerminalManager,
      logger,
      {
        enabled: () => true,
        recordEvent: (taskId, type, payload) => events.push({ taskId, type, payload }),
        settleMs: 0,
      },
    );
    const live = terminals.create({ cwd: '/repo', launch: 'codex' });
    terminals.agents.set(live.id, 'codex');

    expect(
      restoredService.restoreFleetRelations([
        {
          commanderTaskId: 'commander_task',
          commanderTerminalId: 'commander_terminal',
          terminalId: live.id,
          workerTaskId: 'worker_task',
          launch: 'codex',
          root: '/repo',
          projectPath: '/repo',
          title: 'Codex review worker',
          turnPending: true,
        },
        {
          commanderTaskId: 'commander_task',
          commanderTerminalId: 'commander_terminal',
          terminalId: 'missing_terminal',
          workerTaskId: 'missing_task',
          launch: 'claude',
          root: '/repo',
          projectPath: '/repo',
          title: 'gone worker',
          turnPending: false,
        },
      ]),
    ).toBe(1);

    expect(restoredService.snapshot().workers).toEqual([
      expect.objectContaining({
        terminalId: live.id,
        commanderTaskId: 'commander_task',
        commanderTerminalId: 'commander_terminal',
        taskId: 'worker_task',
        status: 'streaming',
      }),
    ]);
    expect(events).toEqual([]);
    restoredService.dispose();
  });

  it('keeps the historical worker retryable when its resume fails', async () => {
    const events: Array<{ taskId: string; type: string; payload: Record<string, unknown> }> = [];
    const restoreService = new TerminalControlService(
      terminals as unknown as TerminalManager,
      logger,
      {
        enabled: () => true,
        recordEvent: (taskId, type, payload) => events.push({ taskId, type, payload }),
        settleMs: 0,
      },
    );

    const restored = await restoreService.resumeFleet({
      sourceTaskId: 'commander_same',
      targetTaskId: 'commander_same',
      commanderTerminalId: 'commander_terminal',
      members: [
        {
          terminalId: 'term_historical',
          workerTaskId: 'worker_ended',
          launch: 'claude',
          root: '/repo',
          projectPath: '/repo',
          title: 'worker',
        },
      ],
      resumeWorker: async () => {
        throw new Error('conversation unavailable');
      },
    });

    expect(restored).toMatchObject({ requested: 1, resumed: 0, reused: 0 });
    expect(restored.failed[0]?.message).toBe('conversation unavailable');
    expect(restoreService.snapshot().workers).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'orchestration.workerKilled',
        payload: expect.objectContaining({ terminalId: 'term_1', reason: 'resume-failed' }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'orchestration.workerKilled',
        payload: expect.objectContaining({ terminalId: 'term_historical' }),
      }),
    );
    restoreService.dispose();
  });

  it('replaces an exited in-memory worker instead of duplicating it on same-task resume', async () => {
    const events: Array<{ taskId: string; type: string; payload: Record<string, unknown> }> = [];
    const restoreService = new TerminalControlService(
      terminals as unknown as TerminalManager,
      logger,
      {
        enabled: () => true,
        recordEvent: (taskId, type, payload) => events.push({ taskId, type, payload }),
        settleMs: 0,
      },
    );
    const original = (await restoreService.create(
      { taskId: 'commander_same', terminalId: 'commander_terminal' },
      { root: '/repo', launch: 'claude', submit: true },
    )) as { terminal: TerminalInfo };
    terminals.kill(original.terminal.id);

    const restored = await restoreService.resumeFleet({
      sourceTaskId: 'commander_same',
      targetTaskId: 'commander_same',
      commanderTerminalId: 'commander_terminal',
      members: [
        {
          terminalId: original.terminal.id,
          workerTaskId: 'worker_ended',
          launch: 'claude',
          root: '/repo',
          projectPath: '/repo',
          title: 'worker',
        },
      ],
      resumeWorker: async () => ({ taskId: 'worker_resumed', cli: 'claude' }),
    });

    expect(restored).toEqual({ requested: 1, resumed: 1, reused: 0, failed: [] });
    expect(restoreService.snapshot().workers).toEqual([
      expect.objectContaining({ terminalId: 'term_2', commanderTaskId: 'commander_same' }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'orchestration.workerKilled',
        payload: expect.objectContaining({
          terminalId: original.terminal.id,
          reason: 'resume-replaced',
          replacedByTerminalId: 'term_2',
        }),
      }),
    );
    restoreService.dispose();
  });

  it('returns shell creation immediately and queues fast sends until startup is safe', async () => {
    vi.useFakeTimers();
    try {
      const fastService = new TerminalControlService(
        terminals as unknown as TerminalManager,
        logger,
        {
          enabled: () => true,
          settleMs: 30_000,
        },
      );

      let resolved = false;
      const createPromise = fastService
        .create({ taskId: 'task_fast_shell' }, { root: '/repo', launch: 'shell', submit: true })
        .then((created) => {
          resolved = true;
          return created as { terminal: TerminalInfo };
        });
      await Promise.resolve();
      expect(resolved).toBe(true);

      const created = await createPromise;
      await expect(
        fastService.send(
          { taskId: 'task_fast_shell' },
          { id: created.terminal.id, text: 'printf ready', submit: true },
        ),
      ).resolves.toMatchObject({ queued: true, reason: 'starting' });
      expect(terminals.writes).toEqual([]);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(terminals.writes.map((entry) => entry.data)).toEqual(['printf ready', '\r']);
      fastService.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces worker depth, self-control, live-worker and send-rate budgets', async () => {
    const first = (await service.create(
      { taskId: 'task_1' },
      { root: '/repo', launch: 'shell', submit: true },
    )) as { terminal: TerminalInfo };
    await service.create({ taskId: 'task_1' }, { root: '/repo', launch: 'shell', submit: true });
    await expect(
      service.create({ taskId: 'task_1' }, { root: '/repo', launch: 'shell', submit: true }),
    ).rejects.toMatchObject({ error: { code: 'TERMINAL_WORKER_BUDGET' } });
    expect(() =>
      service.preflight({ taskId: 'worker_task', terminalId: first.terminal.id }, 'create'),
    ).toThrowError();
    expect(() =>
      service.preflight(
        { taskId: 'task_1', terminalId: first.terminal.id },
        'send',
        first.terminal.id,
      ),
    ).toThrowError();

    const target = terminals.create({ cwd: '/repo' });
    await service.send({ taskId: 'task_2' }, { id: target.id, text: 'a', submit: true });
    await service.send({ taskId: 'task_2' }, { id: target.id, text: 'b', submit: true });
    await expect(
      service.send({ taskId: 'task_2' }, { id: target.id, text: 'c', submit: true }),
    ).rejects.toMatchObject({ error: { code: 'TERMINAL_SEND_BUDGET' } });
    now += 60_001;
    await expect(
      service.send({ taskId: 'task_2' }, { id: target.id, text: 'd', submit: true }),
    ).resolves.toMatchObject({ queued: false });
  });

  it('waits for OSC exit and post-start regex, and cancellation leaves no waiter', async () => {
    const terminal = terminals.create({ cwd: '/repo' });
    terminals.emitData(terminal.id, 'READY old\n');
    const command = service.wait(
      { taskId: 'task_1' },
      { id: terminal.id, mode: 'command', timeoutMs: 5000, quietMs: 1000 },
      new AbortController().signal,
    );
    terminals.emitData(terminal.id, '\u001b]133;D;7\u0007');
    await expect(command).resolves.toMatchObject({ reason: 'command', exitCode: 7 });

    const until = service.wait(
      { taskId: 'task_1' },
      { id: terminal.id, mode: 'until', pattern: '^READY new$', timeoutMs: 5000, quietMs: 1000 },
      new AbortController().signal,
    );
    terminals.emitData(terminal.id, 'READY new');
    await expect(until).resolves.toMatchObject({ reason: 'until' });

    const controller = new AbortController();
    const cancelled = service.wait(
      { taskId: 'task_1' },
      { id: terminal.id, mode: 'quiet', timeoutMs: 5000, quietMs: 1000 },
      controller.signal,
    );
    expect(service.pendingWaiterCount()).toBe(1);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ error: { code: 'CANCELLED' } });
    expect(service.pendingWaiterCount()).toBe(0);
  });

  it('wakes turn waits from semantic completion events and survives send-to-wait races', async () => {
    const created = (await service.create(
      { taskId: 'task_1' },
      { root: '/repo', launch: 'codex', submit: true },
    )) as { terminal: TerminalInfo };
    terminals.agents.set(created.terminal.id, 'codex');

    const pending = service.wait(
      { taskId: 'task_1' },
      { id: created.terminal.id, mode: 'turn', timeoutMs: 5000, quietMs: 1000 },
      new AbortController().signal,
    );
    expect(service.pendingWaiterCount()).toBe(1);
    now += 12;
    service.notifyTurnSettled(created.terminal.id, {
      taskId: 'worker_task',
      status: 'ok',
      source: 'structured',
    });
    await expect(pending).resolves.toMatchObject({
      reason: 'turn',
      status: 'ok',
      source: 'structured',
      taskId: 'worker_task',
      durationMs: 12,
    });
    expect(service.pendingWaiterCount()).toBe(0);
    expect(service.snapshot().workers[0]).toMatchObject({ status: 'completed', busy: true });

    await service.send(
      { taskId: 'task_1' },
      { id: created.terminal.id, text: 'check once more', submit: true },
    );
    expect(service.snapshot().workers[0]?.status).toBe('streaming');
    service.notifyTurnSettled(created.terminal.id, {
      taskId: 'worker_task',
      status: 'error',
      source: 'observed',
    });
    await expect(
      service.wait(
        { taskId: 'task_1' },
        { id: created.terminal.id, mode: 'turn', timeoutMs: 5000, quietMs: 1000 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      reason: 'turn',
      status: 'error',
      source: 'observed',
      durationMs: 0,
    });
    expect(service.snapshot().workers[0]?.status).toBe('failed');
  });

  it('keeps settled turns idle across terminal repaints until a new input starts', async () => {
    const created = (await service.create(
      { taskId: 'task_1' },
      { root: '/repo', launch: 'shell', submit: true },
    )) as { terminal: TerminalInfo };

    service.notifyTurnSettled(created.terminal.id, {
      taskId: 'worker_task',
      status: 'ok',
      source: 'observed',
    });
    expect(service.snapshot().workers[0]?.status).toBe('completed');

    terminals.emitData(created.terminal.id, '\u001b[?25l\u001b[2K');
    expect(service.snapshot().workers[0]?.status).toBe('completed');

    terminals.emitData(created.terminal.id, '\r\u001b[2K* Twisting... (5m 1s)');
    expect(service.snapshot().workers[0]?.status).toBe('completed');

    service.notifyTurnStarted(created.terminal.id, {
      taskId: 'worker_task',
      source: 'input',
    });
    expect(service.snapshot().workers[0]?.status).toBe('streaming');
  });

  it('does not lose a direct launch completion that arrives before turn wait', async () => {
    const created = (await service.create(
      { taskId: 'task_1' },
      {
        root: '/repo',
        launch: 'claude',
        initialText: 'finish immediately',
        submit: true,
      },
    )) as { terminal: TerminalInfo };
    service.notifyTurnSettled(created.terminal.id, {
      taskId: 'worker_task',
      status: 'ok',
      source: 'structured',
    });

    await expect(
      service.wait(
        { taskId: 'task_1' },
        { id: created.terminal.id, mode: 'turn', timeoutMs: 5000, quietMs: 1000 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      reason: 'turn',
      turnSequence: 1,
      status: 'ok',
      durationMs: 0,
    });
  });
});

describe('TerminalControlIdentityRegistry (ORCH-008)', () => {
  it('issues distinct memory-only identities, supports a test override, and invalidates on clear', () => {
    const registry = new TerminalControlIdentityRegistry('/tmp/ctl.sock');
    const one = registry.issue('term_1');
    const two = registry.issue('term_2');
    expect(one.token).not.toBe(two.token);
    expect(registry.resolve(one.token)).toBe('term_1');
    expect(registry.environment('term_1')).toMatchObject({
      CHARTER_TERM_ID: 'term_1',
      CHARTER_CTL: '/tmp/ctl.sock',
    });
    registry.clear();
    expect(registry.resolve(one.token)).toBeNull();

    const overridden = new TerminalControlIdentityRegistry('/tmp/test.sock', 'fixture-token');
    expect(overridden.issue('term_test').token).toBe('fixture-token');
  });
});

void vi;
