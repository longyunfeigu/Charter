import { describe, expect, it, beforeEach } from 'vitest';
import {
  PermissionEngine,
  createMemoryPermissionStore,
  type PermissionRequestCard,
  type MemoryPermissionStore,
} from './permission-engine.js';
import type { RiskAssessment, ToolPreview } from './gateway.js';
import type { AgentMode, ToolCallRequest } from '@pi-ide/agent-contract';

let store: MemoryPermissionStore;
let engine: PermissionEngine;
let pending: PermissionRequestCard[];
let resolved: Array<{ requestId: string; outcome: string; pendingLeftForTask: number }>;

function makeCall(input: unknown, taskId = 't1'): ToolCallRequest {
  return {
    callId: `c_${Math.random().toString(36).slice(2)}`,
    runId: 'r1',
    taskId,
    toolName: 'run_command',
    input,
  };
}

function decide(opts: {
  input?: unknown;
  taskId?: string;
  risk?: Partial<RiskAssessment> & { level: RiskAssessment['level'] };
  preview?: Partial<ToolPreview>;
  mode?: AgentMode;
  signal?: AbortSignal;
}) {
  return engine.decide({
    call: makeCall(opts.input ?? { executable: 'npm', args: ['install'] }, opts.taskId ?? 't1'),
    tool: { name: 'run_command', version: 1, description: 'run a command' },
    risk: { reasons: ['test'], ...opts.risk } as RiskAssessment,
    preview: { summary: 'npm install', ruleKey: 'run_command:npm:install', ...opts.preview },
    mode: opts.mode ?? 'edit',
    signal: opts.signal ?? new AbortController().signal,
    onWaiting: () => undefined,
  });
}

beforeEach(() => {
  store = createMemoryPermissionStore();
  pending = [];
  resolved = [];
  engine = new PermissionEngine({
    workspaceId: 'ws1',
    store,
    events: {
      onPending: (card) => pending.push(card),
      onResolved: (info) =>
        resolved.push({
          requestId: info.requestId,
          outcome: info.outcome,
          pendingLeftForTask: info.pendingLeftForTask,
        }),
    },
  });
});

describe('PermissionEngine (PERM-001..010)', () => {
  it('auto-allows R0 without creating a request', async () => {
    const decision = await decide({ risk: { level: 'R0' } });
    expect(decision.kind).toBe('allow');
    expect(pending).toHaveLength(0);
    expect(store.requests).toHaveLength(0);
  });

  it('denies R4 permanently even if a bogus allow rule exists (defense in depth)', async () => {
    store.saveRule({
      id: 'x',
      workspaceId: 'ws1',
      taskId: null,
      kind: 'allow',
      ruleKey: 'run_command:npm:install',
      risk: 'R4',
      createdAt: 'now',
    });
    const decision = await decide({ risk: { level: 'R4' } });
    expect(decision.kind).toBe('deny');
    expect(decision.kind === 'deny' && decision.permanent).toBe(true);
  });

  it('asks the user for R1+ and resolves allow-once (PERM-002)', async () => {
    const p = decide({ risk: { level: 'R2' } });
    await Promise.resolve();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.options.allowScopes).toEqual(['once', 'task', 'workspace']);
    const outcome = engine.resolve({
      requestId: pending[0]!.requestId,
      kind: 'allow',
      scope: 'once',
      expectedParamsHash: pending[0]!.paramsHash,
      actor: 'user',
    });
    expect(outcome.resolvedRequestIds).toEqual([pending[0]!.requestId]);
    const decision = await p;
    expect(decision).toEqual({ kind: 'allow', scope: 'once', paramsHash: pending[0]!.paramsHash });
    expect(store.requests[0]!.state).toBe('ALLOWED');
    expect(store.decisions).toHaveLength(1);
    expect(resolved[0]!.outcome).toBe('allowed');
    // once-scope must not create a standing rule
    expect(store.rules).toHaveLength(0);
  });

  it('deny passes the user reason to the agent and never executes (PERM-006)', async () => {
    const p = decide({ risk: { level: 'R2' } });
    await Promise.resolve();
    engine.resolve({
      requestId: pending[0]!.requestId,
      kind: 'deny',
      scope: 'once',
      reason: 'not on my machine',
      expectedParamsHash: pending[0]!.paramsHash,
      actor: 'user',
    });
    const decision = await p;
    expect(decision.kind).toBe('deny');
    expect(decision.kind === 'deny' && decision.reason).toContain('not on my machine');
    expect(decision.kind === 'deny' && decision.permanent).toBe(false);
  });

  it('task-scope grants apply to the same rule in the same task only', async () => {
    const p1 = decide({ risk: { level: 'R2' }, taskId: 'tA' });
    await Promise.resolve();
    engine.resolve({
      requestId: pending[0]!.requestId,
      kind: 'allow',
      scope: 'task',
      expectedParamsHash: pending[0]!.paramsHash,
      actor: 'user',
    });
    await p1;
    expect(store.rules).toHaveLength(1);
    expect(store.rules[0]!.taskId).toBe('tA');

    // Same task + same ruleKey: no new pending request.
    const d2 = await decide({ risk: { level: 'R2' }, taskId: 'tA' });
    expect(d2.kind).toBe('allow');
    expect(pending).toHaveLength(1);

    // Different task: asks again.
    const p3 = decide({ risk: { level: 'R2' }, taskId: 'tB' });
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    engine.resolve({
      requestId: pending[1]!.requestId,
      kind: 'deny',
      scope: 'once',
      expectedParamsHash: pending[1]!.paramsHash,
      actor: 'user',
    });
    await p3;
  });

  it('workspace-scope grants apply across tasks (PERM-002)', async () => {
    const p1 = decide({ risk: { level: 'R2' }, taskId: 'tA' });
    await Promise.resolve();
    engine.resolve({
      requestId: pending[0]!.requestId,
      kind: 'allow',
      scope: 'workspace',
      expectedParamsHash: pending[0]!.paramsHash,
      actor: 'user',
    });
    await p1;
    const d2 = await decide({ risk: { level: 'R2' }, taskId: 'tB' });
    expect(d2.kind).toBe('allow');
    expect(pending).toHaveLength(1);
  });

  it('R3 can never be granted task- or workspace-wide (PERM-003)', async () => {
    const p1 = decide({ risk: { level: 'R3' } });
    await Promise.resolve();
    // The card must not even offer persistent scopes for R3.
    expect(pending[0]!.options.allowScopes).toEqual(['once']);
    // Even a hostile/buggy caller asking for workspace scope gets downgraded to once.
    engine.resolve({
      requestId: pending[0]!.requestId,
      kind: 'allow',
      scope: 'workspace',
      expectedParamsHash: pending[0]!.paramsHash,
      actor: 'user',
    });
    const d1 = await p1;
    expect(d1.kind).toBe('allow');
    expect(store.rules).toHaveLength(0);

    // Next identical R3 call asks again.
    const p2 = decide({ risk: { level: 'R3' } });
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    engine.resolve({
      requestId: pending[1]!.requestId,
      kind: 'deny',
      scope: 'once',
      expectedParamsHash: pending[1]!.paramsHash,
      actor: 'user',
    });
    await p2;
  });

  it('a workspace allow rule never applies to an R3 call even if present (PERM-003)', async () => {
    store.saveRule({
      id: 'x',
      workspaceId: 'ws1',
      taskId: null,
      kind: 'allow',
      ruleKey: 'run_command:npm:install',
      risk: 'R2',
      createdAt: 'now',
    });
    const p = decide({ risk: { level: 'R3' } });
    await Promise.resolve();
    expect(pending).toHaveLength(1); // still asks
    engine.resolve({
      requestId: pending[0]!.requestId,
      kind: 'deny',
      scope: 'once',
      expectedParamsHash: pending[0]!.paramsHash,
      actor: 'user',
    });
    await p;
  });

  it('"always deny" persists a deny rule that short-circuits future calls', async () => {
    const p1 = decide({ risk: { level: 'R2' } });
    await Promise.resolve();
    engine.resolve({
      requestId: pending[0]!.requestId,
      kind: 'deny',
      scope: 'always',
      reason: 'never do this',
      expectedParamsHash: pending[0]!.paramsHash,
      actor: 'user',
    });
    const d1 = await p1;
    expect(d1.kind).toBe('deny');
    expect(store.rules.some((r) => r.kind === 'deny')).toBe(true);

    const d2 = await decide({ risk: { level: 'R2' } });
    expect(d2.kind).toBe('deny');
    expect(d2.kind === 'deny' && d2.permanent).toBe(true);
    expect(pending).toHaveLength(1); // no second ask
  });

  it('resolves as cancelled when the run aborts while waiting', async () => {
    const controller = new AbortController();
    const p = decide({ risk: { level: 'R2' }, signal: controller.signal });
    await Promise.resolve();
    expect(pending).toHaveLength(1);
    controller.abort();
    const decision = await p;
    expect(decision.kind).toBe('deny');
    expect(store.requests[0]!.state).toBe('CANCELLED');
    expect(resolved[0]!.outcome).toBe('cancelled');
  });

  it('cancelPendingForTask cancels only that task’s waiters', async () => {
    const pA = decide({ risk: { level: 'R2' }, taskId: 'tA' });
    const pB = decide({
      risk: { level: 'R2' },
      taskId: 'tB',
      preview: { ruleKey: 'run_command:other' },
    });
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    engine.cancelPendingForTask('tA', 'run interrupted');
    const dA = await pA;
    expect(dA.kind).toBe('deny');
    expect(engine.pendingForTask('tB')).toHaveLength(1);
    engine.resolve({
      requestId: pending[1]!.requestId,
      kind: 'deny',
      scope: 'once',
      expectedParamsHash: pending[1]!.paramsHash,
      actor: 'user',
    });
    await pB;
  });

  it('batch-resolves similar pending requests when asked (PERM-005)', async () => {
    const p1 = decide({ risk: { level: 'R2' }, input: { executable: 'npx', args: ['tsc'] } });
    const p2 = decide({
      risk: { level: 'R2' },
      input: { executable: 'npx', args: ['tsc', '--noEmit'] },
    });
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    const outcome = engine.resolve({
      requestId: pending[0]!.requestId,
      kind: 'allow',
      scope: 'once',
      applyToSimilar: true,
      expectedParamsHash: pending[0]!.paramsHash,
      actor: 'user',
    });
    expect(outcome.resolvedRequestIds).toHaveLength(2);
    expect((await p1).kind).toBe('allow');
    expect((await p2).kind).toBe('allow');
    expect(store.decisions).toHaveLength(2);
  });

  it('invalidates the approval when the displayed params differ from the live call (PERM-007)', async () => {
    const p = decide({ risk: { level: 'R2' } });
    await Promise.resolve();
    const first = pending[0]!;
    const outcome = engine.resolve({
      requestId: first.requestId,
      kind: 'allow',
      scope: 'once',
      expectedParamsHash: 'stale-hash-from-an-old-card',
      actor: 'user',
    });
    expect(outcome.resolvedRequestIds).toHaveLength(0);
    expect(store.requests.find((r) => r.id === first.requestId)?.state).toBe('INVALIDATED');
    // A fresh request for the same call is emitted; approving it with the right hash works.
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    const second = pending[1]!;
    expect(second.requestId).not.toBe(first.requestId);
    engine.resolve({
      requestId: second.requestId,
      kind: 'allow',
      scope: 'once',
      expectedParamsHash: second.paramsHash,
      actor: 'user',
    });
    expect((await p).kind).toBe('allow');
  });

  it('full mode auto-allows R1–R3 without asking, but standing denies and R4 still win (ADR-0012)', async () => {
    for (const risk of [
      { level: 'R1' as const },
      { level: 'R2' as const },
      { level: 'R2' as const, recognized: true },
      { level: 'R3' as const },
    ]) {
      const decision = await decide({ mode: 'full', risk });
      expect(decision.kind).toBe('allow');
    }
    expect(pending).toHaveLength(0);

    // R4 is refused before/without any prompt — full mode is not a bypass.
    const r4 = await decide({ mode: 'full', risk: { level: 'R4' } });
    expect(r4.kind).toBe('deny');
    expect((r4 as { permanent?: boolean }).permanent).toBe(true);

    // A standing user deny beats full-mode auto-allow.
    store.saveRule({
      id: 'rule-deny',
      workspaceId: 'ws1',
      taskId: null,
      kind: 'deny',
      ruleKey: 'run_command:npm:install',
      risk: 'R2',
      createdAt: new Date().toISOString(),
    });
    const denied = await decide({ mode: 'full', risk: { level: 'R2' } });
    expect(denied.kind).toBe('deny');
    expect(pending).toHaveLength(0);
  });

  it('auto mode auto-allows R1 and recognized R2, still asks for unknown R2 and R3', async () => {
    const r1 = await decide({ mode: 'auto', risk: { level: 'R1' } });
    expect(r1.kind).toBe('allow');
    const r2known = await decide({ mode: 'auto', risk: { level: 'R2', recognized: true } });
    expect(r2known.kind).toBe('allow');
    expect(pending).toHaveLength(0);

    const p3 = decide({ mode: 'auto', risk: { level: 'R2' } });
    await Promise.resolve();
    expect(pending).toHaveLength(1);
    engine.resolve({
      requestId: pending[0]!.requestId,
      kind: 'deny',
      scope: 'once',
      expectedParamsHash: pending[0]!.paramsHash,
      actor: 'user',
    });
    await p3;

    const p4 = decide({ mode: 'auto', risk: { level: 'R3' } });
    await Promise.resolve();
    expect(pending).toHaveLength(2);
    engine.resolve({
      requestId: pending[1]!.requestId,
      kind: 'deny',
      scope: 'once',
      expectedParamsHash: pending[1]!.paramsHash,
      actor: 'user',
    });
    await p4;
  });

  it('audits every decision with actor and scope, never raw secrets (PERM-010)', async () => {
    const p = decide({
      risk: { level: 'R2' },
      input: { executable: 'deploy', args: [], env: { API_TOKEN: 'sk-abcdef1234567890abcdef' } },
    });
    await Promise.resolve();
    engine.resolve({
      requestId: pending[0]!.requestId,
      kind: 'allow',
      scope: 'once',
      expectedParamsHash: pending[0]!.paramsHash,
      actor: 'user',
    });
    await p;
    const persisted = JSON.stringify({ req: store.requests, dec: store.decisions });
    expect(persisted).not.toContain('sk-abcdef1234567890abcdef');
    expect(store.decisions[0]!.actor).toBe('user');
    expect(store.decisions[0]!.scope).toBe('once');
  });
});
