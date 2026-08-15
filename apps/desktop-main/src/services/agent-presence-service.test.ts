import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@pi-ide/foundation';
import type { TerminalInfo } from '@pi-ide/terminal-service';
import {
  AgentPresenceService,
  BUILTIN_AGENT_LIFECYCLE_MANIFESTS,
  evaluateAgentPresence,
} from './agent-presence-service.js';
import { AgentPackService } from './agent-pack-service.js';

function logger() {
  return createLogger('agent-presence-test', { write: () => undefined });
}

class FakeTerminals {
  readonly agents = new Map<string, string>();
  readonly screens = new Map<string, string>();
  private readonly agentListeners = new Set<
    (info: { id: string; agent: string | null; cwd: string }) => void
  >();
  private readonly dataListeners = new Set<(info: { id: string; data: string }) => void>();
  private readonly exitListeners = new Set<(info: { id: string; exitCode: number }) => void>();

  onAgentState(listener: (info: { id: string; agent: string | null; cwd: string }) => void) {
    this.agentListeners.add(listener);
    return () => this.agentListeners.delete(listener);
  }

  onDataEvent(listener: (info: { id: string; data: string }) => void) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExitEvent(listener: (info: { id: string; exitCode: number }) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  agentFor(id: string): string | null {
    return this.agents.get(id) ?? null;
  }

  list(): TerminalInfo[] {
    return [...this.agents.keys()].map((id) => ({
      id,
      title: id,
      shell: '/bin/zsh',
      pid: 1,
      cwd: '/tmp/project',
      projectName: 'project',
      projectPath: '/tmp/project',
      contextKind: 'scratch',
      contextLabel: 'Scratch',
      contextTaskId: null,
      launch: this.agents.get(id) ?? 'shell',
      persistence: 'process',
    }));
  }

  async screenText(id: string) {
    const content = this.screens.get(id) ?? '';
    return { content, totalBytes: Buffer.byteLength(content) };
  }

  enter(id: string, agent: string, screen = ''): void {
    this.agents.set(id, agent);
    this.screens.set(id, screen);
    for (const listener of this.agentListeners) listener({ id, agent, cwd: '/tmp/project' });
  }

  data(id: string, data: string, screen?: string): void {
    if (screen !== undefined) this.screens.set(id, screen);
    for (const listener of this.dataListeners) listener({ id, data });
  }

  exit(id: string): void {
    this.agents.delete(id);
    for (const listener of this.agentListeners) listener({ id, agent: null, cwd: '/tmp/project' });
    for (const listener of this.exitListeners) listener({ id, exitCode: 0 });
  }
}

describe('agent lifecycle manifests', () => {
  it('ships only the three v1 external Agent manifests', () => {
    expect(BUILTIN_AGENT_LIFECYCLE_MANIFESTS.map((manifest) => manifest.id)).toEqual([
      'claude',
      'codex',
      'kimi',
    ]);
  });

  it('treats the Claude transcript viewer as a state-preserving overlay', () => {
    const result = evaluateAgentPresence('claude', {
      screen: 'showing detailed transcript\nctrl+o to toggle\n❯',
      oscTitle: '',
    });
    expect(result.matchedRule).toMatchObject({
      id: 'transcript_viewer',
      state: 'unknown',
      skipStateUpdate: true,
    });
  });

  it('recognizes current Codex trust and Kimi approval blockers', () => {
    expect(
      evaluateAgentPresence('codex', {
        screen: '> You are in /tmp/project\nDo you trust the contents of this directory?',
        oscTitle: 'Codex',
      }).matchedRule,
    ).toMatchObject({ id: 'trust_directory', state: 'blocked', visibleBlocker: true });

    expect(
      evaluateAgentPresence('kimi', {
        screen:
          'Run this command?\n↑↓ choose · ↵ confirm\nApprove once\nReject and tell Kimi what to do',
        oscTitle: '',
      }).matchedRule,
    ).toMatchObject({ id: 'current_approval_panel', state: 'blocked' });
  });

  it('covers provider startup trust and update gates', () => {
    expect(
      evaluateAgentPresence('claude', {
        screen: 'Do you trust the files in this folder? Yes, I trust this folder',
        oscTitle: '',
      }).matchedRule,
    ).toMatchObject({ id: 'folder_trust', state: 'blocked' });
    expect(
      evaluateAgentPresence('codex', {
        screen: 'Update available! 1. Update now 2. Skip until next version',
        oscTitle: '',
      }).matchedRule,
    ).toMatchObject({ id: 'update_available', state: 'blocked' });
    expect(
      evaluateAgentPresence('kimi', {
        screen: "Trust this folder? Enable project MCP servers · Don't trust",
        oscTitle: '',
      }).matchedRule,
    ).toMatchObject({ id: 'folder_trust', state: 'blocked' });
  });

  it('does not turn an unmatched known process into idle', () => {
    const result = evaluateAgentPresence('kimi', { screen: 'ordinary output', oscTitle: '' });
    expect(result.matchedRule).toBeNull();
    expect(result.fallbackReason).toContain('No lifecycle rule matched');
  });

  it('does not confuse a shell launch prompt with Claude composer idle', () => {
    const result = evaluateAgentPresence('claude', {
      screen: '❯ /tmp/bin/claude\nobserved-claude-ready',
      oscTitle: '',
    });
    expect(result.matchedRule).toBeNull();
  });

  it('classifies Working, Needs you and Done evidence for all five official Agents', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-official-presence-'));
    const manifests = new AgentPackService(join(root, 'packs'), logger())
      .activeManifests()
      .flatMap((entry) => (entry.manifest.lifecycle ? [entry.manifest.lifecycle] : []));
    const matched = (agent: string, screen: string) =>
      evaluateAgentPresence(agent, { screen, oscTitle: '' }, manifests).matchedRule;

    expect(matched('gemini', 'esc to cancel')).toMatchObject({ state: 'working' });
    expect(matched('gemini', '│ Apply this change')).toMatchObject({ state: 'blocked' });
    expect(matched('opencode', '■ ■ ■ ■ esc to interrupt')).toMatchObject({ state: 'working' });
    expect(matched('opencode', '△ Permission required')).toMatchObject({ state: 'blocked' });
    expect(matched('copilot', 'esc to cancel')).toMatchObject({ state: 'working' });
    expect(matched('copilot', 'esc to cancel · enter to confirm')).toMatchObject({
      state: 'blocked',
    });
    expect(matched('cursor-agent', 'ctrl+c to stop')).toMatchObject({ state: 'working' });
    expect(
      matched('cursor', 'waiting for approval · run this command? · run (once) (y)'),
    ).toMatchObject({
      state: 'blocked',
    });
    expect(matched('aider', 'Waiting for claude-3.7')).toMatchObject({ state: 'working' });
    expect(matched('aider', 'Confirm? (Y)es/(N)o [Yes]:')).toMatchObject({ state: 'blocked' });
    expect(matched('aider', 'diff multi> ')).toMatchObject({ state: 'idle' });
  });
});

describe('AgentPresenceService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('projects blockers, turn edges, unseen completion and seen state without task mutation', async () => {
    const terminals = new FakeTerminals();
    const events: string[] = [];
    const service = new AgentPresenceService(terminals, logger(), {
      onChanged: (presence) =>
        events.push(`${presence.lifecycle}:${presence.attention}:${presence.taskId ?? '-'}`),
      now: () => new Date('2026-08-11T10:00:00.000Z'),
    });

    terminals.enter(
      'term-1',
      'codex',
      '> You are in /tmp/project\nDo you trust the contents of this directory?',
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(service.get('term-1')).toMatchObject({
      lifecycle: 'blocked',
      attention: 'needs_user',
      matchedRuleId: 'trust_directory',
    });

    service.bindTask('term-1', 'task-1');
    service.notifyTurnStarted({ terminalId: 'term-1', taskId: 'task-1' });
    expect(service.get('term-1')).toMatchObject({ lifecycle: 'working', attention: 'none' });

    service.notifyTurnSettled({
      terminalId: 'term-1',
      taskId: 'task-1',
      status: 'ok',
      source: 'observed',
    });
    expect(service.get('term-1')).toMatchObject({
      lifecycle: 'idle',
      attention: 'done',
      taskId: 'task-1',
    });

    service.markSeen('term-1');
    expect(service.get('term-1')?.attention).toBe('none');
    expect(events).toContain('idle:done:task-1');
    service.dispose();
  });

  it('stabilizes visible idle across three samples but publishes working immediately', async () => {
    const terminals = new FakeTerminals();
    const service = new AgentPresenceService(terminals, logger());
    terminals.enter('term-2', 'claude', '❯');

    await vi.advanceTimersByTimeAsync(1);
    expect(service.get('term-2')?.lifecycle).toBe('unknown');
    await vi.advanceTimersByTimeAsync(110);
    expect(service.get('term-2')?.lifecycle).toBe('unknown');
    await vi.advanceTimersByTimeAsync(110);
    expect(service.get('term-2')).toMatchObject({
      lifecycle: 'idle',
      matchedRuleId: 'live_prompt_box',
    });

    terminals.data('term-2', '\u001b]2;⠋ Claude\u0007', 'working output');
    await vi.advanceTimersByTimeAsync(45);
    expect(service.get('term-2')).toMatchObject({
      lifecycle: 'working',
      source: 'osc',
      matchedRuleId: 'osc_title_working',
    });
    service.dispose();
  });

  it('retains a diagnostic snapshot after process exit', async () => {
    const terminals = new FakeTerminals();
    const service = new AgentPresenceService(terminals, logger());
    terminals.enter('term-3', 'kimi', '🌕');
    await vi.advanceTimersByTimeAsync(1);
    expect(service.get('term-3')?.lifecycle).toBe('working');

    terminals.exit('term-3');
    expect(service.get('term-3')).toMatchObject({
      processState: 'exited',
      lifecycle: 'unknown',
      attention: 'none',
      source: 'process',
    });
    service.dispose();
  });

  it('publishes event subscribers and increments identity only when the Agent restarts', () => {
    const terminals = new FakeTerminals();
    const service = new AgentPresenceService(terminals, logger());
    const observed: Array<{ identitySeq: number; stateChangeSeq: number }> = [];
    const unsubscribe = service.onChanged(({ identitySeq, stateChangeSeq }) =>
      observed.push({ identitySeq, stateChangeSeq }),
    );

    terminals.enter('term-4', 'claude');
    service.notifyTurnStarted({ terminalId: 'term-4', taskId: 'task-4' });
    terminals.exit('term-4');
    terminals.enter('term-4', 'claude');

    expect(observed.map((event) => event.identitySeq)).toEqual([1, 1, 1, 2]);
    expect(observed.map((event) => event.stateChangeSeq)).toEqual([1, 2, 3, 4]);
    unsubscribe();
    service.notifyTurnStarted({ terminalId: 'term-4', taskId: 'task-4' });
    expect(observed).toHaveLength(4);
    service.dispose();
  });
});
