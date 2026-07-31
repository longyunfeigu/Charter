import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@pi-ide/foundation';
import { MIGRATIONS, MissionRepository, openDatabase, type SqlDatabase } from '@pi-ide/persistence';
import {
  AcpProcessPool,
  AcpRuntimeAdapter,
  compactAcpRuntimeEvent,
  FallbackRuntimeAdapter,
} from './acp-runtime.js';
import { OrchestrationOutboxRunner } from './orchestration-outbox-runner.js';
import {
  OrchestrationRuntimeRegistry,
  type OrchestrationRuntimeAdapter,
  type RuntimeStartRequest,
} from './orchestration-runtime-registry.js';

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

    await adapter.deliver(first.runtimeSessionId!, '[hold-turn]');
    let accepted = false;
    const queuedDelivery = adapter
      .deliver(first.runtimeSessionId!, 'queued-until-next-turn', new AbortController().signal)
      .then(() => {
        accepted = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(accepted).toBe(false);
    await queuedDelivery;
    expect(accepted).toBe(true);
    await vi.waitFor(() => {
      expect(
        repository
          .snapshot(mission.mission.id)
          .runtimeEvents.filter(
            (event) => event.attemptId === first.id && event.kind === 'turn.stopped',
          ).length,
      ).toBe(4);
    });

    await adapter.deliver(first.runtimeSessionId!, '[hold-turn]');
    const abortController = new AbortController();
    const abortedDelivery = adapter.deliver(
      first.runtimeSessionId!,
      'stale-doorbell',
      abortController.signal,
    );
    abortController.abort(new Error('assignment completed'));
    await expect(abortedDelivery).rejects.toThrow('assignment completed');
    await vi.waitFor(() => {
      expect(
        repository
          .snapshot(mission.mission.id)
          .runtimeEvents.filter(
            (event) => event.attemptId === first.id && event.kind === 'turn.stopped',
          ).length,
      ).toBe(5);
    });
    runner.stop();
  });
});

describe('Mission runtime routing', () => {
  it('starts new sessions on native PTY while preserving ACP routing for legacy bindings', async () => {
    const primary = {
      kind: 'external-cli',
      start: vi.fn(async () => ({ runtimeSessionId: 'acp:claude:new' })),
      deliver: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } satisfies OrchestrationRuntimeAdapter;
    const native = {
      kind: 'visible-terminal',
      start: vi.fn(async () => ({ runtimeSessionId: 'terminal:native' })),
      deliver: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } satisfies OrchestrationRuntimeAdapter;
    const adapter = new FallbackRuntimeAdapter(primary, native, {
      startWith: 'fallback',
      fallbackOnStartFailure: false,
    });
    const signal = new AbortController().signal;

    await expect(adapter.start({} as RuntimeStartRequest, signal)).resolves.toEqual({
      runtimeSessionId: 'terminal:native',
    });
    expect(primary.start).not.toHaveBeenCalled();
    await adapter.deliver('acp:claude:legacy', 'legacy guidance', signal);
    await adapter.deliver('terminal:native', 'native guidance', signal);
    expect(primary.deliver).toHaveBeenCalledWith('acp:claude:legacy', 'legacy guidance', signal);
    expect(native.deliver).toHaveBeenCalledWith('terminal:native', 'native guidance', signal);
  });

  it('does not silently switch a failed native launch to ACP', async () => {
    const primary = {
      kind: 'external-cli',
      start: vi.fn(async () => ({ runtimeSessionId: 'acp:claude:new' })),
      cancel: vi.fn(async () => undefined),
    } satisfies OrchestrationRuntimeAdapter;
    const native = {
      kind: 'visible-terminal',
      start: vi.fn(async () => {
        throw new Error('claude executable is unavailable');
      }),
      cancel: vi.fn(async () => undefined),
    } satisfies OrchestrationRuntimeAdapter;
    const adapter = new FallbackRuntimeAdapter(primary, native, {
      startWith: 'fallback',
      fallbackOnStartFailure: false,
    });

    await expect(
      adapter.start({} as RuntimeStartRequest, new AbortController().signal),
    ).rejects.toThrow('claude executable is unavailable');
    expect(primary.start).not.toHaveBeenCalled();
  });

  it('bounds oversized ACP tool updates before persistence', () => {
    const compact = compactAcpRuntimeEvent({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      title: 'Capture screenshot',
      status: 'completed',
      rawInput: { path: '/tmp/screenshot.png' },
      rawOutput: 'x'.repeat(1_000_000),
      content: [{ type: 'image', data: 'a'.repeat(1_000_000) }],
    });

    expect(compact).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      truncated: true,
    });
    expect(compact.originalBytes).toEqual(expect.any(Number));
    expect(compact).not.toHaveProperty('rawOutput');
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(16 * 1024);
  });
});
