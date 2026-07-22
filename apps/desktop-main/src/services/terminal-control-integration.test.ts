import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it('writes private MCP config and non-recursive CLI wrappers', () => {
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
    expect(readFileSync(join(integration!.binDir, 'claude'), 'utf8')).toContain(
      join(sourceBin, 'claude'),
    );
    expect(readFileSync(join(integration!.binDir, 'codex'), 'utf8')).toContain(
      'mcp_servers.charter.command',
    );
    expect(readFileSync(join(integration!.binDir, 'charter-terminal'), 'utf8')).toContain('--cli');
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
        logger,
      }),
    ).toBeNull();
  });
});
