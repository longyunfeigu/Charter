export type ExternalCli = 'claude' | 'codex';
export type ExternalAgentLifecycle = 'active' | 'ended' | 'interrupted';

/** A historical terminal capability reply has leaked into zle when all three
 * independent signatures are present. This is deliberately much narrower
 * than a generic ANSI/text filter: ordinary output mentioning xterm remains
 * untouched. */
export function isLeakedTerminalReply(text: string): boolean {
  return (
    /[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}/i.test(text) &&
    /\?1;2c/.test(text) &&
    /xterm\.js\([^)]+\)/i.test(text)
  );
}

const SHELL_TITLES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ash',
  'csh',
  'tcsh',
  'ksh',
  'nu',
  'xonsh',
  'pwsh',
  'powershell',
  'cmd',
  'cmd.exe',
]);

export function isExternalCli(value: string | null | undefined): value is ExternalCli {
  return value === 'claude' || value === 'codex';
}

export function externalCliLabel(cli: ExternalCli): string {
  return cli === 'claude' ? 'Claude Code' : 'Codex';
}

function commandName(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/');
  return (normalized.slice(normalized.lastIndexOf('/') + 1) || 'shell').replace(/^-/, '');
}

export function externalSessionTitle(
  cli: ExternalCli,
  terminalTitle: string,
  taskTitle?: string | null,
): string {
  const label = externalCliLabel(cli);
  const normalizedTask = taskTitle?.trim();
  if (normalizedTask && normalizedTask.toLowerCase() !== `${cli} · external session`) {
    return normalizedTask;
  }

  const normalizedTerminal = terminalTitle.trim();
  const terminalCommand = commandName(normalizedTerminal).toLowerCase();
  if (
    !normalizedTerminal ||
    SHELL_TITLES.has(terminalCommand) ||
    terminalCommand === cli ||
    normalizedTerminal.toLowerCase() === label.toLowerCase()
  ) {
    return `${label} session`;
  }
  return normalizedTerminal;
}

export interface ExternalTerminalLifecycle {
  cli: ExternalCli;
  providerLabel: string;
  agent: ExternalAgentLifecycle;
  terminal: 'live' | 'ended';
  agentLabel: 'Agent running' | 'Agent ended' | 'Agent interrupted';
  terminalLabel: 'Terminal live' | 'Shell available' | 'Terminal preserved' | 'Terminal ended';
  /** Whether this surface may truthfully present a prompt and accept stdin. */
  interactive: boolean;
  summary: string;
  terminalHeadline: string;
  terminalDetail: string;
}

export function externalTerminalLifecycle(input: {
  cli: ExternalCli;
  agent: ExternalAgentLifecycle;
  terminalExited: boolean;
  shellTitle?: string | null;
}): ExternalTerminalLifecycle {
  const providerLabel = externalCliLabel(input.cli);
  const terminal = input.terminalExited ? 'ended' : 'live';
  // A dead PTY cannot still contain a running Agent even if an older task
  // projection has not received its final state event yet.
  const agent = input.terminalExited && input.agent === 'active' ? 'ended' : input.agent;
  const agentLabel =
    agent === 'active'
      ? 'Agent running'
      : agent === 'interrupted'
        ? 'Agent interrupted'
        : 'Agent ended';
  const terminalLabel =
    terminal === 'ended'
      ? 'Terminal ended'
      : agent === 'active'
        ? 'Terminal live'
        : agent === 'interrupted'
          ? 'Terminal preserved'
          : 'Shell available';
  const agentSummary =
    agent === 'active'
      ? `${providerLabel} running`
      : agent === 'interrupted'
        ? `${providerLabel} interrupted`
        : `${providerLabel} ended`;
  const shellName = commandName(input.shellTitle ?? 'shell');

  return {
    cli: input.cli,
    providerLabel,
    agent,
    terminal,
    agentLabel,
    terminalLabel,
    interactive: terminal === 'live' && agent !== 'interrupted',
    summary: `${agentSummary} · ${terminalLabel}`,
    terminalHeadline:
      agent === 'active'
        ? `${providerLabel} PTY`
        : agent === 'interrupted'
          ? `Stopped ${providerLabel} transcript`
          : terminal === 'live'
            ? `Shell after ${providerLabel}`
            : `Terminal after ${providerLabel}`,
    terminalDetail:
      agent === 'active'
        ? 'external · unmanaged · state preserved'
        : agent === 'interrupted'
          ? 'read-only · resume the Session to continue'
          : terminal === 'live'
            ? `${shellName} ready · process preserved`
            : `${shellName} exited · session retained`,
  };
}

export function externalAgentLifecycle(
  status: 'active' | 'ended',
  taskState?: string | null,
): ExternalAgentLifecycle {
  if (status === 'active') return 'active';
  return taskState === 'INTERRUPTED' ? 'interrupted' : 'ended';
}

export function defaultExternalTerminalTools(
  agent: ExternalAgentLifecycle,
  changedFiles: number,
): { open: boolean; tool: 'editor' | 'changes' } {
  const reviewReady = agent !== 'active' && changedFiles > 0;
  return { open: reviewReady, tool: reviewReady ? 'changes' : 'editor' };
}
