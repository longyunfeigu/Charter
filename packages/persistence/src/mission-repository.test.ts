import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductFailure } from '@pi-ide/foundation';
import { openDatabase } from './database.js';
import { MIGRATIONS } from './migrations.js';
import { MissionRepository } from './mission-repository.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'charter-mission-repository-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open() {
  return openDatabase({
    file: join(dir, 'state.db'),
    backupDir: join(dir, 'backups'),
    migrations: MIGRATIONS,
  });
}

function seedWorkspace(db: ReturnType<typeof open>['db']): void {
  const at = '2026-07-30T00:00:00.000Z';
  db.prepare(
    `INSERT INTO workspaces
     (id, canonical_path, display_name, last_opened_at, created_at)
     VALUES ('ws-1', '/repo', 'Repo', ?, ?)`,
  ).run(at, at);
}

describe('MissionRepository', () => {
  it('creates delegate_many atomically and tracks durable runtime and message delivery state', () => {
    const opened = open();
    seedWorkspace(opened.db);
    const repository = new MissionRepository(opened.db);
    const created = repository.createMission({
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
    const lead = created.assignments[0]!;
    const children = repository.delegateMany(
      ['B', 'C'].map((name) => ({
        missionId: created.mission.id,
        supervisorAssignmentId: lead.id,
        actorPrincipalId: 'lead',
        goal: `Work ${name}`,
        acceptanceCriteria: [],
        requestedRuntime: 'managed' as const,
        workMode: 'read-only' as const,
        reason: 'parallel',
        idempotencyKey: `parallel-${name}`,
      })),
    );
    expect(children).toHaveLength(2);
    expect(repository.listPendingOutbox()).toHaveLength(2);
    const target = children[0]!;
    repository.bindRuntime(target.assignment.id, target.attempt.id, {
      runtimeSessionId: 'managed:B',
    });
    const runtime = repository.upsertRuntimeSession({
      id: `runtime:${target.attempt.id}`,
      attemptId: target.attempt.id,
      provider: 'managed',
      transport: 'native',
      state: 'RUNNING',
      cwd: '/repo',
    });
    repository.appendRuntimeEvent(runtime.id, target.attempt.id, 'turn.started');
    const message = repository.createMessage({
      missionId: created.mission.id,
      fromAssignmentId: lead.id,
      toAssignmentId: target.assignment.id,
      type: 'assignment',
      subject: 'Begin',
    });
    expect(repository.listMessageDeliveries(created.mission.id)[0]).toEqual(
      expect.objectContaining({ messageId: message.id, state: 'pending' }),
    );
    repository.markMessagesDelivered(target.assignment.id, [message.id]);
    repository.markMessagesRead(target.assignment.id, [message.id]);
    const snapshot = repository.snapshot(created.mission.id);
    expect(snapshot.runtimeSessions[0]).toEqual(expect.objectContaining({ transport: 'native' }));
    expect(snapshot.runtimeEvents[0]?.kind).toBe('turn.started');
    expect(snapshot.messageDeliveries[0]?.state).toBe('observed');
    opened.db.close();
  });

  it('rolls back every child when one delegate_many request is invalid', () => {
    const opened = open();
    seedWorkspace(opened.db);
    const repository = new MissionRepository(opened.db);
    const created = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Atomic',
      goal: 'Atomic',
      lead: {
        principalId: 'lead',
        kind: 'managed_agent',
        displayName: 'Lead',
        runtimeSessionId: 'lead-runtime',
        requestedRuntime: 'managed',
      },
    });
    const lead = created.assignments[0]!;
    const base = {
      missionId: created.mission.id,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: 'lead',
      acceptanceCriteria: [],
      requestedRuntime: 'managed' as const,
      workMode: 'read-only' as const,
      reason: 'atomic',
    };
    expect(() =>
      repository.delegateMany([
        { ...base, goal: 'valid', idempotencyKey: 'valid' },
        {
          ...base,
          goal: 'invalid dependency',
          dependencies: ['outside'],
          idempotencyKey: 'invalid',
        },
      ]),
    ).toThrow(ProductFailure);
    expect(repository.snapshot(created.mission.id).assignments).toHaveLength(1);
    expect(repository.listPendingOutbox()).toHaveLength(0);
    opened.db.close();
  });

  it('keeps raw runtime events for audit while bounding Mission snapshots', () => {
    const opened = open();
    seedWorkspace(opened.db);
    const repository = new MissionRepository(opened.db);
    const created = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Bounded events',
      goal: 'Keep the renderer responsive',
      lead: {
        principalId: 'lead',
        kind: 'managed_agent',
        displayName: 'Lead',
        runtimeSessionId: 'lead-runtime',
        requestedRuntime: 'managed',
      },
    });
    const attempt = created.attempts[0]!;
    const runtime = repository.upsertRuntimeSession({
      id: `runtime:${attempt.id}`,
      attemptId: attempt.id,
      provider: 'claude',
      transport: 'acp',
      state: 'RUNNING',
      cwd: '/repo',
    });
    const rawOutput = 'x'.repeat(256 * 1024);
    repository.appendRuntimeEvent(runtime.id, attempt.id, 'acp.tool_call_update', { rawOutput });

    expect(repository.listRuntimeEvents(created.mission.id)[0]?.payload.rawOutput).toBe(rawOutput);
    const snapshot = repository.snapshot(created.mission.id);
    expect(snapshot.runtimeEvents[0]?.payload).toMatchObject({
      truncated: true,
      originalBytes: expect.any(Number),
    });
    expect(Buffer.byteLength(JSON.stringify(snapshot.runtimeEvents))).toBeLessThan(16 * 1024);
    opened.db.close();
  });

  it('persists A → B → D recursive delegation without per-Agent grants', () => {
    const opened = open();
    seedWorkspace(opened.db);
    const repository = new MissionRepository(opened.db, () => new Date('2026-07-30T00:00:00.000Z'));
    const created = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Ship settings',
      goal: 'Ship settings with tests',
      lead: {
        principalId: 'principal-a',
        kind: 'external_agent',
        provider: 'claude',
        displayName: 'Claude lead',
        runtimeSessionId: 'runtime-a',
        terminalId: 'term-a',
        requestedRuntime: 'claude',
      },
    });
    const lead = created.assignments[0]!;
    const b = repository.delegate({
      missionId: created.mission.id,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: 'principal-a',
      goal: 'Implement persistence',
      acceptanceCriteria: ['tests pass'],
      requestedRuntime: 'codex',
      workMode: 'isolated-write',
      reason: 'parallel data layer',
      idempotencyKey: 'settings-data-v1',
    });
    const duplicate = repository.delegate({
      missionId: created.mission.id,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: 'principal-a',
      goal: 'ignored duplicate text',
      acceptanceCriteria: [],
      requestedRuntime: 'codex',
      workMode: 'isolated-write',
      reason: 'retry',
      idempotencyKey: 'settings-data-v1',
    });
    expect(duplicate.reused).toBe(true);
    expect(duplicate.assignment.id).toBe(b.assignment.id);
    repository.bindRuntime(b.assignment.id, b.attempt.id, {
      runtimeSessionId: 'runtime-b',
      terminalId: 'term-b',
    });

    const d = repository.delegate({
      missionId: created.mission.id,
      supervisorAssignmentId: b.assignment.id,
      actorPrincipalId: b.assignment.assigneePrincipalId,
      goal: 'Investigate migration failure',
      acceptanceCriteria: ['root cause documented'],
      requestedRuntime: 'claude',
      workMode: 'read-only',
      reason: 'bounded independent investigation',
      idempotencyKey: 'migration-investigation-v1',
    });
    expect(d.assignment.supervisorAssignmentId).toBe(b.assignment.id);
    expect(repository.snapshot(created.mission.id).assignments).toHaveLength(3);
    const promoted = repository.promoteLead(
      created.mission.id,
      d.assignment.id,
      null,
      'recover supervision through D',
    );
    expect(promoted.mission.leadAssignmentId).toBe(d.assignment.id);
    expect(
      promoted.assignments.find((assignment) => assignment.id === lead.id)?.supervisorAssignmentId,
    ).toBe(d.assignment.id);
    expect(
      promoted.assignments.filter((assignment) => assignment.supervisorAssignmentId === null),
    ).toHaveLength(1);
    expect(
      opened.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delegation_grants'",
        )
        .get(),
    ).toBeUndefined();
    expect(repository.listPendingOutbox()).toHaveLength(2);
    opened.db.close();
  });

  it('surfaces shared-write ambiguity and retains file, verification, and report evidence', () => {
    const opened = open();
    seedWorkspace(opened.db);
    const repository = new MissionRepository(opened.db);
    const mission = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Evidence',
      goal: 'Evidence',
      lead: {
        principalId: 'p-lead',
        kind: 'managed_agent',
        displayName: 'Lead',
        runtimeSessionId: 'runtime-lead',
        requestedRuntime: 'managed',
      },
    });
    const child = repository.delegate({
      missionId: mission.mission.id,
      supervisorAssignmentId: mission.assignments[0]!.id,
      actorPrincipalId: 'p-lead',
      goal: 'Write shared source',
      acceptanceCriteria: [],
      requestedRuntime: 'managed',
      workMode: 'shared-write',
      writeScope: ['src'],
      reason: 'integration work',
      idempotencyKey: 'shared-writer',
    });
    repository.bindRuntime(child.assignment.id, child.attempt.id, {
      runtimeSessionId: 'runtime-child',
    });
    repository.completeAttempt({
      attemptId: child.attempt.id,
      principalId: child.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'done',
      artifacts: [{ kind: 'report', label: 'Review', reference: { uri: 'mission://review' } }],
      filesModified: ['src/index.ts'],
      verification: [{ id: 'verify-1', label: 'Unit tests', state: 'passed', exitCode: 0 }],
    });

    const snapshot = repository.snapshot(mission.mission.id);
    expect(snapshot.messages.find((message) => message.subject.includes('Shared-write'))).toEqual(
      expect.objectContaining({ type: 'escalation', priority: 'high' }),
    );
    expect(snapshot.artifacts.map((artifact) => [artifact.kind, artifact.label])).toEqual([
      ['report', 'Review'],
      ['file-change', 'src/index.ts'],
      ['verification', 'Unit tests'],
    ]);
    expect(() => repository.pauseAssignment(child.assignment.id, true, null)).toThrowError(
      ProductFailure,
    );
    opened.db.close();
  });

  it('rejects cross-Mission dependencies and rolls back the whole delegate operation', () => {
    const opened = open();
    seedWorkspace(opened.db);
    const repository = new MissionRepository(opened.db);
    const first = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'First',
      goal: 'First',
      lead: {
        principalId: 'p-1',
        kind: 'managed_agent',
        displayName: 'A',
        runtimeSessionId: 'runtime-1',
        requestedRuntime: 'managed',
      },
    });
    const second = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Second',
      goal: 'Second',
      lead: {
        principalId: 'p-2',
        kind: 'managed_agent',
        displayName: 'B',
        runtimeSessionId: 'runtime-2',
        requestedRuntime: 'managed',
      },
    });
    expect(() =>
      repository.delegate({
        missionId: first.mission.id,
        supervisorAssignmentId: first.assignments[0]!.id,
        actorPrincipalId: 'p-1',
        goal: 'Bad dependency',
        acceptanceCriteria: [],
        dependencies: [second.tasks[0]!.id],
        requestedRuntime: 'managed',
        workMode: 'read-only',
        reason: 'test',
        idempotencyKey: 'bad-cross-mission',
      }),
    ).toThrowError(ProductFailure);
    expect(repository.snapshot(first.mission.id).assignments).toHaveLength(1);
    opened.db.close();
  });

  it('rehydrates a Mission and unfinished outbox after a database reopen', () => {
    const first = open();
    seedWorkspace(first.db);
    const repository = new MissionRepository(first.db);
    const mission = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Recover me',
      goal: 'Recover me',
      lead: {
        principalId: 'p-a',
        kind: 'external_agent',
        provider: 'claude',
        displayName: 'A',
        runtimeSessionId: 'runtime-a',
        requestedRuntime: 'claude',
      },
    });
    repository.delegate({
      missionId: mission.mission.id,
      supervisorAssignmentId: mission.assignments[0]!.id,
      actorPrincipalId: 'p-a',
      goal: 'Child',
      acceptanceCriteria: [],
      requestedRuntime: 'codex',
      workMode: 'read-only',
      reason: 'recovery test',
      idempotencyKey: 'recover-child',
    });
    const outbox = repository.listPendingOutbox()[0]!;
    expect(repository.markOutboxProcessing(outbox.id)).toBe(true);
    first.db.close();

    const reopened = open();
    const recovered = new MissionRepository(reopened.db);
    expect(recovered.listRecoverableMissions().map((row) => row.id)).toContain(mission.mission.id);
    expect(recovered.recoverInterruptedOutbox()).toBe(1);
    expect(recovered.listPendingOutbox()).toHaveLength(1);
    expect(recovered.snapshot(mission.mission.id).assignments).toHaveLength(2);
    reopened.db.close();
  });

  it('lists recent terminal Missions for the product Mission Center', () => {
    const opened = open();
    seedWorkspace(opened.db);
    let now = new Date('2026-07-30T01:00:00.000Z');
    const repository = new MissionRepository(opened.db, () => now);
    const first = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Accepted history',
      goal: 'Keep completed evidence visible',
      lead: {
        principalId: 'history-a',
        kind: 'managed_agent',
        displayName: 'History A',
        runtimeSessionId: 'history-runtime-a',
        requestedRuntime: 'managed',
      },
    });
    repository.setMissionState(first.mission.id, 'CANCELLED', 'user', 'test history');
    now = new Date('2026-07-30T02:00:00.000Z');
    const second = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Current work',
      goal: 'Show current work first',
      lead: {
        principalId: 'history-b',
        kind: 'managed_agent',
        displayName: 'History B',
        runtimeSessionId: 'history-runtime-b',
        requestedRuntime: 'managed',
      },
    });

    expect(repository.listMissions().map((mission) => mission.id)).toEqual([
      second.mission.id,
      first.mission.id,
    ]);
    expect(repository.listMissions(1).map((mission) => mission.id)).toEqual([second.mission.id]);
    expect(repository.listRecoverableMissions().map((mission) => mission.id)).not.toContain(
      first.mission.id,
    );
    opened.db.close();
  });

  it('reopens a review-ready Lead with a durable revision Attempt', () => {
    const opened = open();
    seedWorkspace(opened.db);
    const repository = new MissionRepository(opened.db);
    const created = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Review loop',
      goal: 'Meet the user expectation',
      acceptanceCriteria: ['user accepts the result'],
      lead: {
        principalId: 'revision-lead',
        kind: 'managed_agent',
        displayName: 'Revision Lead',
        runtimeSessionId: 'revision-runtime-1',
        requestedRuntime: 'managed',
      },
    });
    const lead = created.assignments[0]!;
    repository.completeAttempt({
      attemptId: created.attempts[0]!.id,
      principalId: lead.assigneePrincipalId,
      outcome: 'success',
      summary: 'First result',
    });
    expect(repository.snapshot(created.mission.id).mission.state).toBe('VERIFYING');

    const revision = repository.requestRevision({
      missionId: created.mission.id,
      actorPrincipalId: 'user',
      feedback: 'Add the missing recovery test.',
      idempotencyKey: 'revision-request-1',
    });
    expect(revision.reused).toBe(false);
    expect(revision.assignment.id).toBe(lead.id);
    expect(revision.assignment.state).toBe('PENDING');
    expect(revision.attempt.ordinal).toBe(2);
    expect(revision.attempt.state).toBe('PLANNED');
    const snapshot = repository.snapshot(created.mission.id);
    expect(snapshot.mission.state).toBe('RUNNING');
    expect(snapshot.tasks[0]).toMatchObject({ state: 'READY', result: null });
    expect(snapshot.tasks[0]!.goal).toContain('Add the missing recovery test.');
    expect(snapshot.messages.at(-1)).toMatchObject({
      type: 'assignment',
      subject: 'User requested changes',
      body: 'Add the missing recovery test.',
    });

    const duplicate = repository.requestRevision({
      missionId: created.mission.id,
      actorPrincipalId: 'user',
      feedback: 'This retry must not create another Attempt.',
      idempotencyKey: 'revision-request-1',
    });
    expect(duplicate.reused).toBe(true);
    expect(repository.snapshot(created.mission.id).attempts).toHaveLength(2);
    opened.db.close();
  });

  it('suppresses a stale completion after retry and accepts only the active Attempt', () => {
    const opened = open();
    seedWorkspace(opened.db);
    const repository = new MissionRepository(opened.db);
    const mission = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Retry',
      goal: 'Retry',
      lead: {
        principalId: 'p-a',
        kind: 'managed_agent',
        displayName: 'A',
        runtimeSessionId: 'runtime-a',
        requestedRuntime: 'managed',
      },
    });
    const child = repository.delegate({
      missionId: mission.mission.id,
      supervisorAssignmentId: mission.assignments[0]!.id,
      actorPrincipalId: 'p-a',
      goal: 'Child',
      acceptanceCriteria: [],
      requestedRuntime: 'managed',
      workMode: 'read-only',
      reason: 'test',
      idempotencyKey: 'retry-child',
    });
    repository.bindRuntime(child.assignment.id, child.attempt.id, {
      runtimeSessionId: 'runtime-b1',
    });
    repository.failAttemptFromRuntime(child.attempt.id, 'crashed', { message: 'gone' });
    const retry = repository.createRetry(child.assignment.id);
    repository.bindRuntime(child.assignment.id, retry.id, { runtimeSessionId: 'runtime-b2' });

    const stale = repository.completeAttempt({
      attemptId: child.attempt.id,
      principalId: child.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'late result',
    });
    expect(stale.action).toBe('suppressed');
    if (stale.action === 'suppressed') expect(stale.reason).toBe('inactive_attempt');
    expect(
      repository.snapshot(mission.mission.id).tasks.find((row) => row.id === child.task.id)?.state,
    ).toBe('RUNNING');

    const accepted = repository.completeAttempt({
      attemptId: retry.id,
      principalId: child.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'current result',
    });
    expect(accepted.action).toBe('accepted');
    expect(repository.getAttempt(retry.id)?.state).toBe('SUCCEEDED');
    const messages = repository.snapshot(mission.mission.id).messages;
    expect(messages.find((message) => message.body === 'late result')?.suppressionReason).toBe(
      'inactive_attempt',
    );
    opened.db.close();
  });

  it('promotes a blocked dependent task only after all dependencies complete', () => {
    const opened = open();
    seedWorkspace(opened.db);
    const repository = new MissionRepository(opened.db);
    const mission = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'DAG',
      goal: 'DAG',
      lead: {
        principalId: 'p-a',
        kind: 'managed_agent',
        displayName: 'A',
        runtimeSessionId: 'runtime-a',
        requestedRuntime: 'managed',
      },
    });
    const lead = mission.assignments[0]!;
    const first = repository.delegate({
      missionId: mission.mission.id,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: 'p-a',
      goal: 'First',
      acceptanceCriteria: [],
      requestedRuntime: 'managed',
      workMode: 'read-only',
      reason: 'first',
      idempotencyKey: 'dag-first',
    });
    const dependent = repository.delegate({
      missionId: mission.mission.id,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: 'p-a',
      goal: 'Dependent',
      acceptanceCriteria: [],
      dependencies: [first.task.id],
      requestedRuntime: 'managed',
      workMode: 'read-only',
      reason: 'dependent',
      idempotencyKey: 'dag-dependent',
    });
    expect(dependent.task.state).toBe('BLOCKED');
    repository.bindRuntime(first.assignment.id, first.attempt.id, {
      runtimeSessionId: 'runtime-first',
    });
    repository.completeAttempt({
      attemptId: first.attempt.id,
      principalId: first.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'done',
    });
    expect(
      repository.snapshot(mission.mission.id).tasks.find((task) => task.id === dependent.task.id)
        ?.state,
    ).toBe('READY');
    opened.db.close();
  });

  it('arms an all-condition continuation atomically across event-before-park and later completion', () => {
    const opened = open();
    seedWorkspace(opened.db);
    const repository = new MissionRepository(opened.db);
    const mission = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Durable continuation',
      goal: 'Wait for both reviewers without polling',
      lead: {
        principalId: 'lead',
        kind: 'managed_agent',
        displayName: 'Lead',
        runtimeSessionId: 'runtime-lead',
        requestedRuntime: 'managed',
      },
    });
    const lead = mission.assignments[0]!;
    const [first, second] = repository.delegateMany(
      ['first', 'second'].map((name) => ({
        missionId: mission.mission.id,
        supervisorAssignmentId: lead.id,
        actorPrincipalId: lead.assigneePrincipalId,
        goal: name,
        acceptanceCriteria: [],
        requestedRuntime: 'managed' as const,
        workMode: 'read-only' as const,
        reason: 'parallel review',
        idempotencyKey: `continuation-${name}`,
      })),
    );
    repository.bindRuntime(first!.assignment.id, first!.attempt.id, {
      runtimeSessionId: 'runtime-first',
    });
    repository.bindRuntime(second!.assignment.id, second!.attempt.id, {
      runtimeSessionId: 'runtime-second',
    });

    // The first event commits before the Lead parks. Registration reconciles
    // current durable state in the same transaction, so this edge is not lost.
    repository.completeAttempt({
      attemptId: first!.attempt.id,
      principalId: first!.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'first done',
    });
    const armed = repository.armContinuation({
      missionId: mission.mission.id,
      ownerAssignmentId: lead.id,
      ownerAttemptId: mission.attempts[0]!.id,
      mode: 'all',
      conditions: [first!, second!].map((child) => ({
        kind: 'assignment_terminal' as const,
        assignmentId: child.assignment.id,
      })),
      reason: 'Both reviews must finish',
      idempotencyKey: 'lead-waits-for-reviews',
    });
    expect(armed.continuation.state).toBe('ARMED');
    expect(armed.targets.map((target) => Boolean(target.satisfiedAt))).toEqual([true, false]);
    expect(repository.getAssignment(lead.id)?.state).toBe('WAITING');
    expect(repository.getAttempt(mission.attempts[0]!.id)?.state).toBe('WAITING');

    repository.rebindActiveRuntime(lead.id, { runtimeSessionId: 'runtime-lead-rebound' });
    expect(repository.getAssignment(lead.id)?.state).toBe('WAITING');
    expect(repository.getAttempt(mission.attempts[0]!.id)?.state).toBe('WAITING');

    const duplicate = repository.armContinuation({
      missionId: mission.mission.id,
      ownerAssignmentId: lead.id,
      ownerAttemptId: mission.attempts[0]!.id,
      mode: 'all',
      conditions: [
        { kind: 'assignment_terminal', assignmentId: first!.assignment.id },
        { kind: 'assignment_terminal', assignmentId: second!.assignment.id },
      ],
      reason: 'Both reviews must finish',
      idempotencyKey: 'lead-waits-for-reviews',
    });
    expect(duplicate.reused).toBe(true);

    repository.completeAttempt({
      attemptId: second!.attempt.id,
      principalId: second!.assignment.assigneePrincipalId,
      outcome: 'failure',
      summary: 'second reported a finding',
    });
    const ready = repository.snapshot(mission.mission.id);
    expect(ready.continuations).toContainEqual(
      expect.objectContaining({ id: armed.continuation.id, state: 'READY' }),
    );
    expect(ready.resumeIntents).toHaveLength(1);
    repository.recoverAndReconcileContinuations();
    expect(repository.listResumeIntents(mission.mission.id)).toHaveLength(1);

    const consumed = repository.consumeContinuation(
      armed.continuation.id,
      lead.id,
      mission.attempts[0]!.id,
    );
    expect(consumed.continuation.state).toBe('CONSUMED');
    expect(consumed.resumeIntent?.state).toBe('ACKNOWLEDGED');
    expect(repository.getAssignment(lead.id)?.state).toBe('ACTIVE');
    expect(repository.getAttempt(mission.attempts[0]!.id)?.state).toBe('RUNNING');
    expect(
      repository.consumeContinuation(armed.continuation.id, lead.id, mission.attempts[0]!.id)
        .reused,
    ).toBe(true);
    opened.db.close();
  });

  it('matches threaded messages after a cursor and resumes on a durable deadline after reopen', () => {
    let now = Date.parse('2026-07-30T12:00:00.000Z');
    const opened = open();
    seedWorkspace(opened.db);
    let repository = new MissionRepository(opened.db, () => new Date(now));
    const mission = repository.createMission({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Message continuation',
      goal: 'Match only the intended answer',
      lead: {
        principalId: 'lead',
        kind: 'managed_agent',
        displayName: 'Lead',
        runtimeSessionId: 'runtime-lead',
        requestedRuntime: 'managed',
      },
    });
    const lead = mission.assignments[0]!;
    const child = repository.delegate({
      missionId: mission.mission.id,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: lead.assigneePrincipalId,
      goal: 'Answer later',
      acceptanceCriteria: [],
      requestedRuntime: 'managed',
      workMode: 'read-only',
      reason: 'thread test',
      idempotencyKey: 'message-child',
    });
    const old = repository.createMessage({
      missionId: mission.mission.id,
      fromAssignmentId: child.assignment.id,
      toAssignmentId: lead.id,
      threadId: 'decision-1',
      type: 'answer',
      subject: 'old answer',
    });
    const messageWait = repository.armContinuation({
      missionId: mission.mission.id,
      ownerAssignmentId: lead.id,
      ownerAttemptId: mission.attempts[0]!.id,
      mode: 'any',
      conditions: [
        {
          kind: 'message',
          fromAssignmentId: child.assignment.id,
          types: ['answer'],
          threadId: 'decision-1',
        },
      ],
      cursorSequence: old.sequence,
      reason: 'Wait for a fresh decision answer',
      idempotencyKey: 'fresh-answer',
    });
    expect(messageWait.continuation.state).toBe('ARMED');
    repository.createMessage({
      missionId: mission.mission.id,
      fromAssignmentId: child.assignment.id,
      toAssignmentId: lead.id,
      threadId: 'other-thread',
      type: 'answer',
      subject: 'irrelevant answer',
    });
    expect(repository.getContinuation(messageWait.continuation.id)?.state).toBe('ARMED');
    repository.createMessage({
      missionId: mission.mission.id,
      fromAssignmentId: child.assignment.id,
      toAssignmentId: lead.id,
      threadId: 'decision-1',
      type: 'answer',
      subject: 'fresh answer',
    });
    expect(repository.getContinuation(messageWait.continuation.id)?.state).toBe('READY');
    repository.consumeContinuation(messageWait.continuation.id, lead.id, mission.attempts[0]!.id);

    const deadlineAt = new Date(now + 5_000).toISOString();
    const deadlineWait = repository.armContinuation({
      missionId: mission.mission.id,
      ownerAssignmentId: lead.id,
      ownerAttemptId: mission.attempts[0]!.id,
      mode: 'all',
      conditions: [
        {
          kind: 'assignment_terminal',
          assignmentId: child.assignment.id,
          states: ['COMPLETED'],
        },
      ],
      deadlineAt,
      reason: 'Do not wait forever for the child',
      idempotencyKey: 'deadline-wait',
    });
    expect(deadlineWait.continuation.state).toBe('ARMED');
    opened.db.close();

    now += 10_000;
    const reopened = open();
    repository = new MissionRepository(reopened.db, () => new Date(now));
    const recovery = repository.recoverAndReconcileContinuations();
    expect(recovery.ready).toBe(1);
    const resumed = repository.getContinuation(deadlineWait.continuation.id);
    expect(resumed?.state).toBe('READY');
    expect(repository.listResumeIntents(mission.mission.id).at(-1)?.payload).toMatchObject({
      trigger: { kind: 'deadline', timedOut: true },
    });
    reopened.db.close();
  });
});
