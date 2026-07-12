import { describe, expect, it } from 'vitest';
import type { AgentEvent, ToolExecutor } from '@pi-ide/agent-contract';
import { MockAgentRuntime } from './mock-runtime.js';

function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  return (async () => {
    const out: AgentEvent[] = [];
    for await (const ev of iter) out.push(ev);
    return out;
  })();
}

const noopExecutor: ToolExecutor = async (call) => ({
  callId: call.callId,
  ok: true,
  code: 'OK',
  summary: `executed ${call.toolName}`,
  data: { echo: call.input },
});

async function makeSession(executor: ToolExecutor = noopExecutor) {
  const rt = new MockAgentRuntime({ toolExecutor: executor });
  await rt.initialize({ runtimeDataDir: '/tmp/mock', appVersion: '1.0.0' });
  const session = await rt.createSession({
    taskId: 'task_1',
    workspaceRoot: '/tmp/ws',
    mode: 'ask',
    model: { providerId: 'mock', modelId: 'mock-1' },
    tools: [
      { name: 'read_file', description: 'read', schemaVersion: 1 },
      { name: 'apply_patch', description: 'patch', schemaVersion: 1 },
    ],
    systemPreamble: 'test',
  });
  return { rt, session };
}

describe('MockAgentRuntime', () => {
  it('streams a deterministic ask scenario with monotonic sequences and lifecycle', async () => {
    const { rt, session } = await makeSession();
    const events = await collect(
      rt.startRun({
        sessionRef: session,
        runId: 'run_1',
        prompt: '[scenario:ask-basic] what is this repo?',
      }),
    );
    expect(events[0]?.type).toBe('run.started');
    expect(events.at(-1)?.type).toBe('run.completed');
    expect(events.some((e) => e.type === 'message.delta')).toBe(true);
    expect(events.some((e) => e.type === 'message.completed')).toBe(true);
    expect(events.some((e) => e.type === 'usage.updated')).toBe(true);
    const seqs = events.map((e) => e.sequence);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    await rt.dispose();
  });

  it('runs tool calls through the injected ToolExecutor and reports results', async () => {
    const seen: string[] = [];
    const executor: ToolExecutor = async (call) => {
      seen.push(call.toolName);
      return { callId: call.callId, ok: true, code: 'OK', summary: 'done', data: {} };
    };
    const { rt, session } = await makeSession(executor);
    const events = await collect(
      rt.startRun({ sessionRef: session, runId: 'run_2', prompt: '[scenario:edit-basic] fix it' }),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'plan.proposed')).toBe(true);
    expect(events.some((e) => e.type === 'tool.completed')).toBe(true);
    const completed = events.find((e) => e.type === 'tool.completed');
    expect(completed && 'result' in completed && completed.result.ok).toBe(true);
    await rt.dispose();
  });

  it('abort stops the stream promptly with run.aborted and no further events', async () => {
    const { rt, session } = await makeSession();
    const iter = rt.startRun({
      sessionRef: session,
      runId: 'run_3',
      prompt: '[scenario:slow] long task',
    });
    const events: AgentEvent[] = [];
    for await (const ev of iter) {
      events.push(ev);
      if (events.length === 2) void rt.abort('run_3', 'user_stop');
    }
    expect(events.at(-1)?.type).toBe('run.aborted');
    await rt.dispose();
  });

  it('propagates tool executor denial as a non-successful tool result, not a crash', async () => {
    const executor: ToolExecutor = async (call) => ({
      callId: call.callId,
      ok: false,
      code: 'PERMISSION_DENIED',
      summary: 'user denied',
      data: {},
    });
    const { rt, session } = await makeSession(executor);
    const events = await collect(
      rt.startRun({ sessionRef: session, runId: 'run_4', prompt: '[scenario:edit-basic] x' }),
    );
    const completed = events.filter((e) => e.type === 'tool.completed');
    expect(completed.length).toBeGreaterThan(0);
    expect(completed.every((e) => 'result' in e && e.result.ok === false)).toBe(true);
    expect(events.at(-1)?.type).toBe('run.completed');
    await rt.dispose();
  });
});
