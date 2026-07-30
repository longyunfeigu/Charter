import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalManager, type ProcessTableEntry, type TerminalBackend } from './index.js';

/**
 * A non-pty backend used to prove the manager is transport agnostic (ADR-0047).
 * `emit`/`exit` let a test drive the backend the way a real SSH channel would.
 */
class FakeBackend implements TerminalBackend {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = 0;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((exitCode: number) => void) | null = null;

  constructor(private readonly title: string | null = null) {}

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killed += 1;
  }

  hasChildren(): boolean {
    return false;
  }

  processTitle(): string | null {
    return this.title;
  }

  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }

  onExit(cb: (exitCode: number) => void): void {
    this.exitCb = cb;
  }

  /** Simulate the remote channel producing output. */
  emit(data: string): void {
    this.dataCb?.(data);
  }

  /** Simulate the remote channel closing. */
  exit(code: number): void {
    this.exitCb?.(code);
  }
}

describe('TerminalManager.adoptBackend (SSH remote sessions, ADR-0047)', () => {
  let manager: TerminalManager | null = null;

  afterEach(() => {
    manager?.dispose();
    manager = null;
  });

  it('adopts a backend and fans out data, exit and list membership like a local pty', () => {
    const output: Array<{ id: string; data: string }> = [];
    const exits: Array<{ id: string; exitCode: number }> = [];
    manager = new TerminalManager(
      (id, data) => output.push({ id, data }),
      (id, exitCode) => exits.push({ id, exitCode }),
      { agentPollMs: 0 },
    );
    const dataEvents: Array<{ id: string; data: string }> = [];
    const exitEvents: Array<{ id: string; exitCode: number }> = [];
    manager.onDataEvent((e) => dataEvents.push(e));
    manager.onExitEvent((e) => exitEvents.push(e));

    const backend = new FakeBackend();
    const info = manager.adoptBackend(backend, {
      title: 'web (remote)',
      cwd: '/srv/app',
      projectName: 'app',
      remote: {
        hostId: 'h1',
        hostLabel: 'prod',
        username: 'deploy',
        host: 'example.com',
        port: 22,
      },
    });

    // No local process behind a remote session.
    expect(info.pid).toBe(-1);
    expect(info.remote).toEqual({
      hostId: 'h1',
      hostLabel: 'prod',
      username: 'deploy',
      host: 'example.com',
      port: 22,
    });
    expect(manager.list().map((t) => t.id)).toEqual([info.id]);

    // Input reaches the backend, not a pty.
    manager.write(info.id, 'ls\r', 'user');
    expect(backend.writes).toEqual(['ls\r']);

    // Output fans out to onData, the data-event mirror and the replay buffer.
    backend.emit('file1\n');
    expect(output).toEqual([{ id: info.id, data: 'file1\n' }]);
    expect(dataEvents).toEqual([{ id: info.id, data: 'file1\n' }]);
    expect(manager.recentData(info.id)).toBe('file1\n');

    // Exit fans out to onExit and the exit-event mirror, then drops the session.
    backend.exit(0);
    expect(exits).toEqual([{ id: info.id, exitCode: 0 }]);
    expect(exitEvents).toEqual([{ id: info.id, exitCode: 0 }]);
    expect(manager.list()).toEqual([]);
  });

  it('reads the emulated VT screen instead of an ANSI-stripped repaint stream', async () => {
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0 },
    );
    const backend = new FakeBackend();
    const info = manager.adoptBackend(backend, {
      title: 'codex',
      cwd: '/repo',
      projectName: 'repo',
      cols: 40,
      rows: 6,
    });

    backend.emit('\u001b[?1049h\u001b[2J\u001b[H');
    backend.emit('\u001b(0lqqqqk\u001b(B\r\n');
    backend.emit('Working...\r\u001b[2K完成：中文 review');

    const snapshot = await manager.screenText(info.id, 4096);
    expect(snapshot?.content).toContain('┌────┐');
    expect(snapshot?.content).toContain('完成：中文 review');
    expect(snapshot?.content).not.toContain('Working');
    expect(snapshot?.content).not.toContain('qqqq');
    expect(snapshot?.content).not.toContain('\u001b');
  });

  it('caps VT screen text on a valid UTF-8 boundary', async () => {
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0 },
    );
    const backend = new FakeBackend();
    const info = manager.adoptBackend(backend, {
      title: 'codex',
      cwd: '/repo',
      projectName: 'repo',
      cols: 40,
      rows: 4,
    });
    backend.emit('前置内容\r\n最终结论：饮食记录需求完整');

    const snapshot = await manager.screenText(info.id, 24);
    expect(snapshot?.totalBytes).toBeGreaterThan(24);
    expect(snapshot?.content).not.toContain('�');
    expect(Buffer.byteLength(snapshot?.content ?? '', 'utf8')).toBeLessThanOrEqual(24);
  });

  it('delegates kill to the backend once and forgets the session', () => {
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0 },
    );
    const backend = new FakeBackend();
    const info = manager.adoptBackend(backend, { title: 't', cwd: '/x', projectName: 'x' });

    manager.kill(info.id);
    expect(backend.killed).toBe(1);
    expect(manager.list()).toEqual([]);

    // Killing an already-removed session is a no-op (does not re-hit the backend).
    manager.kill(info.id);
    expect(backend.killed).toBe(1);
  });

  it('delegates resize to the backend within the usual bounds guard', () => {
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0 },
    );
    const backend = new FakeBackend();
    const info = manager.adoptBackend(backend, { title: 't', cwd: '/x', projectName: 'x' });

    manager.resize(info.id, 120, 40);
    manager.resize(info.id, 1, 0); // out of bounds — ignored before reaching the backend
    expect(backend.resizes).toEqual([[120, 40]]);
  });

  it('reports no running children for a non-pty backend', () => {
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0 },
    );
    const backend = new FakeBackend();
    const info = manager.adoptBackend(backend, { title: 't', cwd: '/x', projectName: 'x' });
    expect(manager.hasRunningChildren(info.id)).toBe(false);
  });

  it('notifies a known-agent backend immediately and never downgrades it on poll', async () => {
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0 },
    );
    const events: Array<{ id: string; agent: string | null }> = [];
    manager.onAgentState((e) => events.push({ id: e.id, agent: e.agent }));

    // Even a title that would match is irrelevant: knownAgent gates polling.
    const backend = new FakeBackend('claude');
    const info = manager.adoptBackend(backend, {
      title: 'claude (remote)',
      cwd: '/x',
      projectName: 'x',
      knownAgent: 'claude',
      launch: 'claude',
    });

    expect(manager.agentFor(info.id)).toBe('claude');
    await vi.waitFor(() => expect(events).toEqual([{ id: info.id, agent: 'claude' }]));

    manager.pollOnce();
    manager.pollOnce();
    expect(events).toEqual([{ id: info.id, agent: 'claude' }]);
    expect(manager.agentFor(info.id)).toBe('claude');
  });

  it('skips agent detection entirely for a backend with no local process', () => {
    const readProcessTable = vi.fn((): ProcessTableEntry[] => []);
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0, readProcessTable },
    );
    const events: Array<{ id: string; agent: string | null }> = [];
    manager.onAgentState((e) => events.push({ id: e.id, agent: e.agent }));

    manager.adoptBackend(new FakeBackend(null), { title: 'remote', cwd: '/x', projectName: 'x' });
    manager.pollOnce();
    manager.pollOnce();

    // processTitle() === null short-circuits before any title read or ps scan.
    expect(readProcessTable).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('injectData surfaces synthetic output through the data fan-out only', () => {
    const output: Array<{ id: string; data: string }> = [];
    manager = new TerminalManager(
      (id, data) => output.push({ id, data }),
      () => {},
      { agentPollMs: 0 },
    );
    const dataEvents: Array<{ id: string; data: string }> = [];
    manager.onDataEvent((e) => dataEvents.push(e));

    const backend = new FakeBackend();
    const info = manager.adoptBackend(backend, { title: 't', cwd: '/x', projectName: 'x' });

    manager.injectData(info.id, '\r\n[connection lost]\r\n');
    expect(output).toEqual([{ id: info.id, data: '\r\n[connection lost]\r\n' }]);
    expect(dataEvents).toEqual([{ id: info.id, data: '\r\n[connection lost]\r\n' }]);
    expect(manager.recentData(info.id)).toBe('\r\n[connection lost]\r\n');
    // Display-only: it must not travel the backend's write/input path.
    expect(backend.writes).toEqual([]);

    // Unknown id is a no-op.
    manager.injectData('term_missing', 'ignored');
    expect(output).toHaveLength(1);
  });

  it('restores a truncated G0 DEC line-drawing designation', () => {
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0 },
    );
    const backend = new FakeBackend();
    const info = manager.adoptBackend(backend, { title: 't', cwd: '/x', projectName: 'x' });

    backend.emit(`\u001b(0${'a'.repeat(64 * 1024)}qqq`);
    const replay = manager.recentData(info.id);

    expect(replay).toHaveLength(64 * 1024 + 3);
    expect(replay.startsWith('\u001b(0')).toBe(true);
    expect(replay.endsWith('qqq')).toBe(true);
  });

  it('restores G1 DEC line drawing and the active shift state', () => {
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0 },
    );
    const backend = new FakeBackend();
    const info = manager.adoptBackend(backend, { title: 't', cwd: '/x', projectName: 'x' });

    backend.emit(`\u001b)0\u000e${'x'.repeat(64 * 1024 + 8)}`);
    expect(manager.recentData(info.id)).toBe(`\u001b)0\u000e${'x'.repeat(64 * 1024)}`);
  });

  it('never starts a replay in the middle of an escape sequence', () => {
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0 },
    );
    const backend = new FakeBackend();
    const info = manager.adoptBackend(backend, { title: 't', cwd: '/x', projectName: 'x' });

    // The nominal 64 KiB cut falls between ESC ( and its final designator.
    backend.emit(`\u001b(0${'q'.repeat(64 * 1024 - 1)}`);
    const replay = manager.recentData(info.id);

    expect(replay.startsWith('\u001b(0q')).toBe(true);
    expect(replay.slice(3)).not.toContain('\u001b');
  });

  it('does not add a replay prefix for ordinary ASCII output', () => {
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0 },
    );
    const backend = new FakeBackend();
    const info = manager.adoptBackend(backend, { title: 't', cwd: '/x', projectName: 'x' });

    backend.emit('a'.repeat(64 * 1024 + 8));
    expect(manager.recentData(info.id)).toBe('a'.repeat(64 * 1024));
  });

  it('drops an oversized unterminated control string until its terminator', () => {
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0 },
    );
    const backend = new FakeBackend();
    const info = manager.adoptBackend(backend, { title: 't', cwd: '/x', projectName: 'x' });

    backend.emit(`\u001b]0;${'x'.repeat(96 * 1024)}`);
    expect(manager.recentData(info.id)).toBe('');

    backend.emit('\u0007visible');
    expect(manager.recentData(info.id)).toBe('visible');
  });
});
