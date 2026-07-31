import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { openDatabase } from '../../packages/persistence/src/database';
import { MIGRATIONS } from '../../packages/persistence/src/migrations';
import { MissionRepository } from '../../packages/persistence/src/mission-repository';
import { createTsSmallFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

test('Mission UI explains a durable continuation from waiting through delivery and resume', async () => {
  test.setTimeout(120_000);
  const fixture = createTsSmallFixture();
  const seed = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  let taskId = '';
  let missionId = '';
  let leadAssignmentId = '';
  let leadAttemptId = '';
  let childAssignmentId = '';
  let childAttemptId = '';
  let continuationId = '';
  try {
    await seed.page.getByTestId('surface-home').click();
    await seed.page.getByTestId('home-advanced-toggle').click();
    await seed.page.getByTestId('home-adv-title').fill('Continuation UI seed');
    await seed.page.getByTestId('home-intent').fill('[scenario:ask-basic] create a seed session');
    await seed.page.getByTestId('home-mode-ask').click();
    await seed.page.getByTestId('home-submit').click();
    await expect(seed.page.getByTestId('task-room')).toBeVisible();
    taskId = (await seed.page.getByTestId('task-room').getAttribute('data-task-id')) ?? '';
    await expect(seed.page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
      timeout: 20_000,
    });
  } finally {
    await seed.app.close();
  }

  const database = openDatabase({
    file: join(seed.userDataDir, 'app.db'),
    backupDir: join(seed.userDataDir, 'backups'),
    migrations: MIGRATIONS,
  });
  try {
    const workspace = database.db
      .prepare('SELECT workspace_id AS id FROM tasks WHERE id = ?')
      .get(taskId) as { id: string };
    database.db.prepare("UPDATE tasks SET state = 'AWAITING_USER' WHERE id = ?").run(taskId);
    const repository = new MissionRepository(database.db);
    const mission = repository.createMission({
      workspaceId: workspace.id,
      workspaceRoot: fixture,
      originConversationTaskId: taskId,
      title: 'Durable continuation UX',
      goal: 'Explain why the Lead is parked and whether its resume was delivered.',
      lead: {
        principalId: 'continuation-lead',
        kind: 'managed_agent',
        displayName: 'Continuation Lead A',
        runtimeSessionId: `managed-task:${taskId}`,
        requestedRuntime: 'managed',
      },
    });
    missionId = mission.mission.id;
    leadAssignmentId = mission.assignments[0]!.id;
    leadAttemptId = mission.attempts[0]!.id;
    const child = repository.delegate({
      missionId,
      supervisorAssignmentId: leadAssignmentId,
      actorPrincipalId: mission.assignments[0]!.assigneePrincipalId,
      title: 'Async reviewer B',
      goal: 'Finish an independent review while A is parked.',
      acceptanceCriteria: ['review result is durable'],
      requestedRuntime: 'managed',
      workMode: 'read-only',
      reason: 'UI continuation acceptance',
      idempotencyKey: 'continuation-ui-child',
    });
    childAssignmentId = child.assignment.id;
    childAttemptId = child.attempt.id;
    repository.bindRuntime(childAssignmentId, childAttemptId, {
      runtimeSessionId: `managed-task:${taskId}`,
    });
    for (const record of repository.listPendingOutbox()) repository.completeOutbox(record.id);
    const parked = repository.armContinuation({
      missionId,
      ownerAssignmentId: leadAssignmentId,
      ownerAttemptId: leadAttemptId,
      mode: 'all',
      conditions: [{ kind: 'assignment_terminal', assignmentId: childAssignmentId }],
      deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      reason: 'Waiting for Async reviewer B before integration',
      idempotencyKey: 'continuation-ui-lead',
    });
    continuationId = parked.continuation.id;
  } finally {
    database.db.close();
  }

  const openMission = async () => {
    const launched = await launchApp({
      userDataDir: seed.userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    await launched.page.getByTestId('rail-view-missions').click();
    await launched.page.getByTestId(`mission-center-card-${missionId}`).click();
    await launched.page.getByTestId('mission-tab-work').click();
    await launched.page.getByTestId('mission-view-outline').click();
    return launched;
  };

  const waiting = await openMission();
  const pageErrors: string[] = [];
  waiting.page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    const waitState = waiting.page.getByTestId(`mission-wait-${leadAssignmentId}`);
    await expect(waitState).toContainText('Waiting: 0/1 conditions');
    await waiting.page
      .getByTestId('mission-work-map')
      .getByRole('button', { name: /Continuation Lead A/ })
      .click();
    const status = waiting.page.getByTestId('mission-continuation-status');
    await expect(status).toContainText('Waiting durably');
    await expect(status).toContainText('Waiting for Async reviewer B before integration');
    await expect(status).toContainText('0/1 conditions matched');
    await waiting.page.screenshot({ path: '/tmp/charter-continuation-waiting-wide.png' });
    await waiting.page.setViewportSize({ width: 860, height: 720 });
    await expect(status).toBeVisible();
    await waiting.page.waitForTimeout(300);
    await waiting.page.screenshot({ path: '/tmp/charter-continuation-waiting-narrow.png' });
    const snapshot = await waiting.page.evaluate(async (id) => {
      const result = (await window.product.rpc['mission.list']!({ limit: 50 })) as
        | { ok: true; data: { missions: MissionSnapshotDto[] } }
        | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'mission.list failed');
      const snapshot = result.data.missions.find((item) => item.mission.id === id);
      if (!snapshot) throw new Error('Mission snapshot missing');
      return snapshot;
    }, missionId);
    expect(snapshot.continuations).toContainEqual(
      expect.objectContaining({ id: continuationId, state: 'ARMED' }),
    );
    expect(pageErrors).toEqual([]);
  } finally {
    await waiting.app.close();
  }

  const readyDatabase = openDatabase({
    file: join(seed.userDataDir, 'app.db'),
    backupDir: join(seed.userDataDir, 'backups'),
    migrations: MIGRATIONS,
  });
  try {
    const repository = new MissionRepository(readyDatabase.db);
    const child = repository.getAssignment(childAssignmentId)!;
    repository.completeAttempt({
      attemptId: childAttemptId,
      principalId: child.assigneePrincipalId,
      outcome: 'success',
      summary: 'Async review complete',
    });
    const intent = repository.listResumeIntents(missionId)[0]!;
    expect(repository.markResumeIntentProcessing(intent.id, `managed-task:${taskId}`)).toBe(true);
    repository.markResumeIntentDelivered(intent.id);
  } finally {
    readyDatabase.db.close();
  }

  const delivered = await openMission();
  try {
    await expect(delivered.page.getByTestId(`mission-wait-${leadAssignmentId}`)).toContainText(
      'Resume delivered to Agent',
    );
    await delivered.page
      .getByTestId('mission-work-map')
      .getByRole('button', { name: /Continuation Lead A/ })
      .click();
    await expect(delivered.page.getByTestId('mission-continuation-status')).toContainText(
      'Resume delivered',
    );
    await delivered.page.screenshot({ path: '/tmp/charter-continuation-delivered.png' });
  } finally {
    await delivered.app.close();
  }

  const consumeDatabase = openDatabase({
    file: join(seed.userDataDir, 'app.db'),
    backupDir: join(seed.userDataDir, 'backups'),
    migrations: MIGRATIONS,
  });
  try {
    const repository = new MissionRepository(consumeDatabase.db);
    repository.consumeContinuation(continuationId, leadAssignmentId, leadAttemptId);
    expect(repository.getAssignment(leadAssignmentId)?.state).toBe('ACTIVE');
  } finally {
    consumeDatabase.db.close();
  }

  const resumed = await openMission();
  try {
    await expect(resumed.page.getByTestId(`mission-wait-${leadAssignmentId}`)).toHaveCount(0);
    const snapshot = await resumed.page.evaluate(async (id) => {
      const result = (await window.product.rpc['mission.list']!({ limit: 50 })) as
        | { ok: true; data: { missions: MissionSnapshotDto[] } }
        | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'mission.list failed');
      const snapshot = result.data.missions.find((item) => item.mission.id === id);
      if (!snapshot) throw new Error('Mission snapshot missing');
      return snapshot;
    }, missionId);
    expect(snapshot.continuations).toContainEqual(
      expect.objectContaining({ id: continuationId, state: 'CONSUMED' }),
    );
    expect(snapshot.resumeIntents).toContainEqual(
      expect.objectContaining({ continuationId, state: 'ACKNOWLEDGED' }),
    );
  } finally {
    await resumed.app.close();
    rmSync(seed.userDataDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
