import { readFileSync } from 'node:fs';
import {
  ORCHESTRATION_COMMAND_REGISTRY,
  ORCHESTRATION_COMMANDS,
  orchestrationCommand,
} from '@pi-ide/tool-gateway';
import { z } from 'zod';

export type TerminalControlCliInvocation =
  | { kind: 'help' }
  | { kind: 'orchestration-help'; command: string | null; json: boolean }
  | { kind: 'dry-run'; command: string; input: Record<string, unknown> }
  | { kind: 'error'; message: string }
  | { kind: 'call'; name: string; input: Record<string, unknown> };

export const TERMINAL_CONTROL_CLI_USAGE =
  'Usage: charter orchestration <COMMAND> [--request-file FILE|--request-json JSON] [--dry-run] [--json]\n       charter orchestration <COMMAND> --help [--json]\n       charter-terminal <list|create|send|wait|read|kill> [arguments]\n       charter-terminal agent <status|explain|result|read|wait|prompt> <SESSION> [arguments]';

export interface OrchestrationCliHelp {
  command: string | null;
  usage: string;
  commands?: Array<{ command: string; description: string }>;
  description?: string;
  inputSchema?: Record<string, unknown>;
  example?: Record<string, unknown>;
}

function schemaExample(schema: Record<string, unknown>, field = 'value'): unknown {
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.anyOf)) {
    const candidate = schema.anyOf.find(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object' && !Array.isArray(item),
    );
    if (candidate) return schemaExample(candidate, field);
  }
  if (schema.type === 'array') {
    const item =
      schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)
        ? schemaExample(schema.items as Record<string, unknown>, field)
        : 'value';
    return [item];
  }
  if (schema.type === 'object' || schema.properties) {
    const properties =
      schema.properties &&
      typeof schema.properties === 'object' &&
      !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return Object.fromEntries(
      Object.entries(properties)
        .filter(([name, value]) => required.has(name) || 'default' in value)
        .map(([name, value]) => [name, schemaExample(value, name)]),
    );
  }
  if (schema.type === 'boolean') return true;
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 1;
  if (/id$/i.test(field)) return `${field.replace(/Id$/i, '').toLowerCase()}_123`;
  if (/key$/i.test(field)) return `${field.replace(/Key$/i, '').toLowerCase()}-1`;
  if (field === 'goal') return 'Describe the bounded delegated outcome.';
  if (field === 'reason') return 'Explain why delegation is useful.';
  return `<${field}>`;
}

export function orchestrationCliHelp(command: string | null): OrchestrationCliHelp {
  if (!command) {
    return {
      command: null,
      usage: TERMINAL_CONTROL_CLI_USAGE,
      commands: ORCHESTRATION_COMMAND_REGISTRY.map((entry) => ({
        command: entry.command,
        description: entry.description,
      })),
    };
  }
  const entry = orchestrationCommand(command);
  if (!entry) {
    return { command, usage: TERMINAL_CONTROL_CLI_USAGE };
  }
  const inputSchema = z.toJSONSchema(entry.schema, { target: 'draft-7' }) as Record<
    string,
    unknown
  >;
  return {
    command,
    usage: `charter orchestration ${command} --request-json '<JSON>' --json`,
    description: entry.description,
    inputSchema,
    example: schemaExample(inputSchema) as Record<string, unknown>,
  };
}

export function validateOrchestrationCliInput(
  command: string,
  input: Record<string, unknown>,
):
  | { ok: true; command: string; normalizedInput: Record<string, unknown> }
  | { ok: false; command: string; issues: Array<{ path: string; message: string }> } {
  const entry = orchestrationCommand(command);
  if (!entry) {
    return {
      ok: false,
      command,
      issues: [{ path: '', message: 'Unknown orchestration command.' }],
    };
  }
  const parsed = entry.schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, command, normalizedInput: parsed.data as Record<string, unknown> };
  }
  return {
    ok: false,
    command,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

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
  const json = args.includes('--json');
  if (!command || command === 'help') {
    return { kind: 'orchestration-help', command: null, json };
  }
  if (args.includes('--help') || args.includes('-h')) {
    if (!ORCHESTRATION_COMMANDS.includes(command as (typeof ORCHESTRATION_COMMANDS)[number])) {
      return { kind: 'error', message: `Unknown orchestration command: ${command}` };
    }
    return { kind: 'orchestration-help', command, json };
  }
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
  const continuationId = option(args, '--continuation');
  if (continuationId) input.continuationId = continuationId;
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
  if (args.includes('--dry-run')) return { kind: 'dry-run', command, input };
  return { kind: 'call', name: `orchestration_${command}`, input };
}

export function parseTerminalControlCli(args: string[]): TerminalControlCliInvocation {
  if (args[0] === 'orchestration') return orchestrationInvocation(args.slice(1));
  if (args.length === 0 || args.some((arg) => arg === '--help' || arg === '-h')) {
    return { kind: 'help' };
  }
  const command = args[0]!;
  if (command === 'help') return { kind: 'help' };
  if (command === 'agent') {
    const action = args[1];
    if (!action || !['status', 'explain', 'result', 'read', 'wait', 'prompt'].includes(action)) {
      return { kind: 'error', message: `Unknown Agent command: ${action ?? ''}`.trim() };
    }
    const id = args[2];
    if (!id) return { kind: 'error', message: `agent ${action} requires a Session name or id.` };
    if (action === 'status' || action === 'explain') {
      return { kind: 'call', name: `agent_${action}`, input: { id } };
    }
    if (action === 'result') {
      return {
        kind: 'call',
        name: 'agent_result',
        input: {
          id,
          ...(option(args, '--max-bytes') ? { maxBytes: Number(option(args, '--max-bytes')) } : {}),
        },
      };
    }
    if (action === 'read') {
      return {
        kind: 'call',
        name: 'agent_read',
        input: {
          id,
          mode: option(args, '--mode') ?? 'screen',
          ...(option(args, '--lines') ? { lines: Number(option(args, '--lines')) } : {}),
          ...(option(args, '--max-bytes') ? { maxBytes: Number(option(args, '--max-bytes')) } : {}),
          unwrap: !args.includes('--no-unwrap'),
        },
      };
    }
    if (action === 'wait') {
      const until = option(args, '--until');
      return {
        kind: 'call',
        name: 'agent_wait',
        input: {
          id,
          ...(until
            ? {
                until: until
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(option(args, '--timeout-ms')
            ? { timeoutMs: Number(option(args, '--timeout-ms')) }
            : {}),
          ...(option(args, '--after-seq') ? { afterSeq: Number(option(args, '--after-seq')) } : {}),
          ...(option(args, '--identity-seq')
            ? { identitySeq: Number(option(args, '--identity-seq')) }
            : {}),
        },
      };
    }
    const text = args[3];
    if (!text) return { kind: 'error', message: 'agent prompt requires non-empty text.' };
    return {
      kind: 'call',
      name: 'agent_prompt',
      input: {
        id,
        text,
        ...(option(args, '--timeout-ms')
          ? { timeoutMs: Number(option(args, '--timeout-ms')) }
          : {}),
      },
    };
  }
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
