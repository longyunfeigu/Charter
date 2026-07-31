import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '@pi-ide/foundation';
import { installTerminalControlIntegration } from './terminal-control-integration.js';

const roots: string[] = [];
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return logger;
  },
} as unknown as Logger;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(path: string): void {
  writeFileSync(path, '#!/bin/sh\n', { mode: 0o700 });
}

describe('terminal control external CLI integration', () => {
  it('launches native CLIs by default and keeps MCP wrappers explicit', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-terminal-integration-'));
    roots.push(root);
    const sourceBin = join(root, 'source-bin');
    mkdirSync(sourceBin);
    for (const name of ['node', 'claude', 'codex']) executable(join(sourceBin, name));

    const integration = installTerminalControlIntegration({
      userData: join(root, 'user data'),
      appPath: '/Applications/Charter Test.app/Contents/Resources/app.asar',
      pathValue: sourceBin,
      logger,
    });

    expect(integration).not.toBeNull();
    const env = integration!.environment('/usr/bin');
    expect(env.PATH?.split(delimiter)[0]).toBe(integration!.binDir);
    expect(env.CHARTER_TERMINAL_BIN).toBe(integration!.binDir);
    expect(env.CHARTER_TERMINAL_COMMAND).toBe('charter-terminal');
    expect(integration!.executableFor('claude')).toBe(join(sourceBin, 'claude'));
    expect(integration!.executableFor('codex')).toBe(join(sourceBin, 'codex'));
    expect(integration!.mcpExecutableFor('claude')).toBe(
      join(integration!.binDir, 'charter-claude-mcp'),
    );
    expect(integration!.mcpExecutableFor('codex')).toBe(
      join(integration!.binDir, 'charter-codex-mcp'),
    );
    expect(readFileSync(join(integration!.binDir, 'charter-claude-mcp'), 'utf8')).toContain(
      join(sourceBin, 'claude'),
    );
    const codexWrapper = readFileSync(join(integration!.binDir, 'charter-codex-mcp'), 'utf8');
    expect(codexWrapper).toContain('mcp_servers.charter.command');
    expect(codexWrapper).toContain(
      'mcp_servers.charter.env_vars=["CHARTER_CTL","CHARTER_CTL_TOKEN"]',
    );
    expect(codexWrapper).toContain('mcp_servers.charter.startup_timeout_sec=120');
    expect(codexWrapper).toContain('mcp_servers.charter.tool_timeout_sec=3605');
    expect(readFileSync(join(integration!.binDir, 'charter-terminal'), 'utf8')).toContain('--cli');
    expect(readFileSync(join(integration!.binDir, 'charter'), 'utf8')).toContain('--cli');
    expect(env.CHARTER_COMMAND).toBe('charter');
    expect(existsSync(join(integration!.binDir, 'claude'))).toBe(false);
    expect(existsSync(join(integration!.binDir, 'codex'))).toBe(false);
    const config = JSON.parse(
      readFileSync(join(root, 'user data', 'terminal-control', 'claude-mcp.json'), 'utf8'),
    ) as { mcpServers: { charter: { command: string; args: string[] } } };
    expect(config.mcpServers.charter.command).toBe(join(sourceBin, 'node'));
    expect(config.mcpServers.charter.args).toEqual([integration!.mcpServerPath]);
  });

  it('stays disabled when no Node runtime can host the stdio bridge', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-terminal-no-node-'));
    roots.push(root);
    expect(
      installTerminalControlIntegration({
        userData: root,
        appPath: root,
        pathValue: '',
        fallbackDirs: [],
        logger,
      }),
    ).toBeNull();
  });

  it('resolves CLIs from fallback directories when the process PATH misses them', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-terminal-fallback-'));
    roots.push(root);
    const sourceBin = join(root, 'source-bin');
    const localBin = join(root, 'local-bin');
    mkdirSync(sourceBin);
    mkdirSync(localBin);
    executable(join(sourceBin, 'node'));
    executable(join(localBin, 'claude'));

    const integration = installTerminalControlIntegration({
      userData: join(root, 'user data'),
      appPath: root,
      pathValue: sourceBin,
      fallbackDirs: [localBin],
      logger,
    });

    expect(integration!.executableFor('claude')).toBe(join(localBin, 'claude'));
    expect(readFileSync(join(integration!.binDir, 'charter-claude-mcp'), 'utf8')).toContain(
      join(localBin, 'claude'),
    );
  });

  it('ignores dependency-owned Agent shims and launches the user PATH clients', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-terminal-native-agent-'));
    roots.push(root);
    const dependencyBin = join(root, 'project', 'node_modules', '.bin');
    const runtimeBin = join(root, 'runtime-bin');
    const userBin = join(root, 'user-bin');
    mkdirSync(dependencyBin, { recursive: true });
    mkdirSync(runtimeBin);
    mkdirSync(userBin);
    executable(join(runtimeBin, 'node'));
    for (const name of ['claude', 'codex']) {
      executable(join(dependencyBin, name));
      executable(join(userBin, name));
    }

    const integration = installTerminalControlIntegration({
      userData: join(root, 'user data'),
      appPath: root,
      pathValue: [dependencyBin, runtimeBin, userBin].join(delimiter),
      fallbackDirs: [],
      logger,
    });

    expect(integration!.nodeExecutable).toBe(join(runtimeBin, 'node'));
    expect(integration!.executableFor('claude')).toBe(join(userBin, 'claude'));
    expect(integration!.executableFor('codex')).toBe(join(userBin, 'codex'));
  });

  it('removes a stale wrapper when its CLI disappears between launches', () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-terminal-stale-'));
    roots.push(root);
    const sourceBin = join(root, 'source-bin');
    mkdirSync(sourceBin);
    for (const name of ['node', 'claude', 'codex']) executable(join(sourceBin, name));
    const install = (): ReturnType<typeof installTerminalControlIntegration> =>
      installTerminalControlIntegration({
        userData: join(root, 'user data'),
        appPath: root,
        pathValue: sourceBin,
        fallbackDirs: [],
        logger,
      });

    const first = install();
    expect(existsSync(join(first!.binDir, 'charter-claude-mcp'))).toBe(true);

    // The user migrates claude to an installer the app cannot see.
    rmSync(join(sourceBin, 'claude'));
    const second = install();
    expect(existsSync(join(second!.binDir, 'charter-claude-mcp'))).toBe(false);
    expect(existsSync(join(second!.binDir, 'charter-codex-mcp'))).toBe(true);
  });
});
