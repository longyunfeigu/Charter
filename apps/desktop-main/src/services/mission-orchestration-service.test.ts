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
    db.prepare(
      `INSERT INTO tasks
       (id, workspace_id, title, goal_md, mode, state, model_json, created_at, updated_at)
       VALUES ('task-origin', 'ws-1', 'Promoted work', 'Implement and review independently', 'edit', 'IN_PROGRESS', '{}', ?, ?)`,
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

  it('repairs and publishes a legacy Mission with no live Assignment Sessions on start', () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Repair stopped Mission',
      goal: 'Do not leave a Mission running after every Session closed.',
      principal: { id: 'repair-lead', kind: 'managed_agent', displayName: 'Repair Lead' },
      runtimeSessionId: 'runtime-repair-lead',
      requestedRuntime: 'managed',
    });
    const assignment = adopted.snapshot.assignments[0]!;
    const attempt = adopted.snapshot.attempts[0]!;
    db.prepare("UPDATE execution_attempts SET state = 'CANCELLED' WHERE id = ?").run(attempt.id);
    db.prepare("UPDATE assignments SET state = 'CANCELLED' WHERE id = ?").run(assignment.id);
    db.prepare("UPDATE mission_tasks SET state = 'CANCELLED' WHERE id = ?").run(assignment.taskId);

    const changed = vi.fn();
    service.shutdown();
    service = new MissionOrchestrationService(service.repository, runner, changed);
    service.start();

    expect(service.repository.getMission(adopted.snapshot.mission.id)?.state).toBe('CANCELLED');
    expect(changed).toHaveBeenCalledWith(adopted.snapshot.mission.id);
  });

  it('deletes a settled parent Session as one tree and closes every child runtime', async () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      originConversationTaskId: 'task-origin',
      title: 'Delete the complete Session tree',
      goal: 'A parent Session owns its delegated child Sessions.',
      principal: { id: 'tree-lead', kind: 'managed_agent', displayName: 'Lead' },
      runtimeSessionId: 'runtime-tree-lead',
      requestedRuntime: 'managed',
    });
    const child = service.delegate(adopted.caller, {
      title: 'Child Session',
      goal: 'Finish one bounded child task.',
      acceptanceCriteria: [],
      requestedRuntime: 'managed',
      workMode: 'read-only',
      reason: 'Independent child work.',
      idempotencyKey: 'delete-tree-child',
    });
    service.repository.bindRuntime(child.assignment.id, child.attempt.id, {
      runtimeSessionId: 'runtime-tree-child',
    });
    service.repository.completeAttempt({
      attemptId: child.attempt.id,
      principalId: child.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'Child complete.',
    });
    const lead = adopted.snapshot.assignments[0]!;
    const leadAttempt = adopted.snapshot.attempts[0]!;
    service.repository.completeAttempt({
      attemptId: leadAttempt.id,
      principalId: lead.assigneePrincipalId,
      outcome: 'success',
      summary: 'Parent complete.',
    });

    const deleted = await service.deleteSessionTree(adopted.snapshot.mission.id);

    expect(deleted.mission.state).toBe('CANCELLED');
    expect(deleted.mission.deletedAt).not.toBeNull();
    expect(runtime.cancelled).toEqual(
      expect.arrayContaining([
        {
          runtimeSessionId: 'runtime-tree-lead',
          reason: 'Parent Session tree deleted by user',
        },
        {
          runtimeSessionId: 'runtime-tree-child',
          reason: 'Parent Session tree deleted by user',
        },
      ]),
    );
  });

  it('promotes an ordinary Session and publishes only the complete validated plan', async () => {
    const changed = vi.fn();
    service.shutdown();
    service = new MissionOrchestrationService(service.repository, runner, changed, {
      maxPromotionWorkers: () => 2,
    });
    service.start();

    const promoted = service.promote(
      {
        workspaceId: 'ws-1',
        workspaceRoot: '/repo',
        originConversationTaskId: 'task-origin',
        title: 'Promoted work',
        goal: 'Implement and review independently',
        principal: { id: 'A', kind: 'managed_agent', displayName: 'Lead' },
        runtimeSessionId: 'runtime-A',
        requestedRuntime: 'managed',
      },
      {
        reason: 'Implementation and review are independently verifiable.',
        children: [
          {
            key: 'implementation',
            goal: 'Implement the feature.',
            acceptanceCriteria: ['Tests pass.'],
            requestedRuntime: 'managed',
            workMode: 'read-only',
            reason: 'Bounded implementation work.',
            idempotencyKey: 'promotion-implementation',
          },
          {
            key: 'review',
            dependsOn: ['implementation'],
            goal: 'Review the implementation.',
            acceptanceCriteria: ['Report findings.'],
            requestedRuntime: 'managed',
            workMode: 'read-only',
            reason: 'Independent review reduces risk.',
            idempotencyKey: 'promotion-review',
          },
        ],
        integration: { mode: 'none' },
      },
    );

    expect(promoted.alreadyPromoted).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(promoted.mission.id);
    const snapshot = service.repository.snapshot(promoted.mission.id);
    expect(snapshot.assignments).toHaveLength(3);
    expect(snapshot.dependencies).toHaveLength(1);
    const repeated = service.promote(
      {
        workspaceId: 'ws-1',
        workspaceRoot: '/repo',
        originConversationTaskId: 'task-origin',
        title: 'Promoted work',
        goal: 'Implement and review independently',
        principal: { id: 'A', kind: 'managed_agent', displayName: 'Lead' },
        runtimeSessionId: 'runtime-A',
        requestedRuntime: 'managed',
      },
      {
        reason: 'Retry after a lost response.',
        children: [
          {
            goal: 'This child must not be created twice.',
            acceptanceCriteria: [],
            reason: 'Network retry.',
            idempotencyKey: 'promotion-retry',
          },
        ],
      },
    );
    expect(repeated.alreadyPromoted).toBe(true);
    expect(repeated.delegation).toBeNull();
    expect(service.repository.snapshot(promoted.mission.id).assignments).toHaveLength(3);
    expect(changed).toHaveBeenCalledTimes(1);
    await runner.drain();
    expect(runtime.starts).toHaveLength(1);
  });

  it('rejects an over-budget promotion without creating hidden Mission state', () => {
    service.shutdown();
    service = new MissionOrchestrationService(service.repository, runner, () => {}, {
      maxPromotionWorkers: () => 1,
    });

    expect(() =>
      service.promote(
        {
          workspaceId: 'ws-1',
          workspaceRoot: '/repo',
          originConversationTaskId: 'task-over-budget',
          title: 'Too many workers',
          goal: 'Stay a Session on validation failure',
          principal: { id: 'A', kind: 'managed_agent', displayName: 'Lead' },
          runtimeSessionId: 'runtime-A',
          requestedRuntime: 'managed',
        },
        {
          reason: 'Attempt too much delegation.',
          children: ['one', 'two'].map((key) => ({
            key,
            goal: key,
            acceptanceCriteria: [],
            requestedRuntime: 'managed' as const,
            workMode: 'read-only' as const,
            reason: 'parallel',
            idempotencyKey: `over-budget-${key}`,
          })),
          integration: { mode: 'none' },
        },
      ),
    ).toThrow(/host limit is 1/i);
    expect(service.repository.getMissionForOriginTask('task-over-budget')).toBeNull();
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

  it('returns a compact runtime catalog and rejects unavailable runtimes before mutation', () => {
    service.shutdown();
    service = new MissionOrchestrationService(service.repository, runner, () => {}, {
      runtimeCatalog: () => [
        {
          id: 'managed',
          displayName: 'Charter Agent',
          available: true,
          installed: true,
          transport: 'native',
          capabilities: { worktree: true },
        },
        {
          id: 'claude',
          displayName: 'Claude Code',
          available: false,
          installed: false,
          transport: 'terminal',
          capabilities: { worktree: false },
          unavailableReason: 'Claude Code is not installed.',
        },
      ],
    });
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Runtime preflight',
      goal: 'Fail before probes or partial delegation',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'Lead' },
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    });
    const inspected = service.inspect(adopted.caller, { view: 'compact' });
    expect('compact' in inspected && inspected.compact).toBe(true);
    expect(inspected.runtimeCatalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'managed', available: true }),
        expect.objectContaining({ id: 'claude', available: false }),
      ]),
    );

    expect(() =>
      service.delegateMany(adopted.caller, {
        children: [
          {
            key: 'valid',
            goal: 'Would otherwise be valid',
            acceptanceCriteria: [],
            reason: 'preflight all children',
            idempotencyKey: 'preflight-valid',
          },
          {
            key: 'unavailable',
            goal: 'Cannot start',
            acceptanceCriteria: [],
            requestedRuntime: 'claude',
            reason: 'prove preflight',
            idempotencyKey: 'preflight-unavailable',
          },
        ],
      }),
    ).toThrow(/not installed/i);
    expect(service.repository.snapshot(adopted.snapshot.mission.id).assignments).toHaveLength(1);
  });

  it('chooses truthful automatic work modes and rejects fake external isolation', () => {
    service.shutdown();
    service = new MissionOrchestrationService(service.repository, runner, () => {}, {
      runtimeCatalog: () => [
        {
          id: 'managed',
          displayName: 'Charter Agent',
          available: true,
          installed: true,
          transport: 'native',
          capabilities: { worktree: true },
        },
        {
          id: 'claude',
          displayName: 'Claude Code',
          available: true,
          installed: true,
          transport: 'terminal',
          capabilities: { worktree: false },
        },
      ],
    });
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Work strategy',
      goal: 'Resolve write isolation from actual capabilities',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'Lead' },
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    });
    const managed = service.delegate(adopted.caller, {
      goal: 'Managed isolated change',
      acceptanceCriteria: [],
      reason: 'automatic worktree',
      idempotencyKey: 'auto-managed',
    });
    const external = service.delegate(adopted.caller, {
      goal: 'External scoped change',
      acceptanceCriteria: [],
      requestedRuntime: 'claude',
      writeScope: ['src/ui/**'],
      reason: 'shared visible terminal',
      idempotencyKey: 'auto-claude',
    });
    expect(managed.task.workMode).toBe('isolated-write');
    expect(external.task.workMode).toBe('shared-write');
    expect(() =>
      service.delegate(adopted.caller, {
        goal: 'Unsupported isolation',
        acceptanceCriteria: [],
        requestedRuntime: 'claude',
        workMode: 'isolated-write',
        reason: 'must not pretend a worktree exists',
        idempotencyKey: 'isolated-claude',
      }),
    ).toThrow(/cannot create an isolated Mission worktree/i);
  });

  it('creates a dependency-gated integration Assignment for isolated batch writes', () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Integrated batch',
      goal: 'Implement in parallel and integrate once',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'Lead' },
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    });
    const delegated = service.delegateMany(adopted.caller, {
      children: [
        {
          key: 'frontend',
          goal: 'Implement the UI',
          acceptanceCriteria: ['UI test passes'],
          reason: 'parallel change',
          idempotencyKey: 'integrated-frontend',
        },
        {
          key: 'backend',
          goal: 'Implement the API',
          acceptanceCriteria: ['API test passes'],
          reason: 'parallel change',
          idempotencyKey: 'integrated-backend',
        },
      ],
      integration: { mode: 'auto' },
    });

    expect(delegated.results).toHaveLength(2);
    expect(delegated.integration).not.toBeNull();
    expect(delegated.integration?.task).toMatchObject({
      title: 'Integrate delegated changes',
      state: 'BLOCKED',
      workMode: 'shared-write',
    });
    const snapshot = service.repository.snapshot(adopted.snapshot.mission.id);
    expect(
      snapshot.dependencies.filter(
        (dependency) => dependency.taskId === delegated.integration?.task.id,
      ),
    ).toHaveLength(2);
  });

  it('separates Agent requests from user decisions and enforces hierarchical control', async () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Authority and attention',
      goal: 'Keep team coordination out of the user inbox',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'Lead A' },
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    });
    const { results } = service.delegateMany(adopted.caller, {
      children: ['B', 'C'].map((title) => ({
        title,
        goal: `Do ${title}`,
        acceptanceCriteria: [],
        reason: 'parallel',
        idempotencyKey: `authority-${title}`,
      })),
    });
    await runner.drain();
    const b = results[0]!;
    const c = results[1]!;
    const callerB = service.contextForAssignment(b.assignment.id, 'managed-run');
    const d = service.delegate(callerB, {
      title: 'D',
      goal: 'Review B',
      acceptanceCriteria: [],
      reason: 'nested review',
      idempotencyKey: 'authority-D',
    });
    await runner.drain();
    const callerD = service.contextForAssignment(d.assignment.id, 'managed-run');

    expect(() => service.pause(callerB, c.assignment.id, true)).toThrow(/delegated subtree/i);
    expect(() => service.pause(callerD, c.assignment.id, true)).toThrow(/delegated subtree/i);

    const agentEscalation = service.escalate(callerD, {
      subject: 'Schema ownership',
      body: 'B must choose the schema owner.',
    });
    expect(agentEscalation.request).toMatchObject({
      assignedToAssignmentId: b.assignment.id,
      assignedToPrincipalId: b.assignment.assigneePrincipalId,
      status: 'OPEN',
    });
    expect(() =>
      service.requestDecision(callerB, {
        title: 'Bypass Lead',
        context: 'This should not reach the user.',
        responseType: 'text',
        impact: 'None',
        idempotencyKey: 'not-allowed',
      }),
    ).toThrow(/only the Mission Lead/i);

    const humanDecision = service.requestDecision(adopted.caller, {
      title: 'Choose release window',
      context: 'This is an irreducible business choice.',
      responseType: 'choice',
      options: [
        { id: 'now', label: 'Release now' },
        { id: 'later', label: 'Release later' },
      ],
      recommendation: 'Release now',
      impact: 'The deployment remains paused until a window is selected.',
      idempotencyKey: 'release-window',
    });
    expect(humanDecision.request).toMatchObject({
      assignedToPrincipalId: 'user',
      assignedToAssignmentId: null,
      status: 'OPEN',
    });

    service.resolveRequest(callerB, {
      requestId: agentEscalation.request.id,
      outcome: 'answered',
      body: 'Attempt owns the runtime session.',
      idempotencyKey: 'resolve-schema-owner',
    });
    const userCaller: OrchestrationCallerContext = {
      principalId: 'user',
      runtimeSessionId: 'user',
      missionId: adopted.snapshot.mission.id,
      assignmentId: adopted.caller.assignmentId,
      attemptId: null,
      origin: 'user',
    };
    service.resolveRequest(userCaller, {
      requestId: humanDecision.request.id,
      outcome: 'now',
      body: 'Release now.',
      idempotencyKey: 'resolve-release-window',
    });

    const snapshot = service.repository.snapshot(adopted.snapshot.mission.id);
    expect(snapshot.actionRequests).toHaveLength(2);
    expect(snapshot.actionRequests.every((request) => request.status === 'RESOLVED')).toBe(true);
    expect(snapshot.actionResolutions).toHaveLength(2);
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

  it('keeps a reassigned child behind its unfinished Mission dependencies', async () => {
    const adopted = service.adopt({
      workspaceId: 'ws-1',
      workspaceRoot: '/repo',
      title: 'Dependency-safe handoff',
      goal: 'Do not start replacement work before its input is ready',
      principal: { id: 'A', kind: 'managed_agent', displayName: 'Lead A' },
      runtimeSessionId: 'runtime-A',
      requestedRuntime: 'managed',
    });
    const foundation = service.delegate(adopted.caller, {
      title: 'Foundation contract',
      goal: 'Publish the contract first',
      acceptanceCriteria: [],
      requestedRuntime: 'managed',
      workMode: 'read-only',
      reason: 'The consumer needs this input.',
      idempotencyKey: 'handoff-foundation',
    });
    const consumer = service.delegate(adopted.caller, {
      title: 'Dependent consumer',
      goal: 'Consume the completed contract',
      acceptanceCriteria: [],
      dependencies: [foundation.task.id],
      requestedRuntime: 'managed',
      workMode: 'read-only',
      reason: 'Run only after the foundation.',
      idempotencyKey: 'handoff-consumer',
    });

    const replacement = service.reassign(adopted.caller, {
      assignmentId: consumer.assignment.id,
      assignee: {
        kind: 'managed_agent',
        provider: 'managed',
        displayName: 'Replacement consumer',
      },
      requestedRuntime: 'managed',
      reason: 'The user handed the blocked work to another Agent.',
    });

    expect(service.repository.getAttempt(consumer.attempt.id)?.state).toBe('STALE');
    expect(
      service.repository
        .snapshot(adopted.snapshot.mission.id)
        .tasks.find((task) => task.id === consumer.task.id)?.state,
    ).toBe('BLOCKED');

    await runner.drain();
    expect(runtime.starts.map((start) => start.assignment.id)).toEqual([foundation.assignment.id]);
    expect(service.repository.getAttempt(replacement.attempt.id)?.state).toBe('PLANNED');

    const foundationCaller = service.contextForAssignment(foundation.assignment.id, 'managed-run');
    service.complete(foundationCaller, {
      outcome: 'success',
      summary: 'The contract is ready.',
    });
    await runner.drain();

    expect(service.repository.getAttempt(replacement.attempt.id)?.state).toBe('RUNNING');
    expect(runtime.starts.map((start) => start.assignment.id)).toEqual([
      foundation.assignment.id,
      consumer.assignment.id,
    ]);
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
