import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolCallRequest } from '@pi-ide/agent-contract';
import type { Logger } from '@pi-ide/foundation';
import { ToolGateway } from '@pi-ide/tool-gateway';
import { CtlServer } from './ctl-server.js';
import {
  TerminalControlIdentityRegistry,
  type TerminalControlService,
} from './terminal-control-service.js';

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => logger,
} as unknown as Logger;

function unixRequest(input: {
  socketPath: string;
  path: string;
  token?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: input.socketPath,
        path: input.path,
        method: 'GET',
        headers: input.token ? { authorization: `Bearer ${input.token}` } : {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe.skipIf(process.platform === 'win32')('CtlServer Unix door (ORCH-008/012)', () => {
  let dir: string;
  let socketPath: string;
  let identities: TerminalControlIdentityRegistry;
  let server: CtlServer;
  let enabled: boolean;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'charter-ctl-'));
    socketPath = join(dir, 'ctl.sock');
    identities = new TerminalControlIdentityRegistry(socketPath);
    enabled = true;
    const gateway = new ToolGateway({ root: dir, mode: 'ask' });
    gateway.register({
      name: 'terminal.list',
      version: 1,
      description: 'list',
      inputSchema: z.object({}).strict(),
      risk: () => ({ level: 'R0', reasons: ['read'] }),
      preview: async () => ({ summary: 'list' }),
      execute: async () => ({ code: 'OK', summary: 'listed', data: { caller: 'ok' } }),
    });
    const control = {
      async executeFromTerminal(input: {
        terminalId: string;
        taskId: string;
        gateway: ToolGateway;
        toolName: string;
        toolInput: unknown;
        signal: AbortSignal;
      }) {
        const call: ToolCallRequest = {
          callId: 'ctl_call',
          runId: `terminal:${input.terminalId}`,
          taskId: input.taskId,
          toolName: input.toolName,
          input: input.toolInput,
        };
        return input.gateway.executeCall(call, input.signal);
      },
    } as unknown as TerminalControlService;
    server = new CtlServer({
      socketPath,
      identities,
      control,
      enabled: () => enabled,
      taskForTerminal: () => 'task_external',
      gatewayForTask: () => gateway,
      logger,
    });
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses mode 0600, rejects missing/bad tokens, and accepts the issuing terminal', async () => {
    await expect(server.start()).resolves.toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    await expect(unixRequest({ socketPath, path: '/v1/terminals' })).resolves.toMatchObject({
      status: 403,
    });
    await expect(
      unixRequest({ socketPath, path: '/v1/terminals', token: 'bad-token' }),
    ).resolves.toMatchObject({ status: 403 });
    const identity = identities.issue('term_caller');
    const response = await unixRequest({
      socketPath,
      path: '/v1/terminals',
      token: identity.token,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, code: 'OK', data: { caller: 'ok' } });
  });

  it('does not create a socket while the master switch is off', async () => {
    enabled = false;
    await expect(server.start()).resolves.toBe(false);
    expect(() => statSync(socketPath)).toThrowError();
  });
});
