import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '@pi-ide/foundation';
import type { ToolGateway } from '@pi-ide/tool-gateway';
import {
  TerminalControlIdentityRegistry,
  TerminalControlService,
} from './terminal-control-service.js';

const MAX_BODY_BYTES = 256 * 1024;

interface CtlServerOptions {
  socketPath: string;
  identities: TerminalControlIdentityRegistry;
  control: TerminalControlService;
  enabled: () => boolean;
  taskForTerminal: (terminalId: string) => string | null;
  gatewayForTask: (taskId: string) => ToolGateway | null;
  prepareCaller?: (taskId: string, terminalId: string) => void;
  logger: Logger;
}

function bearer(request: IncomingMessage): string | null {
  const direct = request.headers['x-charter-token'];
  if (typeof direct === 'string' && direct) return direct;
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;
}

function respond(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function route(
  request: IncomingMessage,
): { toolName: string; input: Record<string, unknown> } | null {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://charter.local');
  const parts = url.pathname.split('/').filter(Boolean);
  if (method === 'GET' && url.pathname === '/v1/terminals') {
    return { toolName: 'terminal.list', input: {} };
  }
  if (method === 'POST' && url.pathname === '/v1/terminals') {
    return { toolName: 'terminal.create', input: {} };
  }
  if (parts.length !== 4 || parts[0] !== 'v1' || parts[1] !== 'terminals') return null;
  const id = decodeURIComponent(parts[2] ?? '');
  const action = parts[3];
  if (method === 'GET' && action === 'read') {
    const maxBytes = Number(url.searchParams.get('maxBytes') ?? 32 * 1024);
    return { toolName: 'terminal.read', input: { id, maxBytes } };
  }
  if (method === 'POST' && action === 'send') {
    return { toolName: 'terminal.send', input: { id } };
  }
  if (method === 'POST' && action === 'wait') {
    return { toolName: 'terminal.wait', input: { id } };
  }
  if (method === 'DELETE' && action === 'kill') {
    return { toolName: 'terminal.kill', input: { id } };
  }
  return null;
}

function statusFor(code: string): number {
  if (code === 'TERMINAL_NOT_FOUND') return 404;
  if (code === 'TERMINAL_DEPTH_LIMIT' || code === 'TERMINAL_SELF_CONTROL') return 409;
  if (code === 'TERMINAL_WORKER_BUDGET' || code === 'TERMINAL_SEND_BUDGET') return 429;
  if (code === 'ORCHESTRATION_DISABLED' || code === 'TOOL_UNKNOWN') return 501;
  if (code === 'PERMISSION_DENIED') return 403;
  if (code === 'CANCELLED') return 499;
  return 400;
}

/** HTTP over a 0600 Unix socket. It only authenticates and translates; every
 * action still runs through the caller task's ToolGateway. */
export class CtlServer {
  private server: Server | null = null;

  constructor(private readonly options: CtlServerOptions) {}

  async start(): Promise<boolean> {
    if (!this.options.enabled() || process.platform === 'win32') return false;
    if (this.server) return true;
    if (existsSync(this.options.socketPath)) unlinkSync(this.options.socketPath);
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(this.options.socketPath, 0o600);
    this.options.logger.info('terminal control door listening', {
      socket: this.options.socketPath,
    });
    return true;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (existsSync(this.options.socketPath)) {
      try {
        unlinkSync(this.options.socketPath);
      } catch {
        // App teardown is best-effort; the next launch removes a stale socket.
      }
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.enabled()) {
      respond(response, 501, { ok: false, code: 'ORCHESTRATION_DISABLED' });
      return;
    }
    const token = bearer(request);
    const terminalId = token ? this.options.identities.resolve(token) : null;
    if (!terminalId) {
      respond(response, 403, { ok: false, code: 'CTL_FORBIDDEN' });
      return;
    }
    const parsedRoute = route(request);
    if (!parsedRoute) {
      respond(response, 404, { ok: false, code: 'CTL_ROUTE_NOT_FOUND' });
      return;
    }
    const taskId = this.options.taskForTerminal(terminalId);
    const gateway = taskId ? this.options.gatewayForTask(taskId) : null;
    if (!taskId || !gateway) {
      respond(response, 409, {
        ok: false,
        code: 'CTL_CALLER_NOT_READY',
        summary: 'The caller terminal is not attached to an active Charter session yet.',
      });
      return;
    }

    try {
      this.options.prepareCaller?.(taskId, terminalId);
      const body =
        request.method === 'GET' || request.method === 'DELETE' ? {} : await readBody(request);
      const controller = new AbortController();
      request.once('aborted', () => controller.abort());
      const result = await this.options.control.executeFromTerminal({
        terminalId,
        taskId,
        gateway,
        toolName: parsedRoute.toolName,
        toolInput: { ...parsedRoute.input, ...body },
        signal: controller.signal,
      });
      respond(response, result.ok ? 200 : statusFor(result.code), result);
    } catch (error) {
      this.options.logger.warn('terminal control door request failed', { error: `${error}` });
      respond(response, 400, { ok: false, code: 'CTL_BAD_REQUEST' });
    }
  }
}
