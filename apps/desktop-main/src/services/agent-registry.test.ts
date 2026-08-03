import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@pi-ide/foundation';
import { AgentRegistry } from './agent-registry.js';

function logger() {
  return createLogger('agent-registry-test', { write: () => undefined });
}

describe('AgentRegistry', () => {
  it('auto-detects installed manifests without provider branches', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-registry-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const name of ['claude', 'kimi']) {
      const path = join(bin, name);
      writeFileSync(path, '#!/bin/sh\nexit 0\n');
      chmodSync(path, 0o755);
    }
    const registry = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: bin,
      probeVersions: false,
    });
    const agents = registry.catalog().agents;
    expect(agents.find((agent) => agent.id === 'claude')?.installed).toBe(true);
    expect(agents.find((agent) => agent.id === 'codex')?.installed).toBe(false);
    expect(agents.find((agent) => agent.id === 'kimi')?.capabilities.acp).toBe(true);
  });

  it('finds CLIs installed under a version manager when the GUI PATH is minimal', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-registry-'));
    const bin = join(root, '.nvm', 'versions', 'node', 'v24.18.0', 'bin');
    mkdirSync(bin, { recursive: true });
    const codex = join(bin, 'codex');
    writeFileSync(codex, '#!/bin/sh\nexit 0\n');
    chmodSync(codex, 0o755);
    const registry = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: '/usr/bin:/bin',
      probeVersions: false,
    });

    expect(registry.executableFor('codex')).toBe(codex);
  });

  it('uses manifest-defined launch and resume behavior', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-registry-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const kimi = join(bin, 'kimi');
    writeFileSync(kimi, '#!/bin/sh\nexit 0\n');
    chmodSync(kimi, 0o755);
    const registry = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: bin,
      probeVersions: false,
    });
    expect(registry.launchSpec('kimi', { prompt: 'hello' })).toMatchObject({
      executable: kimi,
      args: [],
      promptDelivery: 'deferred',
    });
    expect(registry.resumeCommand('kimi', 'session_b04b292c-b7b4-456a-893c-3a22675771f9')).toEqual({
      executable: kimi,
      args: ['--session', 'session_b04b292c-b7b4-456a-893c-3a22675771f9'],
    });
    expect(registry.terminalExitSequence('kimi')).toEqual(['interrupt', 'interrupt', 'interrupt']);
    expect(registry.terminalExitSequence('codex')).toEqual(['interrupt', 'eof']);
  });

  it('moves Kimi session, Skill and instruction surfaces with KIMI_CODE_HOME', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-registry-'));
    const bin = join(root, 'bin');
    const dataHome = join(root, 'kimi-data');
    mkdirSync(bin);
    const kimi = join(bin, 'kimi');
    writeFileSync(kimi, '#!/bin/sh\nexit 0\n');
    chmodSync(kimi, 0o755);
    const previous = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = dataHome;
    try {
      const registry = new AgentRegistry(logger(), {
        pathValue: bin,
        probeVersions: false,
      });
      expect(registry.skillRoots('kimi')[0]).toBe(join(dataHome, 'skills'));
      expect(registry.skillSources().find((source) => source.id === 'kimi')?.root).toBe(
        join(dataHome, 'skills'),
      );
      expect(registry.historySources()).toContainEqual({
        id: 'kimi',
        connector: 'kimi',
        dataHome,
      });
    } finally {
      if (previous === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previous;
    }
  });

  it('discovers and launches a user-defined Agent without a core provider branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-registry-'));
    const bin = join(root, 'bin');
    const manifests = join(root, 'manifests');
    mkdirSync(bin);
    mkdirSync(manifests);
    const aider = join(bin, 'aider');
    writeFileSync(aider, '#!/bin/sh\nexit 0\n');
    chmodSync(aider, 0o755);
    writeFileSync(
      join(manifests, 'aider.json'),
      JSON.stringify({
        id: 'aider',
        displayName: 'Aider',
        shortName: 'Aider',
        description: 'User-defined coding Agent',
        mark: 'generic',
        accent: '#345678',
        discovery: { commands: ['aider'], knownPaths: [], versionArgs: ['--version'] },
        terminal: {
          promptDelivery: 'argv',
          initialPromptArgs: ['--message', '{prompt}'],
        },
        acp: null,
        sessions: null,
        surfaces: { skillRoots: [], instructionRoots: [], remote: false },
      }),
    );
    const registry = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: bin,
      userManifestDir: manifests,
      probeVersions: false,
    });

    expect(registry.catalog().agents.find((agent) => agent.id === 'aider')).toMatchObject({
      installed: true,
      executable: aider,
      source: 'user',
      capabilities: { terminal: true },
    });
    expect(registry.launchSpec('aider', { prompt: 'review this' })).toMatchObject({
      executable: aider,
      args: ['--message', 'review this'],
      promptDelivery: 'argv',
    });
    expect(registry.terminalExitSequence('aider')).toEqual(['interrupt', 'eof']);
  });
});
