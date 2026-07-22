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

  it('strips ANSI and caps each in-memory rolling buffer at 200KB', async () => {
    const terminal = terminals.create({ cwd: '/tmp' });
    terminals.emitData(terminal.id, '\u001b[31mred\u001b[0m\n');
    terminals.emitData(terminal.id, 'x'.repeat(TERMINAL_BUFFER_BYTES + 100));
    expect(service.bufferBytes(terminal.id)).toBeLessThanOrEqual(TERMINAL_BUFFER_BYTES);
    const read = service.read({ taskId: 'task_1' }, { id: terminal.id, maxBytes: 1024 }) as {
      content: string;
      bytes: number;
    };
    expect(read.content).not.toContain('\u001b');
    expect(read.bytes).toBeLessThanOrEqual(1024);
    expect(stripTerminalAnsi('\u001b]133;D;0\u0007ok')).toBe('ok');
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
        executable: 'claude',
        knownAgent: 'claude',
      });
      expect(terminals.creates[0]?.args?.[0]).toBe('--session-id');
      expect(terminals.creates[0]?.args?.[1]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(terminals.creates[0]?.args?.slice(2)).toEqual(['--', 'review claude']);
      expect(terminals.creates[1]).toMatchObject({
        executable: 'codex',
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
