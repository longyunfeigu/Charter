import { accessSync, chmodSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Logger } from '@pi-ide/foundation';

export interface TerminalControlIntegration {
  binDir: string;
  mcpServerPath: string;
  environment(basePath?: string): Record<string, string>;
}

function executable(name: string, pathValue: string): string | null {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Install ephemeral wrappers in userData. They add the Charter MCP server to
 * CLI sessions without editing ~/.claude, ~/.codex or project files. */
export function installTerminalControlIntegration(input: {
  userData: string;
  appPath: string;
  pathValue?: string;
  logger: Logger;
}): TerminalControlIntegration | null {
  if (process.platform === 'win32') return null;
  const pathValue = input.pathValue ?? process.env.PATH ?? '';
  const node = executable('node', pathValue);
  if (!node) {
    input.logger.warn('terminal MCP bridge unavailable: node was not found on PATH');
    return null;
  }
  const root = join(input.userData, 'terminal-control');
  const binDir = join(root, 'bin');
  const mcpServerPath = join(input.appPath, 'apps/desktop-main/dist/terminal-control-mcp.cjs');
  const claudeConfigPath = join(root, 'claude-mcp.json');
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    claudeConfigPath,
    `${JSON.stringify(
      {
        mcpServers: {
          charter: { type: 'stdio', command: node, args: [mcpServerPath] },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  writeExecutable(
    join(binDir, 'charter-terminal'),
    `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(mcpServerPath)} --cli "$@"\n`,
  );

  const claude = executable('claude', pathValue);
  if (claude) {
    writeExecutable(
      join(binDir, 'claude'),
      `#!/bin/sh\nexec ${shellQuote(claude)} ${shellQuote(`--mcp-config=${claudeConfigPath}`)} "$@"\n`,
    );
  }

  const codex = executable('codex', pathValue);
  if (codex) {
    const commandConfig = `mcp_servers.charter.command=${JSON.stringify(node)}`;
    const argsConfig = `mcp_servers.charter.args=${JSON.stringify([mcpServerPath])}`;
    writeExecutable(
      join(binDir, 'codex'),
      `#!/bin/sh\nexec ${shellQuote(codex)} -c ${shellQuote(commandConfig)} -c ${shellQuote(argsConfig)} "$@"\n`,
    );
  }

  input.logger.info('terminal MCP bridge installed', {
    claude: Boolean(claude),
    codex: Boolean(codex),
  });
  return {
    binDir,
    mcpServerPath,
    environment(basePath = pathValue) {
      return {
        PATH: `${binDir}${delimiter}${basePath}`,
        CHARTER_TERMINAL_BIN: binDir,
        CHARTER_TERMINAL_COMMAND: 'charter-terminal',
      };
    },
  };
}
