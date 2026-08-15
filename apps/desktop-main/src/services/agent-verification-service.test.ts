import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentPresenceSnapshot } from '@pi-ide/ipc-contracts';
import type { TerminalInfo } from '@pi-ide/terminal-service';
import { AgentPackService } from './agent-pack-service.js';
import { AgentRegistry } from './agent-registry.js';
import { AgentVerificationService } from './agent-verification-service.js';

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as any;
}

class FakeTerminals {
  agent: string | null = null;
  data = '';
  terminal: TerminalInfo = {
    id: 'term_verify',
    title: 'Gemini check',
    shell: '/bin/zsh',
    pid: 42,
    cwd: '/tmp/project-secret',
    projectName: 'secret-project',
    projectPath: '/tmp/project-secret',
    contextKind: 'focused',
    contextLabel: 'secret-project',
    contextTaskId: null,
    launch: 'gemini',
    persistence: 'process',
  };
  private agentListeners = new Set<
    (value: { id: string; agent: string | null; cwd: string }) => void
  >();
  private dataListeners = new Set<(value: { id: string; data: string }) => void>();
  private exitListeners = new Set<(value: { id: string; exitCode: number }) => void>();

  list() {
    return [this.terminal];
  }
  agentFor() {
    return this.agent;
  }
  recentData() {
    return this.data;
  }
  onAgentState(listener: (value: { id: string; agent: string | null; cwd: string }) => void) {
    this.agentListeners.add(listener);
    return () => this.agentListeners.delete(listener);
  }
  onDataEvent(listener: (value: { id: string; data: string }) => void) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onExitEvent(listener: (value: { id: string; exitCode: number }) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  emitAgent(agent: string) {
    this.agent = agent;
    for (const listener of this.agentListeners) {
      listener({ id: this.terminal.id, agent, cwd: this.terminal.cwd });
    }
  }
  emitData(data: string) {
    this.data += data;
    for (const listener of this.dataListeners) listener({ id: this.terminal.id, data });
  }
}

class FakePresence {
  current: AgentPresenceSnapshot | null = null;
  private listeners = new Set<(value: AgentPresenceSnapshot) => void>();
  get() {
    return this.current;
  }
  onChanged(listener: (value: AgentPresenceSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(
    lifecycle: AgentPresenceSnapshot['lifecycle'],
    attention: AgentPresenceSnapshot['attention'],
  ) {
    this.current = {
      terminalId: 'term_verify',
      taskId: null,
      agent: 'gemini',
      processState: 'running',
      lifecycle,
      attention,
      source: 'screen-manifest',
      identitySeq: 1,
      stateChangeSeq: (this.current?.stateChangeSeq ?? 0) + 1,
      changedAt: new Date('2026-08-12T10:00:00.000Z').toISOString(),
      message: null,
      matchedRuleId: lifecycle,
      manifestVersion: 'fixture',
    };
    for (const listener of this.listeners) listener(this.current);
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'charter-agent-verification-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, 'gemini');
  writeFileSync(executable, '#!/bin/sh\necho 9.8.7\n');
  chmodSync(executable, 0o755);
  const packs = new AgentPackService(join(root, 'packs'), logger());
  const registry = new AgentRegistry(logger(), {
    homeDir: home,
    pathValue: bin,
    probeVersions: true,
    packManifests: () => packs.activeManifests(),
  });
  const terminals = new FakeTerminals();
  const presence = new FakePresence();
  const ledger = join(root, 'verification-results.json');
  const service = new AgentVerificationService(
    ledger,
    registry,
    () => packs.catalog(),
    terminals,
    presence,
    logger(),
    {
      now: () => new Date('2026-08-12T10:00:00.000Z'),
      randomId: () => 'verify_fixture',
      challenge: () => 'abc123',
      timeoutMs: 60_000,
    },
  );
  return { service, terminals, presence, ledger };
}

describe('AgentVerificationService', () => {
  it('separates bundled integration evidence from a real local challenge', () => {
    const { service, terminals, presence, ledger } = setup();
    expect(service.snapshot().agents.find((agent) => agent.agentId === 'gemini')).toMatchObject({
      installed: true,
      version: '9.8.7',
      level: 'integration_tested',
    });

    const begun = service.begin({ agentId: 'gemini', mode: 'core', target: 'local' });
    expect(begun.prompt).toContain('Challenge: abc123');
    expect(begun.prompt).not.toContain('CHARTER_AGENT_REPLY_321cba');
    service.attach(begun.run.id, 'term_verify');
    terminals.emitAgent('gemini');
    presence.emit('working', 'none');
    terminals.emitData('CHARTER_AGENT_');
    terminals.emitData('REPLY_321cba');
    presence.emit('idle', 'done');

    expect(service.getRun(begun.run.id)).toMatchObject({
      status: 'passed',
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'authentication', status: 'passed' }),
        expect.objectContaining({ id: 'lifecycle_working', status: 'passed' }),
        expect.objectContaining({ id: 'lifecycle_done', status: 'passed' }),
      ]),
    });
    expect(service.snapshot().agents.find((agent) => agent.agentId === 'gemini')?.level).toBe(
      'locally_verified',
    );
    const stored = readFileSync(ledger, 'utf8');
    expect(stored).not.toContain('abc123');
    expect(stored).not.toContain('CHARTER_AGENT_REPLY_321cba');
    expect(stored).not.toContain('/tmp/project-secret');
    service.dispose();
  });

  it('records a real blocker and verifies clipboard-image delivery separately', () => {
    const { service, terminals, presence } = setup();
    const core = service.begin({ agentId: 'gemini', mode: 'core', target: 'local' });
    service.attach(core.run.id, 'term_verify');
    terminals.emitAgent('gemini');
    presence.emit('blocked', 'needs_user');
    expect(service.getRun(core.run.id)).toMatchObject({
      status: 'needs_user',
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'lifecycle_needs_user', status: 'passed' }),
      ]),
    });
    service.cancel(core.run.id);

    const image = service.begin({ agentId: 'gemini', mode: 'image', target: 'local' });
    service.attach(image.run.id, 'term_verify');
    service.noteImagePasted('term_verify');
    terminals.emitData('CHARTER_AGENT_REPLY_321cba');
    expect(service.getRun(image.run.id)?.status).toBe('passed');

    const report = service.exportBundle({ appVersion: '1.0.0', platform: 'darwin-arm64' });
    expect(report.markdown).toContain('Charter Agent Compatibility Report');
    expect(report.json).not.toContain('term_verify');
    expect(report.json).not.toContain('/tmp/project-secret');
    service.dispose();
  });
});
