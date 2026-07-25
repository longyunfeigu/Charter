import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PiAgentRuntime } from './index.js';
import type { AgentEvent, ToolExecutor } from '@pi-ide/agent-contract';

const executor: ToolExecutor = async (call) => ({
  callId: call.callId,
  ok: true,
  code: 'OK',
  summary: 'noop',
  data: {},
});

/** Error shapes observed live on a user gateway that advertises models on
 * /v1/models it will not serve over the anthropic protocol (gpt-*, gemini-*):
 *  - 'sse-string-error': HTTP 200 + `data: {"type":"error","error":"model: X"}`
 *    (error is a bare STRING — pi ends the turn as a clean, EMPTY end_turn;
 *    this used to surface as a silent "Answered" with an empty Run details)
 *  - 'sse-event-error':  HTTP 200 + `event: error` with a JSON payload
 *  - 'http-404':         non-streaming standard anthropic error body */
type GatewayMode = 'sse-string-error' | 'sse-event-error' | 'http-404';
let mode: GatewayMode = 'sse-string-error';

let dataDir: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pi-ide-adapter-err-'));
  server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.includes('/v1/messages')) {
      req.resume();
      req.on('end', () => {
        if (mode === 'sse-string-error') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify({ type: 'error', error: 'model: gpt-5.4' })}\n\n`);
        } else if (mode === 'sse-event-error') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            `event: error\ndata: ${JSON.stringify({
              error: 'Claude API error',
              status: 404,
              details:
                '{"type":"error","error":{"type":"not_found_error","message":"model: gpt-5.4"}}',
            })}\n\n`,
          );
        } else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'error',
              error: { type: 'not_found_error', message: 'model: gpt-5.4' },
            }),
          );
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

async function runTurn(taskId: string): Promise<AgentEvent[]> {
  const runtime = new PiAgentRuntime({
    toolExecutor: executor,
    credentials: [{ providerId: 'anthropic', kind: 'api-key', value: 'sk-test-000', baseUrl }],
  });
  await runtime.initialize({ runtimeDataDir: dataDir, appVersion: '1.0.0' });
  const ref = await runtime.createSession({
    taskId,
    workspaceRoot: dataDir,
    mode: 'ask',
    // Synthesized gateway model (ensureModel) — exactly the user scenario.
    model: { providerId: 'anthropic', modelId: 'gpt-5.4' },
    tools: [],
    systemPreamble: 'test',
  });
  const events: AgentEvent[] = [];
  for await (const event of runtime.startRun({ sessionRef: ref, runId: 'run-1', prompt: 'hi' })) {
    events.push(event);
  }
  await runtime.dispose();
  return events;
}

describe('provider API errors surface as run.failed (gpt-5.4 empty-turn bug)', () => {
  it('a clean-but-empty turn (string-error SSE frame) fails instead of answering silently', async () => {
    mode = 'sse-string-error';
    const events = await runTurn('err-task-1');
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('run.failed');
    const failure = terminal as Extract<AgentEvent, { type: 'run.failed' }>;
    expect(failure.error.userMessage).toMatch(/anthropic\/gpt-5\.4|no output/i);
    expect(events.some((e) => e.type === 'message.completed')).toBe(false);
  }, 30000);

  it('an event:error SSE frame fails the run with the provider message', async () => {
    mode = 'sse-event-error';
    const events = await runTurn('err-task-2');
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('run.failed');
    const failure = terminal as Extract<AgentEvent, { type: 'run.failed' }>;
    expect(failure.error.userMessage).toMatch(/gpt-5\.4|not_found|404/i);
    expect(events.some((e) => e.type === 'message.completed')).toBe(false);
  }, 30000);
});
