import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '@pi-ide/foundation';
import { MIGRATIONS, MissionRepository, openDatabase } from '@pi-ide/persistence';
import type { OrchestrationRuntimeAdapter } from './orchestration-runtime-registry.js';
import { OrchestrationRuntimeRegistry } from './orchestration-runtime-registry.js';
import { OrchestrationOutboxRunner } from './orchestration-outbox-runner.js';
import { OrchestrationRecoveryService } from './orchestration-recovery-service.js';

const roots: string[] = [];
const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return logger;
  },
} as unknown as Logger;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'charter-mission-recovery-'));
  roots.push(root);
  const db = openDatabase({
    file: join(root, 'state.db'),
    backupDir: join(root, 'backup'),
    migrations: MIGRATIONS,
  }).db;
  const at = new Date().toISOString();
  db.prepare(
    "INSERT INTO workspaces (id, canonical_path, display_name, last_opened_at, created_at) VALUES ('ws', '/repo', 'Repo', ?, ?)",
  ).run(at, at);
  const repository = new MissionRepository(db);
  const live = new Set(['runtime-A']);
  const paused: string[] = [];
  const adapter: OrchestrationRuntimeAdapter = {
    kind: 'managed-agent',
    async start(input) {
      const runtimeSessionId = `runtime:${input.attempt.id}`;
      live.add(runtimeSessionId);
      return { runtimeSessionId };
    },
    async cancel(runtimeSessionId) {
      live.delete(runtimeSessionId);
    },
    async pause(runtimeSessionId) {
      paused.push(runtimeSessionId);
    },
    async reconcile(runtimeSessionId) {
      return { state: live.has(runtimeSessionId) ? 'alive' : 'missing' };
    },
  };
  const runtimes = new OrchestrationRuntimeRegistry();
  runtimes.register(adapter);
  const created = repository.createMission({
    workspaceId: 'ws',
    workspaceRoot: '/repo',
    title: 'Mission',
    goal: 'Mission',
    lead: {
      principalId: 'A',
      kind: 'managed_agent',
      displayName: 'A',
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    },
  });
  const child = repository.delegate({
    missionId: created.mission.id,
    supervisorAssignmentId: created.mission.leadAssignmentId!,
    actorPrincipalId: 'A',
    goal: 'Child',
    acceptanceCriteria: [],
    requestedRuntime: 'managed',
    workMode: 'read-only',
    reason: 'independent',
    idempotencyKey: 'child',
  });
  return { db, repository, runtimes, live, paused, created, child };
}

describe('OrchestrationRecoveryService', () => {
  it('rebinds live runtimes and renews their leases after restart', async () => {
    const state = setup();
    const runner = new OrchestrationOutboxRunner(state.repository, state.runtimes);
    await runner.drain();
    const recovery = new OrchestrationRecoveryService(state.repository, state.runtimes, logger, {
      leaseMs: 60_000,
    });
    await recovery.reconcileAll();
    const attempt = state.repository.getAttempt(state.child.attempt.id)!;
    expect(attempt.state).toBe('RUNNING');
    expect(attempt.leaseExpiresAt).not.toBeNull();
    state.db.close();
  });

  it('reapplies a persisted pause to the live runtime after restart', async () => {
    const state = setup();
    const runner = new OrchestrationOutboxRunner(state.repository, state.runtimes);
    await runner.drain();
    const runtimeId = state.repository.getAttempt(state.child.attempt.id)!.runtimeSessionId!;
    state.repository.pauseAssignment(state.child.assignment.id, true, 'A');

    const recovery = new OrchestrationRecoveryService(state.repository, state.runtimes, logger);
    await recovery.reconcileAll();

    expect(state.repository.getAssignment(state.child.assignment.id)?.state).toBe('PAUSED');
    expect(state.paused).toEqual([runtimeId]);
    state.db.close();
  });

  it('fails a worker whose persisted runtime is missing without destroying its Mission', async () => {
    const state = setup();
    const runner = new OrchestrationOutboxRunner(state.repository, state.runtimes);
    await runner.drain();
    const runtimeId = state.repository.getAttempt(state.child.attempt.id)!.runtimeSessionId!;
    state.live.delete(runtimeId);
    const recovery = new OrchestrationRecoveryService(state.repository, state.runtimes, logger);
    await recovery.reconcileAll();
    expect(state.repository.getAttempt(state.child.attempt.id)?.state).toBe('FAILED');
    expect(state.repository.getAssignment(state.child.assignment.id)?.state).toBe('FAILED');
    expect(state.repository.getMission(state.created.mission.id)?.state).toBe('RUNNING');
    state.db.close();
  });

  it('orphans a lost Lead and blocks the Mission while keeping children durable', async () => {
    const state = setup();
    const runner = new OrchestrationOutboxRunner(state.repository, state.runtimes);
    await runner.drain();
    state.live.delete('runtime-A');
    const recovery = new OrchestrationRecoveryService(state.repository, state.runtimes, logger);
    await recovery.reconcileAll();
    expect(state.repository.getAssignment(state.created.mission.leadAssignmentId!)?.state).toBe(
      'ORPHANED',
    );
    expect(state.repository.getMission(state.created.mission.id)?.state).toBe('BLOCKED');
    expect(state.repository.getAssignment(state.child.assignment.id)).not.toBeNull();
    state.db.close();
  });
});
