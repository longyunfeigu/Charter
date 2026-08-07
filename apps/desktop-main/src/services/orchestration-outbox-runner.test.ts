import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, MIGRATIONS, MissionRepository } from '@pi-ide/persistence';
import type {
  OrchestrationRuntimeAdapter,
  RuntimeSessionBinding,
  RuntimeStartRequest,
} from './orchestration-runtime-registry.js';
import { OrchestrationRuntimeRegistry } from './orchestration-runtime-registry.js';
import { OrchestrationOutboxRunner } from './orchestration-outbox-runner.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'charter-outbox-fault-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('OrchestrationOutboxRunner fault boundaries', () => {
  it('starts independent Assignment aggregates concurrently while preserving each aggregate order', async () => {
    const opened = openDatabase({
      file: join(dir, 'parallel.db'),
      backupDir: join(dir, 'backups'),
      migrations: MIGRATIONS,
    });
    const at = new Date().toISOString();
    opened.db
      .prepare(
        `INSERT INTO workspaces
         (id, canonical_path, display_name, last_opened_at, created_at)
         VALUES ('ws-1', '/repo', 'Repo', ?, ?)`,
      )
      .run(at, at);
    const repository = new MissionRepository(opened.db);
    const mission = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Parallel',
      goal: 'Parallel',
      lead: {
        principalId: 'lead',
        kind: 'managed_agent',
        displayName: 'Lead',
        runtimeSessionId: 'lead-runtime',
        requestedRuntime: 'managed',
      },
    });
    repository.delegateMany(
      ['B', 'C'].map((name) => ({
        missionId: mission.mission.id,
        supervisorAssignmentId: mission.assignments[0]!.id,
        actorPrincipalId: 'lead',
        goal: name,
        acceptanceCriteria: [],
        requestedRuntime: 'managed' as const,
        workMode: 'read-only' as const,
        reason: 'parallel',
        idempotencyKey: name,
      })),
    );
    const resolvers: Array<() => void> = [];
    let starts = 0;
    const adapter: OrchestrationRuntimeAdapter = {
      kind: 'managed-agent',
      async start(input) {
        starts += 1;
        await new Promise<void>((resolve) => resolvers.push(resolve));
        return { runtimeSessionId: `runtime:${input.attempt.id}` };
      },
      async cancel() {},
    };
    const registry = new OrchestrationRuntimeRegistry();
    registry.register(adapter);
    const runner = new OrchestrationOutboxRunner(repository, registry);
    const draining = runner.drain();
    await vi.waitFor(() => expect(starts).toBe(2));
    resolvers.forEach((resolve) => resolve());
    await draining;
    expect(repository.snapshot(mission.mission.id).runtimeSessions).toHaveLength(2);
    runner.stop();
    opened.db.close();
  });

  it('retries a lost runtime-create response without creating a duplicate runtime', async () => {
    const opened = openDatabase({
      file: join(dir, 'state.db'),
      backupDir: join(dir, 'backups'),
      migrations: MIGRATIONS,
    });
    const at = new Date().toISOString();
    opened.db
      .prepare(
        `INSERT INTO workspaces
         (id, canonical_path, display_name, last_opened_at, created_at)
         VALUES ('ws-1', '/repo', 'Repo', ?, ?)`,
      )
      .run(at, at);
    const repository = new MissionRepository(opened.db);
    const mission = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Fault injection',
      goal: 'Fault injection',
      lead: {
        principalId: 'lead',
        kind: 'managed_agent',
        displayName: 'Lead',
        runtimeSessionId: 'runtime-lead',
        requestedRuntime: 'managed',
      },
    });
    const child = repository.delegate({
      missionId: mission.mission.id,
      supervisorAssignmentId: mission.assignments[0]!.id,
      actorPrincipalId: 'lead',
      goal: 'Create exactly once',
      acceptanceCriteria: [],
      requestedRuntime: 'managed',
      workMode: 'read-only',
      reason: 'fault test',
      idempotencyKey: 'exactly-once-runtime',
    });

    let startCalls = 0;
    let createdRuntimes = 0;
    const byKey = new Map<string, RuntimeSessionBinding>();
    const adapter: OrchestrationRuntimeAdapter = {
      kind: 'managed-agent',
      async start(input: RuntimeStartRequest) {
        startCalls += 1;
        let binding = byKey.get(input.idempotencyKey);
        if (!binding) {
          createdRuntimes += 1;
          binding = { runtimeSessionId: 'runtime-child' };
          byKey.set(input.idempotencyKey, binding);
          throw new Error('response lost after runtime creation');
        }
        return binding;
      },
      async cancel() {},
    };
    const registry = new OrchestrationRuntimeRegistry();
    registry.register(adapter);
    const runner = new OrchestrationOutboxRunner(repository, registry, { retryBaseMs: 0 });

    await runner.drain();
    await runner.drain();

    expect(startCalls).toBe(2);
    expect(createdRuntimes).toBe(1);
    expect(repository.getAttempt(child.attempt.id)).toEqual(
      expect.objectContaining({ state: 'RUNNING', runtimeSessionId: 'runtime-child' }),
    );
    expect(repository.listPendingOutbox()).toHaveLength(0);
    runner.stop();
    opened.db.close();
  });

  it('marks an inbox message delivered only after the runtime accepts the doorbell', async () => {
    const opened = openDatabase({
      file: join(dir, 'delivery.db'),
      backupDir: join(dir, 'backups'),
      migrations: MIGRATIONS,
    });
    const at = new Date().toISOString();
    opened.db
      .prepare(
        `INSERT INTO workspaces
         (id, canonical_path, display_name, last_opened_at, created_at)
         VALUES ('ws-1', '/repo', 'Repo', ?, ?)`,
      )
      .run(at, at);
    const repository = new MissionRepository(opened.db);
    const mission = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Turn-safe delivery',
      goal: 'Turn-safe delivery',
      lead: {
        principalId: 'lead',
        kind: 'managed_agent',
        displayName: 'Lead',
        runtimeSessionId: 'lead-runtime',
        requestedRuntime: 'managed',
      },
    });
    const child = repository.delegate({
      missionId: mission.mission.id,
      supervisorAssignmentId: mission.assignments[0]!.id,
      actorPrincipalId: 'lead',
      goal: 'Receive one message',
      acceptanceCriteria: [],
      requestedRuntime: 'managed',
      workMode: 'read-only',
      reason: 'delivery test',
      idempotencyKey: 'delivery-child',
    });

    let deliveryStarted = false;
    let releaseDelivery: () => void = () => undefined;
    const adapter: OrchestrationRuntimeAdapter = {
      kind: 'managed-agent',
      async start(input) {
        return { runtimeSessionId: `runtime:${input.attempt.id}` };
      },
      async deliver() {
        deliveryStarted = true;
        await new Promise<void>((resolve) => {
          releaseDelivery = resolve;
        });
      },
      async cancel() {},
    };
    const registry = new OrchestrationRuntimeRegistry();
    registry.register(adapter);
    const runner = new OrchestrationOutboxRunner(repository, registry);
    await runner.drain();

    const message = repository.createMessage({
      missionId: mission.mission.id,
      fromAssignmentId: mission.assignments[0]!.id,
      toAssignmentId: child.assignment.id,
      type: 'question',
      subject: 'Wait for your turn boundary',
    });
    runner.signalAssignment(child.assignment.id, 0);
    await vi.waitFor(() => expect(deliveryStarted).toBe(true));
    expect(repository.listMessageDeliveries(mission.mission.id)).toContainEqual(
      expect.objectContaining({ messageId: message.id, state: 'pending' }),
    );

    releaseDelivery();
    await vi.waitFor(() =>
      expect(repository.listMessageDeliveries(mission.mission.id)).toContainEqual(
        expect.objectContaining({ messageId: message.id, state: 'delivered' }),
      ),
    );
    runner.stop();
    opened.db.close();
  });

  it('retries a durable resume intent after a transient runtime delivery failure', async () => {
    const opened = openDatabase({
      file: join(dir, 'continuation-retry.db'),
      backupDir: join(dir, 'backups'),
      migrations: MIGRATIONS,
    });
    const at = new Date().toISOString();
    opened.db
      .prepare(
        `INSERT INTO workspaces
         (id, canonical_path, display_name, last_opened_at, created_at)
         VALUES ('ws-1', '/repo', 'Repo', ?, ?)`,
      )
      .run(at, at);
    const repository = new MissionRepository(opened.db);
    const mission = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Retry continuation delivery',
      goal: 'Do not lose a resume when the PTY is briefly unavailable',
      lead: {
        principalId: 'lead',
        kind: 'managed_agent',
        displayName: 'Lead',
        runtimeSessionId: 'lead-runtime',
        requestedRuntime: 'managed',
      },
    });
    const lead = mission.assignments[0]!;
    const trigger = repository.createMessage({
      missionId: mission.mission.id,
      fromAssignmentId: null,
      toAssignmentId: lead.id,
      type: 'answer',
      subject: 'ready',
    });
    const continuation = repository.armContinuation({
      missionId: mission.mission.id,
      ownerAssignmentId: lead.id,
      ownerAttemptId: mission.attempts[0]!.id,
      mode: 'any',
      conditions: [{ kind: 'message', types: ['answer'] }],
      cursorSequence: trigger.sequence - 1,
      reason: 'Resume after the answer',
      idempotencyKey: 'retry-resume',
    });
    expect(continuation.continuation.state).toBe('READY');

    let deliveries = 0;
    const adapter: OrchestrationRuntimeAdapter = {
      kind: 'managed-agent',
      async start() {
        throw new Error('not used');
      },
      async deliver(_runtimeSessionId, text) {
        deliveries += 1;
        expect(text).toContain(continuation.continuation.id);
        if (deliveries === 1) throw new Error('PTY reconnecting');
      },
      async cancel() {},
    };
    const registry = new OrchestrationRuntimeRegistry();
    registry.register(adapter);
    const runner = new OrchestrationOutboxRunner(repository, registry, { retryBaseMs: 1 });
    runner.start();

    await vi.waitFor(() => expect(deliveries).toBe(2), { timeout: 2_000 });
    await vi.waitFor(() =>
      expect(repository.getContinuation(continuation.continuation.id)?.state).toBe('DELIVERED'),
    );
    const intent = repository.listResumeIntents(mission.mission.id)[0]!;
    expect(intent).toMatchObject({ state: 'DELIVERED', attempts: 2, lastError: null });
    runner.stop();
    opened.db.close();
  });

  it('does not mark a continuation delivered before the runtime confirms turn start', async () => {
    const opened = openDatabase({
      file: join(dir, 'continuation-confirmed.db'),
      backupDir: join(dir, 'backups'),
      migrations: MIGRATIONS,
    });
    const at = new Date().toISOString();
    opened.db
      .prepare(
        `INSERT INTO workspaces
         (id, canonical_path, display_name, last_opened_at, created_at)
         VALUES ('ws-1', '/repo', 'Repo', ?, ?)`,
      )
      .run(at, at);
    const repository = new MissionRepository(opened.db);
    const mission = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Confirmed continuation delivery',
      goal: 'Only commit delivery after a real runtime edge',
      lead: {
        principalId: 'lead',
        kind: 'managed_agent',
        displayName: 'Lead',
        runtimeSessionId: 'lead-runtime',
        requestedRuntime: 'managed',
      },
    });
    const lead = mission.assignments[0]!;
    const trigger = repository.createMessage({
      missionId: mission.mission.id,
      fromAssignmentId: null,
      toAssignmentId: lead.id,
      type: 'answer',
      subject: 'ready',
    });
    const continuation = repository.armContinuation({
      missionId: mission.mission.id,
      ownerAssignmentId: lead.id,
      ownerAttemptId: mission.attempts[0]!.id,
      mode: 'any',
      conditions: [{ kind: 'message', types: ['answer'] }],
      cursorSequence: trigger.sequence - 1,
      reason: 'Confirm the resumed Agent turn',
      idempotencyKey: 'confirmed-resume',
    });

    let release: () => void = () => undefined;
    const adapter: OrchestrationRuntimeAdapter = {
      kind: 'managed-agent',
      async start() {
        throw new Error('not used');
      },
      async deliver() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async cancel() {},
    };
    const registry = new OrchestrationRuntimeRegistry();
    registry.register(adapter);
    const runner = new OrchestrationOutboxRunner(repository, registry);
    const draining = runner.drain();

    await vi.waitFor(() =>
      expect(repository.getContinuation(continuation.continuation.id)?.state).toBe('DELIVERING'),
    );
    expect(repository.listResumeIntents(mission.mission.id)[0]).toMatchObject({
      state: 'PROCESSING',
      deliveredAt: null,
    });

    release();
    await draining;
    expect(repository.getContinuation(continuation.continuation.id)?.state).toBe('DELIVERED');
    expect(repository.listResumeIntents(mission.mission.id)[0]).toMatchObject({
      state: 'DELIVERED',
      deliveredAt: expect.any(String),
    });
    runner.stop();
    opened.db.close();
  });
});
