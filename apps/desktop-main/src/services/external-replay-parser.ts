import { redactObject, redactText } from '@pi-ide/foundation';

export interface ExternalReplayObservation {
  key?: string;
  parentKey?: string;
  kind:
    | 'message'
    | 'plan'
    | 'read'
    | 'search'
    | 'command'
    | 'write'
    | 'permission'
    | 'verification'
    | 'report'
    | 'state'
    | 'system';
  label: string;
  detail?: string;
  status?: 'running' | 'pending' | 'ok' | 'error' | 'denied' | 'warn' | 'info';
  callId?: string;
  toolName?: string;
  paths?: string[];
  app?: string;
  resource?: string;
  evidenceKinds: Array<
    | 'message'
    | 'plan'
    | 'tool'
    | 'result'
    | 'file'
    | 'permission'
    | 'verification'
    | 'terminal'
    | 'application'
  >;
}

export interface ExternalReplayParseResult {
  structured: boolean;
  observations: ExternalReplayObservation[];
  /** Safe documentary text. Structured envelopes are summarized, never stored raw. */
  terminalText: string;
}

const ANSI_RE =
  // CSI, OSC and the short two-byte escape families emitted by interactive TUIs.
  /[\u001B\u009B](?:\][^\u0007]*(?:\u0007|\u001B\\)|[()[\]#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])))/g;

export function cleanTerminalText(value: string): string {
  return redactText(
    value
      .replace(ANSI_RE, '')
      .replace(/\r(?!\n)/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, '')
      .replace(/\n{4,}/g, '\n\n\n'),
  );
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clipped(value: unknown, max = 4000): string {
  const source = typeof value === 'string' ? value : JSON.stringify(redactObject(value));
  return source.length <= max ? source : `${source.slice(0, max - 1)}…`;
}

/** Plan-shaped provider tools (exact names): the pivot signal source (V3.1). */
const PLAN_TOOLS = /^(todowrite|exitplanmode|update_plan|todo_list)$/;

function commandKind(name: string): ExternalReplayObservation['kind'] {
  const lower = name.toLowerCase();
  if (PLAN_TOOLS.test(lower)) return 'plan';
  if (/patch|write|create|delete|rename|edit/.test(lower)) return 'write';
  if (/search|grep|find|web/.test(lower)) return 'search';
  if (/test|verify|lint|check/.test(lower)) return 'verification';
  if (/bash|shell|command|exec|terminal/.test(lower)) return 'command';
  return 'read';
}

function firstPath(input: Record<string, unknown>): string[] {
  const values = [input.path, input.file, input.file_path, input.from, input.to];
  return values.filter((value): value is string => typeof value === 'string');
}

/**
 * Incremental best-effort parser for the providers' documented JSON streams.
 * It deliberately discards raw thinking/reasoning blocks: replay is evidence
 * of observable actions, never a chain-of-thought viewer.
 */
export class ExternalStructuredReplayParser {
  private buffer = '';
  private readonly calls = new Map<string, string>();
  /** CLI-native conversation id when the structured stream reveals it. */
  sessionId: string | null = null;

  feed(cli: string, chunk: string): ExternalReplayParseResult {
    this.buffer += cleanTerminalText(chunk);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const observations: ExternalReplayObservation[] = [];
    const terminalLines: string[] = [];
    let structured = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (!line.startsWith('{') || !line.endsWith('}')) {
        terminalLines.push(raw);
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = object(JSON.parse(line));
      } catch {
        terminalLines.push(raw);
        continue;
      }
      const next =
        cli === 'claude' ? this.claude(parsed) : cli === 'codex' ? this.codex(parsed) : [];
      if (next !== null || this.isProviderEnvelope(cli, parsed)) {
        structured = true;
        const safe = next ?? [];
        observations.push(...safe);
        for (const observation of safe) {
          terminalLines.push(
            observation.detail ? `${observation.label}\n${observation.detail}` : observation.label,
          );
        }
      } else {
        terminalLines.push(raw);
      }
    }
    return {
      structured,
      observations,
      terminalText: terminalLines.length ? `${terminalLines.join('\n')}\n` : '',
    };
  }

  private isProviderEnvelope(cli: string, event: Record<string, unknown>): boolean {
    const type = text(event.type);
    if (cli === 'claude') {
      return type === 'system' || type === 'assistant' || type === 'user' || type === 'result';
    }
    if (cli === 'codex') {
      return (
        type.startsWith('thread.') ||
        type.startsWith('turn.') ||
        type.startsWith('item.') ||
        /plan.*updated|requestApproval/.test(text(event.method))
      );
    }
    return false;
  }

  private claude(event: Record<string, unknown>): ExternalReplayObservation[] | null {
    const type = text(event.type);
    if (!type) return null;
    // init/result events carry the conversation id — retained for exact resume.
    const sessionId = text(event.session_id);
    if (sessionId) this.sessionId = sessionId;
    if (type === 'system' && text(event.subtype) === 'init') {
      return [
        {
          kind: 'state',
          label: 'Claude structured capture connected',
          detail: text(event.session_id) ? `Session ${text(event.session_id)}` : undefined,
          status: 'ok',
          evidenceKinds: ['tool'],
        },
      ];
    }
    if (type === 'assistant' || type === 'user') {
      const message = object(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      const out: ExternalReplayObservation[] = [];
      for (const blockValue of content) {
        const block = object(blockValue);
        const blockType = text(block.type);
        if (blockType === 'thinking' || blockType === 'redacted_thinking') continue;
        if (blockType === 'text' && type === 'assistant') {
          const body = text(block.text).trim();
          if (body) {
            out.push({
              kind: 'message',
              label: body.replace(/\s+/g, ' ').slice(0, 180),
              detail: clipped(body),
              status: 'ok',
              evidenceKinds: ['message'],
            });
          }
        } else if (blockType === 'tool_use') {
          const id = text(block.id);
          const name = text(block.name) || 'tool';
          if (id) this.calls.set(id, name);
          const input = object(block.input);
          const kind = commandKind(name);
          out.push({
            key: id || undefined,
            callId: id || undefined,
            kind,
            label: kind === 'plan' ? `Claude updated its plan (${name})` : `Claude called ${name}`,
            detail: clipped(input),
            status: 'running',
            toolName: name,
            paths: firstPath(input),
            evidenceKinds: kind === 'plan' ? ['plan'] : ['tool'],
          });
        } else if (blockType === 'tool_result') {
          const callId = text(block.tool_use_id);
          const name = this.calls.get(callId) ?? 'tool';
          const failed = block.is_error === true;
          const kind = commandKind(name);
          out.push({
            key: callId || undefined,
            callId: callId || undefined,
            kind,
            label:
              kind === 'plan'
                ? `Claude plan update ${failed ? 'failed' : 'recorded'}`
                : `${name} ${failed ? 'failed' : 'completed'}`,
            detail: clipped(block.content),
            status: failed ? 'error' : 'ok',
            toolName: name,
            evidenceKinds: kind === 'plan' ? ['plan', 'result'] : ['tool', 'result'],
          });
        }
      }
      return out;
    }
    if (type === 'result') {
      return [
        {
          kind: 'report',
          label: event.is_error === true ? 'Claude run failed' : 'Claude run completed',
          detail: clipped(event.result ?? event.error ?? ''),
          status: event.is_error === true ? 'error' : 'ok',
          evidenceKinds: ['result'],
        },
      ];
    }
    if (type.startsWith('hook_')) return [];
    return null;
  }

  private codex(event: Record<string, unknown>): ExternalReplayObservation[] | null {
    const type = text(event.type);
    const method = text(event.method);
    if (!type && !method) return null;
    if (type === 'thread.started') {
      return [
        {
          kind: 'state',
          label: 'Codex structured capture connected',
          detail: text(event.thread_id) ? `Thread ${text(event.thread_id)}` : undefined,
          status: 'ok',
          evidenceKinds: ['tool'],
        },
      ];
    }
    if (type === 'turn.started') {
      return [
        {
          kind: 'state',
          label: 'Codex turn started',
          status: 'running',
          evidenceKinds: ['message'],
        },
      ];
    }
    if (type === 'turn.completed') {
      return [
        {
          kind: 'report',
          label: 'Codex turn completed',
          detail: event.usage ? clipped(event.usage) : undefined,
          status: 'ok',
          evidenceKinds: ['result'],
        },
      ];
    }
    if (type === 'item.started' || type === 'item.completed') {
      const item = object(event.item);
      const itemType = text(item.type);
      const id = text(item.id);
      const complete = type === 'item.completed';
      if (itemType === 'reasoning') return [];
      if (itemType === 'agent_message') {
        const body = text(item.text).trim();
        return body
          ? [
              {
                key: id || undefined,
                kind: 'message',
                label: body.replace(/\s+/g, ' ').slice(0, 180),
                detail: clipped(body),
                status: complete ? 'ok' : 'running',
                evidenceKinds: ['message'],
              },
            ]
          : [];
      }
      if (itemType === 'command_execution') {
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
        const command = text(item.command) || 'command';
        return [
          {
            key: id || undefined,
            callId: id || undefined,
            kind: 'command',
            label: complete
              ? `${exitCode === 0 || exitCode === null ? 'Ran' : 'Failed'} ${command}`
              : `Running ${command}`,
            detail: complete ? clipped(item.aggregated_output ?? '') : undefined,
            status: complete ? (exitCode === 0 || exitCode === null ? 'ok' : 'error') : 'running',
            toolName: 'command_execution',
            evidenceKinds: complete ? ['tool', 'result'] : ['tool'],
          },
        ];
      }
      if (itemType === 'file_change') {
        const changes = Array.isArray(item.changes) ? item.changes.map(object) : [];
        const paths = changes.flatMap((change) => firstPath(change));
        return [
          {
            key: id || undefined,
            callId: id || undefined,
            kind: 'write',
            label: complete ? 'Codex applied file changes' : 'Codex is preparing file changes',
            detail: clipped(changes),
            status: complete ? 'ok' : 'running',
            toolName: 'file_change',
            paths,
            evidenceKinds: ['tool', 'file'],
          },
        ];
      }
      if (itemType === 'todo_list') {
        // Codex's observable plan (exec --json). Same id across
        // started/completed — one proposal, and the pivot signal source.
        return [
          {
            key: id || undefined,
            kind: 'plan',
            label: complete ? 'Codex updated its plan' : 'Codex is updating its plan',
            detail: clipped(item.items ?? item),
            status: complete ? 'ok' : 'running',
            evidenceKinds: ['plan'],
          },
        ];
      }
      if (itemType === 'web_search') {
        return [
          {
            key: id || undefined,
            kind: 'search',
            label: complete ? 'Codex completed web search' : 'Codex is searching the web',
            detail: clipped(item.query ?? item),
            status: complete ? 'ok' : 'running',
            app: 'Web',
            evidenceKinds: ['tool', 'application'],
          },
        ];
      }
      if (itemType === 'mcp_tool_call') {
        return [
          {
            key: id || undefined,
            kind: 'command',
            label: complete ? 'Codex MCP action completed' : 'Codex called an MCP tool',
            detail: clipped(item),
            status: complete ? 'ok' : 'running',
            app: text(item.server) || 'MCP',
            resource: text(item.tool),
            evidenceKinds: ['tool', 'application'],
          },
        ];
      }
      return [];
    }
    if (method.includes('plan') && method.includes('updated')) {
      return [
        {
          kind: 'plan',
          label: 'Codex updated its observable plan',
          detail: clipped(object(event.params)),
          status: 'info',
          evidenceKinds: ['plan'],
        },
      ];
    }
    if (method.includes('requestApproval')) {
      return [
        {
          kind: 'permission',
          label: method.includes('fileChange')
            ? 'Codex requested approval for file changes'
            : 'Codex requested command approval',
          detail: clipped(object(event.params)),
          status: 'pending',
          evidenceKinds: ['permission', 'tool'],
        },
      ];
    }
    return null;
  }
}
