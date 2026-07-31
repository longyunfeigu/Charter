import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@pi-ide/foundation';
import { MIGRATIONS, MissionRepository, openDatabase, type SqlDatabase } from '@pi-ide/persistence';
import { AcpProcessPool, AcpRuntimeAdapter } from './acp-runtime.js';
import { OrchestrationOutboxRunner } from './orchestration-outbox-runner.js';
import { OrchestrationRuntimeRegistry } from './orchestration-runtime-registry.js';

describe('ACP Mission runtime', () => {
  let dir: string;
  let db: SqlDatabase;
  let pool: AcpProcessPool;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'charter-acp-runtime-'));
    db = openDatabase({
      file: join(dir, 'state.sqlite'),
      migrations: MIGRATIONS,
      backupDir: join(dir, 'backups'),
    }).db;
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO workspaces
       (id, canonical_path, display_name, last_opened_at, created_at)
       VALUES ('ws-1', ?, 'Repo', ?, ?)`,
    ).run(dir, at, at);
    const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.mjs');
    pool = new AcpProcessPool(
      () => ({ command: process.execPath, args: [fixture] }),
      createLogger('acp-test', { write: () => undefined }),
    );
  });

  afterEach(async () => {
    await pool.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses one real ACP process for parallel sessions, streams events, and queues doorbells', async () => {
    const repository = new MissionRepository(db);
    const mission = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: dir,
      originConversationTaskId: null,
      title: 'ACP',
      goal: 'ACP',
      lead: {
        principalId: 'lead',
        kind: 'managed_agent',
        displayName: 'Lead',
        runtimeSessionId: 'lead-runtime',
        requestedRuntime: 'managed',
      },
    });
    const children = repository.delegateMany(
      ['B', 'C'].map((title) => ({
        missionId: mission.mission.id,
        supervisorAssignmentId: mission.assignments[0]!.id,
        actorPrincipalId: 'lead',
        goal: title,
        acceptanceCriteria: [],
        requestedRuntime: 'codex' as const,
        workMode: 'read-only' as const,
        reason: 'ACP parallel',
        idempotencyKey: `acp-${title}`,
      })),
    );
    const adapter = new AcpRuntimeAdapter(
      'codex',
      pool,
      repository,
      {
        missionMcp: () => ({
          command: '/usr/bin/true',
          args: [],
          env: {},
        }),
        bindVirtualIdentity: () => undefined,
        releaseVirtualIdentity: () => undefined,
      },
      createLogger('acp-adapter-test', { write: () => undefined }),
    );
    const registry = new OrchestrationRuntimeRegistry();
    registry.registerForRuntime('codex', adapter);
    const runner = new OrchestrationOutboxRunner(repository, registry);
    await runner.drain();
    await vi.waitFor(() => {
      expect(
        repository
          .snapshot(mission.mission.id)
          .runtimeEvents.filter((event) => event.kind === 'turn.stopped'),
      ).toHaveLength(2);
    });
    const snapshot = repository.snapshot(mission.mission.id);
    expect(snapshot.runtimeSessions).toHaveLength(2);
    expect(new Set(snapshot.runtimeSessions.map((session) => session.processKey)).size).toBe(1);
    expect(
      snapshot.runtimeEvents.some(
        (event) =>
          event.kind === 'acp.agent_message_chunk' &&
          event.payload.content &&
          typeof event.payload.content === 'object',
      ),
    ).toBe(true);

    const first = repository.getAttempt(children[0]!.attempt.id)!;
    await adapter.deliver(first.runtimeSessionId!, 'doorbell');
    await vi.waitFor(() => {
      expect(
        repository
          .snapshot(mission.mission.id)
          .runtimeEvents.filter(
            (event) => event.attemptId === first.id && event.kind === 'turn.stopped',
          ).length,
      ).toBe(2);
    });
    runner.stop();
  });
});
