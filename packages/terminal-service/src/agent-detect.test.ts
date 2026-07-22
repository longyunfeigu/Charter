import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import {
  AgentStateTracker,
  commandMatchesAgent,
  DEFAULT_AGENT_CLIS,
  findAgentInTable,
  TerminalManager,
  terminalCwdCommand,
  titleMatchesAgent,
  type ProcessTableEntry,
} from './index.js';

describe('terminalCwdCommand (host-owned quick-console context)', () => {
  it('quotes POSIX paths without allowing shell interpolation', () => {
    expect(terminalCwdCommand('/bin/zsh', "/tmp/a b/it's-safe")).toBe(
      "cd -- '/tmp/a b/it'\\''s-safe'",
    );
  });

  it('uses the native literal-path form on PowerShell and drive-aware cd on cmd', () => {
    expect(terminalCwdCommand('pwsh', "C:\\Work\\Edy's App")).toBe(
      "Set-Location -LiteralPath 'C:\\Work\\Edy''s App'",
    );
    expect(terminalCwdCommand('cmd.exe', 'D:\\Work Space')).toBe('cd /d "D:\\Work Space"');
  });
});

describe('titleMatchesAgent (ADR-0017)', () => {
  it('matches bare and path-qualified CLI names, case-insensitively', () => {
    expect(titleMatchesAgent('claude', DEFAULT_AGENT_CLIS)).toBe('claude');
    expect(titleMatchesAgent('/Users/x/.local/bin/claude', DEFAULT_AGENT_CLIS)).toBe('claude');
    expect(titleMatchesAgent('Codex', DEFAULT_AGENT_CLIS)).toBe('codex');
  });

  it('does not match shells, editors or prefixed names', () => {
    expect(titleMatchesAgent('zsh', DEFAULT_AGENT_CLIS)).toBeNull();
    expect(titleMatchesAgent('vim', DEFAULT_AGENT_CLIS)).toBeNull();
    expect(titleMatchesAgent('claude-helper', DEFAULT_AGENT_CLIS)).toBeNull();
  });
});

describe('commandMatchesAgent (npm-installed CLIs run as node)', () => {
  it('finds the CLI in the leading argv tokens', () => {
    expect(commandMatchesAgent('node /usr/local/bin/claude', DEFAULT_AGENT_CLIS)).toBe('claude');
    expect(commandMatchesAgent('/opt/bin/node /x/codex --model gpt', DEFAULT_AGENT_CLIS)).toBe(
      'codex',
    );
  });

  it('ignores matches deep in the arguments (files named claude)', () => {
    expect(commandMatchesAgent('vim a b c ./notes/claude', DEFAULT_AGENT_CLIS)).toBeNull();
  });
});

describe('AgentStateTracker', () => {
  it('enters immediately and exits only after the grace streak', () => {
    const t = new AgentStateTracker(2);
    expect(t.update('claude')).toEqual({ agent: 'claude' });
    expect(t.agent).toBe('claude');
    // One shell flash (TUI spawning a child) must NOT end the session.
    expect(t.update(null)).toBeNull();
    expect(t.update('claude')).toBeNull(); // still the same session
    expect(t.update(null)).toBeNull();
    expect(t.update(null)).toEqual({ agent: null });
    expect(t.agent).toBeNull();
  });

  it('is quiet while idle and while the same agent keeps running', () => {
    const t = new AgentStateTracker(2);
    expect(t.update(null)).toBeNull();
    expect(t.update('codex')).toEqual({ agent: 'codex' });
    expect(t.update('codex')).toBeNull();
  });

  it('switching CLIs mid-terminal fires a fresh enter edge', () => {
    const t = new AgentStateTracker(2);
    t.update('claude');
    expect(t.update('codex')).toEqual({ agent: 'codex' });
  });
});

describe('findAgentInTable (ADR-0017 amendment: generic process-tree fallback)', () => {
  it('finds an agent CLI anywhere below the root pid, through wrappers', () => {
    const entries: ProcessTableEntry[] = [
      { pid: 11, ppid: 10, command: '/bin/sh /usr/local/bin/some-wrap' },
      { pid: 12, ppid: 11, command: 'node /Users/x/.nvm/bin/claude --resume' },
    ];
    expect(findAgentInTable(entries, 10, DEFAULT_AGENT_CLIS)).toBe('claude');
  });

  it('returns null when nothing below the root matches', () => {
    const entries: ProcessTableEntry[] = [
      { pid: 11, ppid: 10, command: 'vim notes.md' },
      { pid: 12, ppid: 11, command: '/bin/sh' },
    ];
    expect(findAgentInTable(entries, 10, DEFAULT_AGENT_CLIS)).toBeNull();
  });

  it('ignores agent processes outside the root subtree', () => {
    const entries: ProcessTableEntry[] = [
      { pid: 21, ppid: 20, command: 'claude' }, // someone else's terminal
      { pid: 11, ppid: 10, command: 'vim notes.md' },
    ];
    expect(findAgentInTable(entries, 10, DEFAULT_AGENT_CLIS)).toBeNull();
  });
});

describe('TerminalManager.pollOnce detection gating (ADR-0017 amendment)', () => {
  let manager: TerminalManager | null = null;

  afterEach(() => {
    manager?.dispose();
    manager = null;
  });

  function setup(readTitle: () => string, table: () => ProcessTableEntry[] | null) {
    const events: Array<{ id: string; agent: string | null }> = [];
    const readProcessTable = vi.fn(table);
    manager = new TerminalManager(
      () => {},
      () => {},
      { agentPollMs: 0, readTitle, readProcessTable },
    );
    manager.onAgentState((e) => events.push({ id: e.id, agent: e.agent }));
    return { m: manager, events, readProcessTable };
  }

  it('detects a version-named foreground binary via the process-tree fallback (native claude installer)', () => {
    // Real-world shape: ~/.local/bin/claude → .../versions/2.1.209, so the
    // kernel short name node-pty reports is "2.1.209", never "claude".
    let title = '2.1.209';
    let shellPid = 0;
    const { m, events } = setup(
      () => title,
      () => [{ pid: 99991, ppid: shellPid, command: 'claude' }],
    );
    const info = m.create({ cwd: tmpdir(), shellPath: '/bin/sh' });
    shellPid = info.pid;

    m.pollOnce();
    expect(events).toEqual([{ id: info.id, agent: 'claude' }]);

    // Back at the prompt: exits after the grace streak, no scan needed.
    title = 'sh';
    m.pollOnce();
    m.pollOnce();
    expect(events).toEqual([
      { id: info.id, agent: 'claude' },
      { id: info.id, agent: null },
    ]);
  });

  it('detects codex behind an arbitrary wrapper title', () => {
    let shellPid = 0;
    const { m, events } = setup(
      () => 'codex-wrap',
      () => [
        { pid: 88001, ppid: shellPid, command: '/bin/sh /usr/local/bin/codex-wrap' },
        { pid: 88002, ppid: 88001, command: 'codex --model gpt' },
      ],
    );
    const info = m.create({ cwd: tmpdir(), shellPath: '/bin/sh' });
    shellPid = info.pid;

    m.pollOnce();
    expect(events).toEqual([{ id: info.id, agent: 'codex' }]);
  });

  it('still detects npm-installed CLIs whose foreground title is the interpreter', () => {
    let shellPid = 0;
    const { m, events } = setup(
      () => 'node',
      () => [{ pid: 77001, ppid: shellPid, command: 'node /Users/x/.nvm/bin/claude' }],
    );
    const info = m.create({ cwd: tmpdir(), shellPath: '/bin/sh' });
    shellPid = info.pid;

    m.pollOnce();
    expect(events).toEqual([{ id: info.id, agent: 'claude' }]);
  });

  it('never reads the process table while the terminal sits at a shell prompt', () => {
    let title = 'sh'; // the session's own shell
    const { m, events, readProcessTable } = setup(
      () => title,
      () => [],
    );
    m.create({ cwd: tmpdir(), shellPath: '/bin/sh' });

    for (const idle of ['sh', 'zsh', 'bash', 'fish', '-zsh']) {
      title = idle;
      m.pollOnce();
    }
    expect(readProcessTable).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('reads the process table at most once per poll across many busy terminals', () => {
    const { m, events, readProcessTable } = setup(
      () => 'vim',
      () => [],
    );
    m.create({ cwd: tmpdir(), shellPath: '/bin/sh' });
    m.create({ cwd: tmpdir(), shellPath: '/bin/sh' });

    m.pollOnce();
    expect(readProcessTable).toHaveBeenCalledTimes(1);
    m.pollOnce();
    expect(readProcessTable).toHaveBeenCalledTimes(2);
    expect(events).toEqual([]); // vim is busy but not an agent
  });

  it('fans out exact PTY input bytes for observed agent presence', () => {
    const { m } = setup(
      () => 'sh',
      () => [],
    );
    const info = m.create({ cwd: tmpdir(), shellPath: '/bin/sh' });
    const inputs: Array<{ id: string; data: string }> = [];
    const unsubscribe = m.onInputEvent((event) => inputs.push(event));

    m.write(info.id, 'hello observed agent\r');
    unsubscribe();
    m.write(info.id, 'not observed\r');

    expect(inputs).toEqual([{ id: info.id, data: 'hello observed agent\r' }]);
  });

  it('direct-spawns an agent with exact argv and emits its known state without polling', async () => {
    const output: string[] = [];
    const events: Array<{ id: string; agent: string | null }> = [];
    manager = new TerminalManager(
      (_id, data) => output.push(data),
      () => {},
      {
        agentPollMs: 0,
        shellIntegration: () => ({ dir: '/unused/in/direct-launch', enabled: true }),
      },
    );
    manager.onAgentState((event) => events.push({ id: event.id, agent: event.agent }));

    const info = manager.create({
      cwd: tmpdir(),
      executable: '/bin/sh',
      args: ['-c', "printf 'DIRECT_AGENT_OK\\n'; sleep 0.1"],
      knownAgent: 'codex',
      launch: 'codex',
    });

    expect(manager.agentFor(info.id)).toBe('codex');
    await vi.waitFor(() => expect(events[0]).toEqual({ id: info.id, agent: 'codex' }));
    await vi.waitFor(() => expect(output.join('')).toContain('DIRECT_AGENT_OK'));
  });
});
