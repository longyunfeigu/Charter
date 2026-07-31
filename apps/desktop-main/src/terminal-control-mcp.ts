import { request as httpRequest } from 'node:http';
import {
  parseTerminalControlCli,
  TERMINAL_CONTROL_CLI_USAGE,
} from './services/terminal-control-cli.js';
import { ORCHESTRATION_MCP_TOOLS } from '../../../packages/tool-gateway/src/orchestration-command-registry.js';

type JsonObject = Record<string, unknown>;

const socketPath = process.env.CHARTER_CTL ?? '';
const token = process.env.CHARTER_CTL_TOKEN ?? '';

const tools = [
  {
    name: 'terminal_list',
    description:
      'Charter terminal.list: list visible sibling terminals with their current user-editable Session names, stable ids, host-managed context cwd (updated by product context switching, not by shell cd), and orchestration state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'terminal_create',
    description:
      'Charter terminal.create: create a visible shell, Claude Code, or Codex worker terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        launch: { type: 'string', enum: ['shell', 'claude', 'codex'], default: 'shell' },
        initialText: { type: 'string', minLength: 1, maxLength: 20000 },
        submit: { type: 'boolean', default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'terminal_send',
    description:
      'Charter terminal.send: inject text and optional Enter into a visible sibling terminal selected by stable id or unique current Session name.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        text: { type: 'string', minLength: 1 },
        submit: { type: 'boolean', default: true },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'terminal_wait',
    description:
      'Charter terminal.wait: event-driven wait by stable id or unique current Session name for an agent turn, command exit, quiet, or a post-wait output regex.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        mode: {
          type: 'string',
          enum: ['command', 'quiet', 'until', 'turn'],
          default: 'command',
        },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 240000, default: 60000 },
        quietMs: { type: 'integer', minimum: 250, maximum: 30000, default: 1000 },
        pattern: { type: 'string', minLength: 1, maxLength: 500 },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'terminal_read',
    description:
      'Charter terminal.read: read the ANSI-free in-memory tail of a visible sibling terminal selected by stable id or unique current Session name.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        maxBytes: { type: 'integer', minimum: 1, maximum: 204800, default: 32768 },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'terminal_kill',
    description:
      'Charter terminal.kill: close a sibling worker selected by stable id or unique current Session name only when the user explicitly requests it; completed workers normally remain open for follow-up.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  ...ORCHESTRATION_MCP_TOOLS,
] as const;

function ctlRoute(
  name: string,
  input: JsonObject,
): { method: string; path: string; body?: JsonObject } {
  const id = typeof input.id === 'string' ? encodeURIComponent(input.id) : '';
  switch (name) {
    case 'terminal_list':
      return { method: 'GET', path: '/v1/terminals' };
    case 'terminal_create':
      return { method: 'POST', path: '/v1/terminals', body: input };
    case 'terminal_send':
      return { method: 'POST', path: `/v1/terminals/${id}/send`, body: withoutId(input) };
    case 'terminal_wait':
      return { method: 'POST', path: `/v1/terminals/${id}/wait`, body: withoutId(input) };
    case 'terminal_read': {
      const maxBytes = typeof input.maxBytes === 'number' ? input.maxBytes : 32768;
      return {
        method: 'GET',
        path: `/v1/terminals/${id}/read?maxBytes=${encodeURIComponent(String(maxBytes))}`,
      };
    }
    case 'terminal_kill':
      return { method: 'DELETE', path: `/v1/terminals/${id}/kill` };
    default:
      if (name.startsWith('orchestration_')) {
        const action = name.slice('orchestration_'.length);
        return {
          method: action === 'inspect' ? 'GET' : 'POST',
          path: `/v1/orchestration/${encodeURIComponent(action)}`,
          ...(action === 'inspect' ? {} : { body: input }),
        };
      }
      throw new Error(`Unknown Charter tool: ${name}`);
  }
}

function withoutId(input: JsonObject): JsonObject {
  const { id: _id, ...body } = input;
  return body;
}

async function callDoor(name: string, input: JsonObject): Promise<JsonObject> {
  if (!socketPath || !token) {
    return {
      ok: false,
      code: 'CTL_IDENTITY_MISSING',
      summary: 'This process is not running inside an orchestration-enabled Charter terminal.',
    };
  }
  const route = ctlRoute(name, input);
  const payload = route.body === undefined ? null : JSON.stringify(route.body);
  return await new Promise<JsonObject>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: JsonObject): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const request = httpRequest(
      {
        socketPath,
        path: route.path,
        method: route.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          try {
            finish(JSON.parse(text) as JsonObject);
          } catch {
            finish({
              ok: false,
              code: 'CTL_INVALID_RESPONSE',
              summary: `Charter returned HTTP ${response.statusCode ?? 0} without JSON.`,
            });
          }
        });
      },
    );
    request.on('error', (error) => {
      finish({ ok: false, code: 'CTL_UNAVAILABLE', summary: error.message });
    });
    const requestedWait =
      (name === 'terminal_wait' ||
        name === 'orchestration_wait' ||
        name === 'orchestration_ask' ||
        name === 'orchestration_join') &&
      typeof input.timeoutMs === 'number'
        ? input.timeoutMs
        : 0;
    const timeoutMs = requestedWait > 0 ? requestedWait + 5_000 : 30_000;
    timer = setTimeout(() => {
      request.destroy();
      finish({
        ok: false,
        code: 'CTL_TIMEOUT',
        summary: `Charter terminal control did not respond within ${timeoutMs}ms.`,
      });
    }, timeoutMs);
    timer.unref?.();
    if (payload) request.write(payload);
    request.end();
  });
}

function writeMessage(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id: unknown, result: unknown): void {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function errorResponse(id: unknown, code: number, message: string): void {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(message: JsonObject): Promise<void> {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  if (method === 'initialize') {
    const requested = (message.params as JsonObject | undefined)?.protocolVersion;
    const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const protocolVersion =
      typeof requested === 'string' && supported.includes(requested) ? requested : '2025-06-18';
    response(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'charter-terminal', version: '1.0.0' },
    });
    return;
  }
  if (method === 'ping') {
    response(id, {});
    return;
  }
  if (method === 'tools/list') {
    response(id, { tools });
    return;
  }
  if (method === 'tools/call') {
    const params = (message.params ?? {}) as JsonObject;
    const name = typeof params.name === 'string' ? params.name : '';
    if (!tools.some((tool) => tool.name === name)) {
      errorResponse(id, -32602, `Unknown terminal tool: ${name}`);
      return;
    }
    const input =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as JsonObject)
        : {};
    const result = await callDoor(name, input);
    response(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: result.ok !== true,
    });
    return;
  }
  if (id !== undefined) errorResponse(id, -32601, `Method not found: ${method}`);
}

async function runCli(args: string[]): Promise<void> {
  const invocation = parseTerminalControlCli(args);
  if (invocation.kind === 'help') {
    process.stdout.write(`${TERMINAL_CONTROL_CLI_USAGE}\n`);
    return;
  }
  if (invocation.kind === 'error') {
    process.stderr.write(`${invocation.message}\n${TERMINAL_CONTROL_CLI_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const result = await callDoor(invocation.name, invocation.input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok !== true) process.exitCode = 1;
}

if (process.argv[2] === '--cli') {
  void runCli(process.argv.slice(3));
} else {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as JsonObject;
        void handleMessage(message).catch((error) => {
          if (message.id !== undefined) errorResponse(message.id, -32603, `${error}`);
        });
      } catch {
        errorResponse(null, -32700, 'Parse error');
      }
    }
  });
}
