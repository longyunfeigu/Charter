import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Logger } from '@pi-ide/foundation';

export interface TerminalControlIntegration {
  binDir: string;
  mcpServerPath: string;
  nodeExecutable: string;
  environment(basePath?: string): Record<string, string>;
  /** Real user-installed CLI used when orchestration is disabled or unsupported. */
  executableFor(launch: string): string | null;
  /** Host-context launcher used by orchestration-enabled product Sessions. */
  mcpExecutableFor(launch: string): string | null;
}

/** A Finder/dev-launched Electron process inherits a minimal PATH that misses
 * the places CLI installers actually use (field failure: claude migrated from
 * an nvm global to the native installer's ~/.local/bin and disappeared from
 * every launch's resolution). These well-known directories are searched after
 * the process PATH. */
export function defaultCliFallbackDirs(home = homedir()): string[] {
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

function executable(
  name: string,
  pathValue: string,
  fallbackDirs: readonly string[],
): string | null {
  const seen = new Set<string>();
  for (const directory of [...pathValue.split(delimiter), ...fallbackDirs].filter(Boolean)) {
    if (seen.has(directory)) continue;
    seen.add(directory);
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

/** Native Agent sessions must use the user's installed client. Package-manager
 * launchers prepend every project `node_modules/.bin` directory to PATH; this
 * repository also carries Codex transitively for the optional ACP adapter.
 * Treating that dependency as the desktop user's CLI causes version skew,
 * upgrade prompts, and behavior that differs from `which claude/codex` in the
 * user's terminal. Node itself may still come from the full process PATH. */
function nativeAgentPath(pathValue: string): string {
  return pathValue
    .split(delimiter)
    .filter((directory) => !/(^|[/\\])node_modules[/\\]\.bin[/\\]?$/.test(directory))
    .join(delimiter);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o700 });
  chmodSync(path, 0o700);
}

/**
 * Product launches originate inside a real PTY, but the MCP bridge needs a
 * wrapper to append trusted arguments. Re-enter the user's interactive shell
 * so its alias/function for the Agent remains authoritative (proxy, nvm,
 * custom CA, etc.), while passing every product argument positionally. Unknown
 * shells retain the previously resolved absolute executable as a safe fallback.
 */
function aliasAwareWrapper(
  command: string,
  fallbackExecutable: string,
  fixedArgs: readonly string[],
): string {
  // Startup files are allowed to rebuild PATH (nvm, Homebrew, corporate
  // shims), but Charter has already resolved the native executable selected
  // for this launch. Put that executable's directory back at the front after
  // rc files load: a proxy/CA alias that recursively invokes bare `codex` or
  // `claude` keeps working without silently switching to another installation.
  // This also preserves explicit PATH overrides used by automation and users.
  const fallbackDir = dirname(fallbackExecutable);
  const posixCommand = [
    `PATH=${shellQuote(fallbackDir)}:"$PATH"`,
    'export PATH',
    [command, ...fixedArgs.map(shellQuote), '"$@"'].join(' '),
  ].join('; ');
  const fishCommand = [
    `set -gx PATH ${shellQuote(fallbackDir)} $PATH`,
    [command, ...fixedArgs.map(shellQuote), '$argv'].join(' '),
  ].join('; ');
  const fallbackCommand = [fallbackExecutable, ...fixedArgs].map(shellQuote).join(' ');
  return [
    '#!/bin/sh',
    'agent_shell="${SHELL:-}"',
    'if [ -x "$agent_shell" ]; then',
    '  case "$agent_shell" in',
    '    */zsh)',
    '      # Shell-integration keeps the real user ZDOTDIR separately. Restore',
    '      # it before starting a login shell; /var/empty is an Agent-host',
    "      # suppression sentinel and must not hide the user's own .zshrc.",
    '      if [ -n "${CHARTER_USER_ZDOTDIR:-}" ]; then',
    '        case "$CHARTER_USER_ZDOTDIR" in',
    '          /var/empty|/var/empty/|/private/var/empty|/private/var/empty/) unset ZDOTDIR ;;',
    '          *) ZDOTDIR="$CHARTER_USER_ZDOTDIR"; export ZDOTDIR ;;',
    '        esac',
    '        unset CHARTER_USER_ZDOTDIR',
    '      else',
    '        case "${ZDOTDIR:-}" in',
    '          /var/empty|/var/empty/|/private/var/empty|/private/var/empty/) unset ZDOTDIR ;;',
    '        esac',
    '      fi',
    `      exec "$agent_shell" -lic ${shellQuote(posixCommand)} ${shellQuote(`charter-${command}-mcp`)} "$@" ;;`,
    `    */bash) exec "$agent_shell" -ic ${shellQuote(posixCommand)} ${shellQuote(`charter-${command}-mcp`)} "$@" ;;`,
    `    */fish) exec "$agent_shell" -ic ${shellQuote(fishCommand)} -- "$@" ;;`,
    '  esac',
    'fi',
    `exec ${fallbackCommand} "$@"`,
    '',
  ].join('\n');
}

/** Install the lightweight `charter` CLI plus explicit MCP launchers. The
 * ordinary claude/codex names are never shadowed: Charter chooses a wrapper
 * only for orchestration-enabled product Sessions, while hand-launched shells
 * continue to use the user's real executable and optional Skill + CLI door. */
export function installTerminalControlIntegration(input: {
  userData: string;
  appPath: string;
  pathValue?: string;
  /** Extra directories searched after PATH; tests override. */
  fallbackDirs?: string[];
  logger: Logger;
}): TerminalControlIntegration | null {
  if (process.platform === 'win32') return null;
  const pathValue = input.pathValue ?? process.env.PATH ?? '';
  const fallbackDirs = input.fallbackDirs ?? defaultCliFallbackDirs();
  const node = executable('node', pathValue, fallbackDirs);
  if (!node) {
    input.logger.warn('terminal MCP bridge unavailable: node was not found on PATH');
    return null;
  }
  const root = join(input.userData, 'terminal-control');
  const binDir = join(root, 'bin');
  const runtimeAppPath = input.appPath.endsWith('app.asar')
    ? `${input.appPath}.unpacked`
    : input.appPath;
  const mcpServerPath = join(runtimeAppPath, 'apps/desktop-main/dist/terminal-control-mcp.cjs');
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
  writeExecutable(
    join(binDir, 'charter'),
    `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(mcpServerPath)} --cli "$@"\n`,
  );

  const agentPathValue = nativeAgentPath(pathValue);
  const claude = executable('claude', agentPathValue, fallbackDirs);
  if (claude) {
    writeExecutable(
      join(binDir, 'charter-claude-mcp'),
      aliasAwareWrapper('claude', claude, [`--mcp-config=${claudeConfigPath}`]),
    );
  } else {
    rmSync(join(binDir, 'charter-claude-mcp'), { force: true });
  }

  const codex = executable('codex', agentPathValue, fallbackDirs);
  if (codex) {
    const commandConfig = `mcp_servers.charter.command=${JSON.stringify(node)}`;
    const argsConfig = `mcp_servers.charter.args=${JSON.stringify([mcpServerPath])}`;
    // Codex starts stdio MCP servers with a filtered environment. Explicitly
    // forward the per-terminal Charter identity so the bridge can authenticate
    // tool calls as the visible Lead/worker that launched it.
    const envVarsConfig = 'mcp_servers.charter.env_vars=["CHARTER_CTL","CHARTER_CTL_TOKEN"]';
    // Agent coordination intentionally supports long blocking waits. Keep the
    // Codex-side MCP deadline above Charter's one-hour maximum instead of
    // letting the client's shorter default terminate a healthy wait/join.
    const startupTimeoutConfig = 'mcp_servers.charter.startup_timeout_sec=120';
    const toolTimeoutConfig = 'mcp_servers.charter.tool_timeout_sec=3605';
    writeExecutable(
      join(binDir, 'charter-codex-mcp'),
      aliasAwareWrapper('codex', codex, [
        '-c',
        commandConfig,
        '-c',
        argsConfig,
        '-c',
        envVarsConfig,
        '-c',
        startupTimeoutConfig,
        '-c',
        toolTimeoutConfig,
      ]),
    );
  } else {
    rmSync(join(binDir, 'charter-codex-mcp'), { force: true });
  }

  // Releases before the native data-plane switch wrote these two shadowing
  // names. Remove them on upgrade so PATH cannot silently retain old behavior.
  rmSync(join(binDir, 'claude'), { force: true });
  rmSync(join(binDir, 'codex'), { force: true });

  input.logger.info('terminal MCP bridge installed', {
    claude: Boolean(claude),
    codex: Boolean(codex),
  });
  return {
    binDir,
    mcpServerPath,
    nodeExecutable: node,
    executableFor(launch) {
      return launch === 'claude' ? claude : launch === 'codex' ? codex : null;
    },
    mcpExecutableFor(launch) {
      const path = join(binDir, `charter-${launch}-mcp`);
      return existsSync(path) ? path : null;
    },
    environment(basePath = pathValue) {
      return {
        PATH: `${binDir}${delimiter}${basePath}`,
        CHARTER_TERMINAL_BIN: binDir,
        // Agent login shells may rebuild PATH from scratch. Keep the command
        // doors absolute so Skills and nested Mission calls cannot lose the
        // product-owned bridge after .zshrc/.bashrc runs.
        CHARTER_TERMINAL_COMMAND: join(binDir, 'charter-terminal'),
        CHARTER_COMMAND: join(binDir, 'charter'),
      };
    },
  };
}
