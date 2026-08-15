import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@pi-ide/foundation';
import { AgentRegistry } from './agent-registry.js';
import { AgentPackService } from './agent-pack-service.js';

function logger() {
  return createLogger('agent-registry-test', { write: () => undefined });
}

describe('AgentRegistry', () => {
  it('discovers and launches every bundled official Agent with truthful capabilities', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-official-agents-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const name of ['gemini', 'opencode', 'copilot', 'cursor-agent', 'aider']) {
      const path = join(bin, name);
      writeFileSync(path, '#!/bin/sh\nexit 0\n');
      chmodSync(path, 0o755);
    }
    const packs = new AgentPackService(join(root, 'packs'), logger());
    const registry = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: bin,
      probeVersions: false,
      packManifests: () => packs.activeManifests(),
    });
    const agents = registry.catalog().agents;

    for (const id of ['gemini', 'opencode', 'copilot', 'cursor', 'aider']) {
      expect(agents.find((agent) => agent.id === id)).toMatchObject({
        installed: true,
        adapter: { source: 'pack' },
        capabilities: { terminal: true, remote: true, exactResume: false, history: false },
      });
    }
    expect(registry.launchSpec('gemini', { prompt: 'inspect this' })?.args).toEqual([
      '--prompt-interactive',
      'inspect this',
    ]);
    expect(registry.launchSpec('opencode', { prompt: 'inspect this' })?.args).toEqual([
      '--prompt',
      'inspect this',
    ]);
    expect(registry.launchSpec('copilot', { prompt: 'inspect this' })).toMatchObject({
      args: [],
      promptDelivery: 'deferred',
    });
    expect(registry.launchSpec('cursor', { prompt: 'inspect this' })?.args).toEqual([
      'inspect this',
    ]);
    expect(registry.launchSpec('aider', { prompt: 'inspect this' })).toMatchObject({
      args: [],
      promptDelivery: 'deferred',
    });
    expect(
      registry.acpCommand('gemini', { runtimeAppPath: root, nodeExecutable: process.execPath }),
    ).toMatchObject({ args: ['--acp'] });
    expect(
      registry.acpCommand('opencode', { runtimeAppPath: root, nodeExecutable: process.execPath }),
    ).toMatchObject({ args: ['acp'] });
    expect(
      registry.acpCommand('copilot', { runtimeAppPath: root, nodeExecutable: process.execPath }),
    ).toMatchObject({ args: ['--acp', '--stdio'] });
    expect(
      registry.acpCommand('cursor', { runtimeAppPath: root, nodeExecutable: process.execPath }),
    ).toBeNull();
    expect(
      registry.acpCommand('aider', { runtimeAppPath: root, nodeExecutable: process.execPath }),
    ).toBeNull();
    expect(agents.find((agent) => agent.id === 'cursor')?.capabilities).toMatchObject({
      images: false,
      skills: false,
      instructions: true,
    });
    expect(agents.find((agent) => agent.id === 'aider')?.capabilities).toMatchObject({
      images: true,
      skills: false,
      instructions: false,
    });
    expect(registry.skillRoots('gemini')).toEqual([join(root, '.gemini', 'skills')]);
    expect(registry.resumeArguments('gemini', 'latest')).toBeNull();
    expect(registry.remoteLaunchSpec('gemini', { prompt: 'inspect this' })).toEqual({
      command: 'gemini',
      args: ['--prompt-interactive', 'inspect this'],
      promptDelivery: 'argv',
      sessionId: null,
    });
    expect(registry.remoteLaunchSpec('cursor', { prompt: 'inspect this' })).toEqual({
      command: 'cursor-agent',
      args: ['inspect this'],
      promptDelivery: 'argv',
      sessionId: null,
    });
    expect(registry.remoteLaunchSpec('copilot', { prompt: 'inspect this' })).toEqual({
      command: 'copilot',
      args: [],
      promptDelivery: 'deferred',
      sessionId: null,
    });
    expect(registry.terminalAgentCliIdentities().find((item) => item.id === 'cursor')).toEqual({
      id: 'cursor',
      aliases: ['cursor', 'cursor-agent'],
    });
  });

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
    expect(agents.find((agent) => agent.id === 'codex')).toMatchObject({
      installed: false,
      capabilities: { terminal: false, remote: true },
    });
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
    expect(registry.resumeArguments('kimi', null)).toEqual(['--continue']);
    expect(registry.resumeArguments('codex', 'b04b292c-b7b4-456a-893c-3a22675771f9')).toEqual([
      'resume',
      'b04b292c-b7b4-456a-893c-3a22675771f9',
    ]);
    expect(registry.terminalExitSequence('kimi')).toEqual(['interrupt', 'interrupt', 'interrupt']);
    expect(registry.terminalExitSequence('codex')).toEqual(['interrupt', 'eof']);
  });

  it('delivers Codex composer prompts after its TUI is ready', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-registry-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const codex = join(bin, 'codex');
    writeFileSync(codex, '#!/bin/sh\nexit 0\n');
    chmodSync(codex, 0o755);
    const registry = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: bin,
      probeVersions: false,
    });

    expect(registry.launchSpec('codex', { prompt: 'review this' })).toMatchObject({
      executable: codex,
      args: [],
      promptDelivery: 'deferred',
    });
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
        schemaVersion: 1,
        adapterVersion: 'dev.1',
        engine: { min: 1, max: 1 },
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
        capabilities: {
          terminal: true,
          acp: false,
          loadSession: false,
          sessionList: false,
          sessionResume: false,
          images: false,
          embeddedContext: false,
          mcp: false,
          exactResume: false,
          history: false,
          skills: false,
          instructions: false,
          remote: false,
          lifecycle: 'none',
        },
        lifecycle: null,
      }),
    );
    const registry = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: bin,
      userManifestDir: manifests,
      allowOverrides: true,
      probeVersions: false,
    });

    expect(registry.catalog().agents.find((agent) => agent.id === 'aider')).toMatchObject({
      installed: true,
      executable: aider,
      adapter: { source: 'override', adapterVersion: 'dev.1' },
      capabilities: { terminal: true },
    });
    expect(registry.launchSpec('aider', { prompt: 'review this' })).toMatchObject({
      executable: aider,
      args: ['--message', 'review this'],
      promptDelivery: 'argv',
    });
    expect(registry.terminalExitSequence('aider')).toEqual(['interrupt', 'eof']);
  });

  it('isolates invalid and incompatible overrides while retaining bundled Adapters', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-registry-'));
    const manifests = join(root, 'manifests');
    mkdirSync(manifests);
    const bundled = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: '',
      probeVersions: false,
    });
    const codex = bundled.manifest('codex')!;
    const kimi = bundled.manifest('kimi')!;
    writeFileSync(join(manifests, 'broken.json'), '{ nope');
    writeFileSync(
      join(manifests, 'codex.json'),
      JSON.stringify({ ...codex, adapterVersion: 'future.1', engine: { min: 2, max: 3 } }),
    );
    writeFileSync(
      join(manifests, 'kimi.json'),
      JSON.stringify({ ...kimi, unexpectedProviderSwitch: true }),
    );

    const registry = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: '',
      userManifestDir: manifests,
      allowOverrides: true,
      probeVersions: false,
    });
    const catalog = registry.catalog();

    expect(catalog.agents.find((agent) => agent.id === 'codex')?.adapter).toMatchObject({
      source: 'builtin',
      adapterVersion: '2026.08.12.1',
    });
    expect(catalog.agents.find((agent) => agent.id === 'kimi')?.adapter.source).toBe('builtin');
    expect(catalog.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
      'incompatible-engine',
      'invalid-json',
      'invalid-manifest',
    ]);
  });

  it('activates a complete local override and projects its lifecycle into Presence', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-registry-'));
    const manifests = join(root, 'manifests');
    mkdirSync(manifests);
    const bundled = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: '',
      probeVersions: false,
    });
    const claude = bundled.manifest('claude')!;
    const path = join(manifests, 'claude.json');
    writeFileSync(
      path,
      JSON.stringify({
        ...claude,
        adapterVersion: 'dev.42',
        lifecycle: { ...claude.lifecycle!, version: 'dev.lifecycle.42' },
      }),
    );

    const registry = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: '',
      userManifestDir: manifests,
      allowOverrides: true,
      probeVersions: false,
    });

    expect(registry.catalog().agents.find((agent) => agent.id === 'claude')?.adapter).toEqual({
      schemaVersion: 1,
      adapterVersion: 'dev.42',
      engineMin: 1,
      engineMax: 1,
      source: 'override',
      sourcePath: path,
      lifecycleVersion: 'dev.lifecycle.42',
      lifecycleAuthority: 'none',
    });
    expect(
      registry.lifecycleManifests().find((manifest) => manifest.id === 'claude')?.version,
    ).toBe('dev.lifecycle.42');
  });

  it('does not load local overrides when developer mode is disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-registry-'));
    const manifests = join(root, 'manifests');
    mkdirSync(manifests);
    writeFileSync(join(manifests, 'ignored.json'), '{}');

    const registry = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: '',
      userManifestDir: manifests,
      allowOverrides: false,
      probeVersions: false,
    });

    expect(registry.catalog().diagnostics).toMatchObject([
      { code: 'override-disabled', severity: 'warning' },
    ]);
    expect(registry.catalog().agents).toHaveLength(3);
  });

  it('rejects invalid lifecycle regex before it can affect Presence scans', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-registry-'));
    const manifests = join(root, 'manifests');
    mkdirSync(manifests);
    const bundled = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: '',
      probeVersions: false,
    });
    const claude = bundled.manifest('claude')!;
    writeFileSync(
      join(manifests, 'claude.json'),
      JSON.stringify({
        ...claude,
        lifecycle: {
          ...claude.lifecycle!,
          rules: [{ ...claude.lifecycle!.rules[0], regex: ['['] }],
        },
      }),
    );

    const registry = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: '',
      userManifestDir: manifests,
      allowOverrides: true,
      probeVersions: false,
    });

    expect(registry.catalog().diagnostics).toMatchObject([
      { code: 'invalid-manifest', message: expect.stringContaining('invalid regular expression') },
    ]);
    expect(registry.catalog().agents.find((agent) => agent.id === 'claude')?.adapter.source).toBe(
      'builtin',
    );
  });
});
