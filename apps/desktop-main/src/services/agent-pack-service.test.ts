import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@pi-ide/foundation';
import { AgentRegistry } from './agent-registry.js';
import { AgentPackService, agentPackSignaturePayload } from './agent-pack-service.js';

function logger() {
  return createLogger('agent-pack-test', { write: () => undefined });
}

function adapter(id = 'fixture-agent', command = id) {
  return {
    schemaVersion: 1 as const,
    adapterVersion: '1.0.0',
    engine: { min: 1, max: 1 },
    id,
    displayName: id === 'fixture-agent' ? 'Fixture Agent' : id,
    shortName: id,
    description: 'Pack-provided test Agent',
    mark: 'generic',
    accent: '#345678',
    discovery: { commands: [command], knownPaths: [], versionArgs: ['--version'] },
    terminal: {
      promptDelivery: 'argv' as const,
      initialPromptArgs: ['--message', '{prompt}'],
      startup: {
        gateMarkers: [],
        readyMarkers: [],
        readyRequired: false,
        requireBracketedPaste: true,
        deferInitialProbe: false,
        updateGate: null,
      },
      exitSequence: ['interrupt' as const, 'eof' as const],
    },
    acp: null,
    sessions: null,
    surfaces: { skillRoots: [], instructionRoots: [], remote: true },
    capabilities: {
      terminal: true,
      acp: false,
      loadSession: false,
      sessionList: false,
      sessionResume: false,
      images: true,
      embeddedContext: false,
      mcp: false,
      exactResume: false,
      history: false,
      skills: false,
      instructions: false,
      remote: true,
      lifecycle: 'none' as const,
    },
    lifecycle: null,
  };
}

function pack(version: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'fixture-agent-pack',
    version,
    displayName: 'Fixture Agent Adapter Pack',
    publisher: 'Charter Tests',
    engine: { min: 1, max: 1 },
    adapters: [adapter()],
    ...overrides,
  };
}

function writePack(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('AgentPackService', () => {
  it('installs a data-only Pack and hot-loads its Adapter through the registry', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-pack-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'fixture-agent');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    const packs = new AgentPackService(join(root, 'store'), logger());
    const installed = packs.install(
      writePack(root, 'fixture-agent.charter-agent-pack.json', pack('1.0.0')),
    );
    expect(installed).toMatchObject({
      id: 'fixture-agent-pack',
      enabled: true,
      trust: 'local',
      adapterIds: ['fixture-agent'],
    });

    const registry = new AgentRegistry(logger(), {
      homeDir: root,
      pathValue: bin,
      probeVersions: false,
      packManifests: () => packs.activeManifests(),
    });
    expect(registry.catalog().agents.find((agent) => agent.id === 'fixture-agent')).toMatchObject({
      installed: true,
      executable,
      adapter: { source: 'pack', adapterVersion: '1.0.0' },
      capabilities: { terminal: true, images: true, remote: true },
    });
    expect(registry.launchSpec('fixture-agent', { prompt: 'review' })?.args).toEqual([
      '--message',
      'review',
    ]);

    expect(packs.setEnabled('fixture-agent-pack', false)).toBe(true);
    registry.reload();
    expect(registry.isKnown('fixture-agent')).toBe(false);
  });

  it('keeps version history, blocks downgrades, and rolls back atomically', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-pack-'));
    const packs = new AgentPackService(join(root, 'store'), logger());
    packs.install(writePack(root, 'v1.json', pack('1.0.0')));
    packs.install(
      writePack(
        root,
        'v2.json',
        pack('1.1.0', { adapters: [adapter('fixture-agent', 'fixture-agent2')] }),
      ),
    );
    expect(packs.catalog().packs.find((item) => item.id === 'fixture-agent-pack')).toMatchObject({
      currentVersion: '1.1.0',
      previousVersion: '1.0.0',
      availableVersions: ['1.1.0', '1.0.0'],
    });
    expect(() => packs.install(writePack(root, 'old.json', pack('0.9.0')))).toThrow(/older/);

    expect(packs.rollback('fixture-agent-pack')).toBe(true);
    expect(packs.catalog().packs.find((item) => item.id === 'fixture-agent-pack')).toMatchObject({
      currentVersion: '1.0.0',
      previousVersion: '1.1.0',
    });
  });

  it('ships the five verified official Adapters and persists only their enablement', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-pack-'));
    const packs = new AgentPackService(join(root, 'store'), logger());
    const official = packs.catalog().packs.find((item) => item.id === 'charter-official-agents');

    expect(official).toMatchObject({
      bundled: true,
      enabled: true,
      trust: 'verified',
      adapterIds: ['gemini', 'opencode', 'copilot', 'cursor', 'aider'],
    });
    expect(packs.activeManifests().map((entry) => entry.manifest.id)).toEqual([
      'gemini',
      'opencode',
      'copilot',
      'cursor',
      'aider',
    ]);

    expect(packs.setEnabled('charter-official-agents', false)).toBe(true);
    expect(packs.activeManifests()).toEqual([]);
    const reloaded = new AgentPackService(join(root, 'store'), logger());
    expect(
      reloaded.catalog().packs.find((item) => item.id === 'charter-official-agents')?.enabled,
    ).toBe(false);
    expect(() => reloaded.remove('charter-official-agents')).toThrow(/not removed/);
    expect(() => reloaded.rollback('charter-official-agents')).toThrow(/no local rollback/);
  });

  it('prevents local Packs from replacing official ids or the official Pack id', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-pack-'));
    const packs = new AgentPackService(join(root, 'store'), logger());
    expect(() =>
      packs.install(
        writePack(root, 'gemini.json', pack('1.0.0', { adapters: [adapter('gemini')] })),
      ),
    ).toThrow(/already owned/);
    expect(() =>
      packs.install(
        writePack(root, 'official.json', pack('1.0.0', { id: 'charter-official-agents' })),
      ),
    ).toThrow(/reserved/);
  });

  it('rejects same-version mutation, built-in replacement, and unknown signing keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-pack-'));
    const packs = new AgentPackService(join(root, 'store'), logger());
    packs.install(writePack(root, 'first.json', pack('1.0.0')));
    expect(() =>
      packs.install(
        writePack(root, 'mutated.json', pack('1.0.0', { displayName: 'Changed in place' })),
      ),
    ).toThrow(/different contents/);
    expect(() =>
      new AgentPackService(join(root, 'builtin-store'), logger()).install(
        writePack(root, 'builtin.json', pack('1.0.0', { adapters: [adapter('codex')] })),
      ),
    ).toThrow(/built into Charter/);
    expect(() =>
      new AgentPackService(join(root, 'signed-store'), logger()).install(
        writePack(
          root,
          'signed.json',
          pack('1.0.0', {
            signature: { algorithm: 'ed25519', keyId: 'unknown', value: 'AAAA' },
          }),
        ),
      ),
    ).toThrow(/not trusted/);
  });

  it('verifies a trusted Ed25519 publisher signature over normalized Pack bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-agent-pack-'));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const unsigned = pack('1.0.0');
    const signature = sign(null, agentPackSignaturePayload(unsigned), privateKey).toString(
      'base64',
    );
    const packs = new AgentPackService(join(root, 'store'), logger(), {
      trustedPublisherKeys: {
        test: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    });
    expect(
      packs.install(
        writePack(root, 'signed.json', {
          ...unsigned,
          signature: { algorithm: 'ed25519', keyId: 'test', value: signature },
        }),
      ).trust,
    ).toBe('verified');
  });
});
