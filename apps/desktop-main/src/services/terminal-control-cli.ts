export type TerminalControlCliInvocation =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'call'; name: string; input: Record<string, unknown> };

export const TERMINAL_CONTROL_CLI_USAGE =
  'Usage: charter-terminal <list|create|send|wait|read|kill> [arguments] (target: unique Session name or terminal id)';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseTerminalControlCli(args: string[]): TerminalControlCliInvocation {
  if (args.length === 0 || args.some((arg) => arg === '--help' || arg === '-h')) {
    return { kind: 'help' };
  }
  const command = args[0]!;
  if (command === 'help') return { kind: 'help' };
  if (command === 'list') return { kind: 'call', name: 'terminal_list', input: {} };
  if (command === 'create') {
    return {
      kind: 'call',
      name: 'terminal_create',
      input: {
        launch: option(args, '--launch') ?? 'shell',
        ...(option(args, '--initial-text') ? { initialText: option(args, '--initial-text') } : {}),
        submit: !args.includes('--no-submit'),
      },
    };
  }
  if (!['send', 'wait', 'read', 'kill'].includes(command)) {
    return { kind: 'error', message: `Unknown terminal command: ${command}` };
  }
  const id = args[1];
  if (!id) return { kind: 'error', message: `${command} requires a Session name or terminal id.` };
  if (command === 'send') {
    const text = args[2];
    if (!text) return { kind: 'error', message: 'send requires non-empty text.' };
    return {
      kind: 'call',
      name: 'terminal_send',
      input: { id, text, submit: !args.includes('--no-submit') },
    };
  }
  if (command === 'wait') {
    return {
      kind: 'call',
      name: 'terminal_wait',
      input: {
        id,
        mode: option(args, '--mode') ?? 'command',
        ...(option(args, '--timeout-ms')
          ? { timeoutMs: Number(option(args, '--timeout-ms')) }
          : {}),
        ...(option(args, '--quiet-ms') ? { quietMs: Number(option(args, '--quiet-ms')) } : {}),
        ...(option(args, '--pattern') ? { pattern: option(args, '--pattern') } : {}),
      },
    };
  }
  if (command === 'read') {
    return {
      kind: 'call',
      name: 'terminal_read',
      input: {
        id,
        ...(option(args, '--max-bytes') ? { maxBytes: Number(option(args, '--max-bytes')) } : {}),
      },
    };
  }
  if (command === 'kill') {
    return { kind: 'call', name: 'terminal_kill', input: { id } };
  }
  return { kind: 'error', message: `Unknown terminal command: ${command}` };
}
