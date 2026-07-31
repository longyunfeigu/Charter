import { readFileSync } from 'node:fs';
import { ORCHESTRATION_COMMANDS } from '@pi-ide/tool-gateway';

export type TerminalControlCliInvocation =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'call'; name: string; input: Record<string, unknown> };

export const TERMINAL_CONTROL_CLI_USAGE =
  'Usage: charter <orchestration COMMAND> [--request-file FILE|--request-json JSON] [--json]\n       charter-terminal <list|create|send|wait|read|kill> [arguments]';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function jsonPayload(args: string[]): Record<string, unknown> | null {
  const inline = option(args, '--request-json');
  const file = option(args, '--request-file');
  if (!inline && !file) return {};
  try {
    const text = inline ?? readFileSync(file === '-' ? 0 : file!, 'utf8');
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function orchestrationInvocation(args: string[]): TerminalControlCliInvocation {
  const command = args[0];
  if (!command || command === 'help') return { kind: 'help' };
  if (!ORCHESTRATION_COMMANDS.includes(command as (typeof ORCHESTRATION_COMMANDS)[number])) {
    return { kind: 'error', message: `Unknown orchestration command: ${command}` };
  }
  const payload = jsonPayload(args);
  if (payload === null)
    return { kind: 'error', message: 'The orchestration JSON request is invalid.' };
  const input: Record<string, unknown> = { ...payload };
  const assignmentId = option(args, '--assignment');
  if (assignmentId) input.assignmentId = assignmentId;
  const to = option(args, '--to');
  if (to) input.toAssignmentId = to;
  const subject = option(args, '--subject');
  if (subject) input.subject = subject;
  const messageId = option(args, '--message');
  if (messageId) input.messageId = messageId;
  const reason = option(args, '--reason');
  if (reason) input.reason = reason;
  const text = option(args, '--text');
  if (text) input.text = text;
  const bodyFile = option(args, '--body-file');
  if (bodyFile) input.body = readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf8');
  const types = option(args, '--types');
  if (types)
    input.types = types
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const timeout = option(args, '--timeout-ms');
  if (timeout) input.timeoutMs = Number(timeout);
  const runtime = option(args, '--runtime');
  if (runtime) input.requestedRuntime = runtime;
  return { kind: 'call', name: `orchestration_${command}`, input };
}

export function parseTerminalControlCli(args: string[]): TerminalControlCliInvocation {
  if (args.length === 0 || args.some((arg) => arg === '--help' || arg === '-h')) {
    return { kind: 'help' };
  }
  const command = args[0]!;
  if (command === 'help') return { kind: 'help' };
  if (command === 'orchestration') return orchestrationInvocation(args.slice(1));
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
