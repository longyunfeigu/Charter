import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestrationCallerContext } from '@pi-ide/orchestration-domain';
import { MIGRATIONS, MissionRepository, openDatabase, type SqlDatabase } from '@pi-ide/persistence';
import { MissionOrchestrationService } from './mission-orchestration-service.js';
import { OrchestrationOutboxRunner } from './orchestration-outbox-runner.js';
import {
  MockOrchestrationRuntimeAdapter,
  OrchestrationRuntimeRegistry,
} from './orchestration-runtime-registry.js';

describe('MissionOrchestrationService', () => {
  let dir: string;
  let db: SqlDatabase;
  let service: MissionOrchestrationService;
  let runner: OrchestrationOutboxRunner;
  let runtime: MockOrchestrationRuntimeAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'charter-mission-service-'));
    db = openDatabase({
      file: join(dir, 'state.sqlite'),
      migrations: MIGRATIONS,
      backupDir: join(dir, 'backup'),
    }).db;
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO workspaces
       (id, canonical_path, display_name, last_opened_at, created_at)
       VALUES ('ws-1', '/repo', 'Repo', ?, ?)`,
    ).run(at, at);
    const repository = new MissionRepository(db);
    const registry = new OrchestrationRuntimeRegistry();
    runtime = new MockOrchestrationRuntimeAdapter();
    registry.register(runtime);
    runner = new OrchestrationOutboxRunner(repository, registry, { retryBaseMs: 1 });
    service = new MissionOrchestrationService(repository, runner);
  });

  afterEach(() => {
    service.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs recursive A -> B -> D through the same service and runtime outbox', async () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Ship feature',
      goal: 'Ship feature',
      principal: { id: 'A', kind: 'external_agent', displayName: 'Claude A' },
      runtimeSessionId: 'runtime-A',
      terminalId: 'term-A',
      requestedRuntime: 'claude',
    });
    const b = service.delegate(adopted.caller, {
      goal: 'Implement API',
      acceptanceCriteria: ['API tests pass'],
      requestedRuntime: 'managed',
      workMode: 'isolated-write',
      reason: 'Independent implementation',
      idempotencyKey: 'A:B:api',
    });
    await runner.drain();
    const callerB = service.contextForAssignment(b.assignment.id, 'managed-run');
    expect(callerB.runtimeSessionId).toBe(`mock:${b.attempt.id}`);

    const d = service.delegate(callerB, {
      goal: 'Review API security',
      acceptanceCriteria: ['Findings reported'],
      requestedRuntime: 'managed',
      workMode: 'read-only',
      reason: 'Independent risk review',
      idempotencyKey: 'B:D:review',
    });
    await runner.drain();
    const snapshot = service.inspect(adopted.caller).snapshot;
    expect(snapshot.assignments).toHaveLength(3);
    expect(
      snapshot.assignments.find((item) => item.id === d.assignment.id)?.supervisorAssignmentId,
    ).toBe(b.assignment.id);
    expect(runtime.starts).toHaveLength(2);
  });

  it('delivers blocking structured messages without polling', async () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Mission',
      goal: 'Mission',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'A' },
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    });
    const b = service.delegate(adopted.caller, {
      goal: 'Child',
      acceptanceCriteria: [],
      reason: 'Parallel work',
      idempotencyKey: 'child',
    });
    await runner.drain();
    const callerB = service.contextForAssignment(b.assignment.id, 'managed-run');
    const waiting = service.wait(adopted.caller, {
      types: ['question'],
      timeoutMs: 1_000,
      markRead: true,
    });
    service.message(callerB, {
      toAssignmentId: adopted.caller.assignmentId!,
      type: 'question',
      subject: 'Which API?',
    });
    const messages = await waiting;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.subject).toBe('Which API?');
  });

  it('rings a low-latency runtime doorbell and persists delivery acknowledgement', async () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Doorbell',
      goal: 'Doorbell',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'A' },
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    });
    const b = service.delegate(adopted.caller, {
      goal: 'Child',
      acceptanceCriteria: [],
      reason: 'Doorbell',
      idempotencyKey: 'doorbell-child',
    });
    await runner.drain();
    const message = service.message(adopted.caller, {
      toAssignmentId: b.assignment.id,
      subject: 'New context',
      body: 'Read through sync.',
    });
    await vi.waitFor(() => expect(runtime.delivered).toHaveLength(1));
    expect(runtime.delivered[0]?.text).toContain('orchestration.sync');
    expect(service.repository.snapshot(adopted.caller.missionId!).messageDeliveries).toContainEqual(
      expect.objectContaining({ messageId: message.id, state: 'delivered' }),
    );
  });

  it('supports atomic parallel delegation, threaded ask, sync cursors, and event-first join', async () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Compound',
      goal: 'Compound',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'A' },
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    });
    const { results } = service.delegateMany(adopted.caller, {
      children: ['B', 'C'].map((title) => ({
        title,
        goal: `Do ${title}`,
        acceptanceCriteria: [],
        requestedRuntime: 'managed' as const,
        workMode: 'read-only' as const,
        reason: 'parallel',
        idempotencyKey: `compound-${title}`,
      })),
    });
    await runner.drain();
    expect(runtime.starts).toHaveLength(2);
    const callerB = service.contextForAssignment(results[0]!.assignment.id, 'managed-run');

    const asking = service.ask(adopted.caller, {
      toAssignmentId: results[0]!.assignment.id,
      subject: 'Ready?',
      body: 'Confirm',
      timeoutMs: 1_000,
    });
    const question = service.repository.listInbox(results[0]!.assignment.id, {
      types: ['question'],
    })[0]!;
    service.reply(callerB, { messageId: question.id, body: 'Ready' });
    await expect(asking).resolves.toEqual(
      expect.objectContaining({
        timedOut: false,
        answer: expect.objectContaining({ body: 'Ready' }),
      }),
    );

    const synced = service.sync(adopted.caller, { afterSequence: 0, markObserved: true });
    expect(synced.nextSequence).toBeGreaterThan(0);
    const joining = service.join(adopted.caller, {
      assignmentIds: [results[0]!.assignment.id],
      timeoutMs: 1_000,
    });
    service.complete(callerB, { outcome: 'success', summary: 'Done' });
    await expect(joining).resolves.toEqual(expect.objectContaining({ timedOut: false }));
  });

  it('rejects an impersonated caller and cross-Mission control', async () => {
    const first = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'One',
      goal: 'One',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'A' },
      runtimeSessionId: 'A',
      requestedRuntime: 'managed',
    });
    const second = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Two',
      goal: 'Two',
      principal: { id: 'X', kind: 'managed_agent', displayName: 'X' },
      runtimeSessionId: 'X',
      requestedRuntime: 'managed',
    });
    const forged: OrchestrationCallerContext = { ...first.caller, principalId: 'X' };
    expect(() => service.inspect(forged)).toThrow(/does not own/i);
    expect(() => service.cancel(first.caller, second.caller.assignmentId!, 'nope')).toThrow(
      /outside this Mission/i,
    );
  });

  it('defers blocked runtimes, promotes dependencies, and requires user Mission acceptance', async () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Graph',
      goal: 'Graph',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'A' },
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    });
    const b = service.delegate(adopted.caller, {
      goal: 'Foundation',
      acceptanceCriteria: [],
      reason: 'first',
      idempotencyKey: 'foundation',
    });
    const c = service.delegate(adopted.caller, {
      goal: 'Consumer',
      acceptanceCriteria: [],
      dependencies: [b.task.id],
      reason: 'depends on foundation',
      idempotencyKey: 'consumer',
    });
    await runner.drain();
    expect(service.repository.getAttempt(b.attempt.id)?.state).toBe('RUNNING');
    expect(service.repository.getAttempt(c.attempt.id)?.state).toBe('PLANNED');

    service.complete(service.contextForAssignment(b.assignment.id, 'managed-run'), {
      outcome: 'success',
      summary: 'foundation done',
    });
    await runner.drain();
    expect(service.repository.getAttempt(c.attempt.id)?.state).toBe('RUNNING');
    service.complete(service.contextForAssignment(c.assignment.id, 'managed-run'), {
      outcome: 'success',
      summary: 'consumer done',
    });
    service.complete(adopted.caller, { outcome: 'success', summary: 'lead integration done' });
    expect(service.repository.getMission(adopted.snapshot.mission.id)?.state).toBe('VERIFYING');

    const userCaller: OrchestrationCallerContext = {
      principalId: 'user',
      runtimeSessionId: 'user',
      missionId: adopted.snapshot.mission.id,
      assignmentId: adopted.caller.assignmentId,
      attemptId: null,
      origin: 'user',
    };
    service.requestRevision(
      userCaller,
      adopted.snapshot.mission.id,
      'Add the missing recovery check.',
      'user-revision-1',
    );
    expect(service.repository.getMission(adopted.snapshot.mission.id)?.state).toBe('RUNNING');
    await runner.drain();
    const revisedLead = service.repository.getAssignment(adopted.caller.assignmentId!)!;
    expect(service.repository.getAttempt(revisedLead.activeAttemptId!)?.ordinal).toBe(2);
    service.complete(service.contextForAssignment(revisedLead.id, 'managed-run'), {
      outcome: 'success',
      summary: 'revision done',
    });
    expect(service.repository.getMission(adopted.snapshot.mission.id)?.state).toBe('VERIFYING');

    service.finishMission(userCaller, adopted.snapshot.mission.id, 'completed', 'accepted');
    expect(service.repository.getMission(adopted.snapshot.mission.id)?.state).toBe('COMPLETED');
  });

  it('cancels every active Assignment runtime when the user cancels the Mission', async () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Cancel all',
      goal: 'Cancel all',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'A' },
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    });
    service.delegate(adopted.caller, {
      goal: 'Child',
      acceptanceCriteria: [],
      reason: 'parallel',
      idempotencyKey: 'cancel-child',
    });
    await runner.drain();

    service.finishMission(
      {
        principalId: 'user',
        runtimeSessionId: 'user',
        missionId: adopted.snapshot.mission.id,
        assignmentId: adopted.caller.assignmentId,
        attemptId: null,
        origin: 'user',
      },
      adopted.snapshot.mission.id,
      'cancelled',
      'stop everything',
    );
    await runner.drain();

    const snapshot = service.repository.snapshot(adopted.snapshot.mission.id);
    expect(snapshot.mission.state).toBe('CANCELLED');
    expect(snapshot.assignments.every((assignment) => assignment.state === 'CANCELLED')).toBe(true);
    expect(runtime.cancelled).toHaveLength(2);
  });

  it('steers, pauses, resumes, and reassigns a running child runtime', async () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Runtime controls',
      goal: 'Exercise every work control',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'A' },
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    });
    const child = service.delegate(adopted.caller, {
      goal: 'Controlled work',
      acceptanceCriteria: [],
      requestedRuntime: 'managed',
      reason: 'control test',
      idempotencyKey: 'controlled-child',
    });
    await runner.drain();
    const firstRuntimeId = service.repository.getAttempt(child.attempt.id)?.runtimeSessionId;
    expect(firstRuntimeId).toBe(`mock:${child.attempt.id}`);

    await service.steer(adopted.caller, child.assignment.id, 'Use the revised API.');
    expect(runtime.steered).toEqual([
      { runtimeSessionId: firstRuntimeId, text: 'Use the revised API.' },
    ]);

    service.pause(adopted.caller, child.assignment.id, true);
    await Promise.resolve();
    expect(service.repository.getAssignment(child.assignment.id)?.state).toBe('PAUSED');
    expect(runtime.paused).toEqual([firstRuntimeId]);

    service.pause(adopted.caller, child.assignment.id, false);
    await Promise.resolve();
    expect(service.repository.getAssignment(child.assignment.id)?.state).toBe('ACTIVE');
    expect(runtime.resumed).toEqual([firstRuntimeId]);

    const replacement = service.reassign(adopted.caller, {
      assignmentId: child.assignment.id,
      assignee: {
        kind: 'managed_agent',
        provider: 'managed',
        displayName: 'Replacement B',
      },
      requestedRuntime: 'managed',
      reason: 'The user changed the owner.',
    });
    expect(replacement.attempt.ordinal).toBe(2);
    expect(service.repository.getAttempt(child.attempt.id)?.state).toBe('STALE');
    await runner.drain();

    const current = service.repository.snapshot(adopted.snapshot.mission.id);
    const assignment = current.assignments.find((item) => item.id === child.assignment.id);
    const principal = current.principals.find(
      (item) => item.id === assignment?.assigneePrincipalId,
    );
    expect(principal?.displayName).toBe('Replacement B');
    expect(current.attempts.find((item) => item.id === replacement.attempt.id)?.state).toBe(
      'RUNNING',
    );
    expect(runtime.cancelled).toContainEqual({
      runtimeSessionId: firstRuntimeId,
      reason: 'The user changed the owner.',
    });
    expect(runtime.starts).toHaveLength(2);
  });

  it('parks the Lead turn and automatically resumes the exact Session after child completion', async () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Automatic continuation',
      goal: 'Resume without wait polling',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'A' },
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    });
    const child = service.delegate(adopted.caller, {
      goal: 'Finish asynchronously',
      acceptanceCriteria: [],
      requestedRuntime: 'managed',
      reason: 'continuation test',
      idempotencyKey: 'continuation-child',
    });
    await runner.drain();

    const parked = service.park(adopted.caller, {
      mode: 'all',
      conditions: [{ kind: 'assignment_terminal', assignmentId: child.assignment.id }],
      reason: 'Wait for the child result',
      idempotencyKey: 'lead-parks-on-child',
    });
    expect(parked.continuation.state).toBe('ARMED');
    expect(parked.nextAction).toMatch(/Stop this agent turn/i);
    expect(service.repository.getAssignment(adopted.caller.assignmentId!)?.state).toBe('WAITING');

    service.complete(service.contextForAssignment(child.assignment.id, 'managed-run'), {
      outcome: 'success',
      summary: 'child finished',
    });
    await runner.drain();

    expect(runtime.delivered).toHaveLength(1);
    expect(runtime.delivered[0]).toEqual(
      expect.objectContaining({
        runtimeSessionId: 'runtime-A',
        text: expect.stringContaining('charter orchestration continue'),
      }),
    );
    expect(runtime.delivered[0]?.text).toContain(parked.continuation.id);
    expect(service.repository.getContinuation(parked.continuation.id)?.state).toBe('DELIVERED');

    const resumed = service.continue(adopted.caller, {
      continuationId: parked.continuation.id,
    });
    expect(resumed.continuation.state).toBe('CONSUMED');
    expect(resumed.resumeIntent?.state).toBe('ACKNOWLEDGED');
    expect(resumed.assignments).toContainEqual(
      expect.objectContaining({ id: child.assignment.id, state: 'COMPLETED' }),
    );
    expect(resumed.messages).toContainEqual(
      expect.objectContaining({ fromAssignmentId: child.assignment.id, type: 'completion' }),
    );
    expect(service.repository.getAssignment(adopted.caller.assignmentId!)?.state).toBe('ACTIVE');
    expect(
      service.continue(adopted.caller, { continuationId: parked.continuation.id }).reused,
    ).toBe(true);
  });
});
