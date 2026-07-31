import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../packages/persistence/src/database';
import { MIGRATIONS } from '../../packages/persistence/src/migrations';
import { MissionRepository } from '../../packages/persistence/src/mission-repository';
import { createTsSmallFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

test('Mission Experience persists recursive work and supports decisions, evidence, and acceptance', async () => {
  test.setTimeout(90_000);
  const fixture = createTsSmallFixture();
  const first = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  let taskId = '';
  let createdMissionId = '';
  try {
    await first.page.getByTestId('surface-home').click();
    await first.page.getByTestId('home-advanced-toggle').click();
    await first.page.getByTestId('home-adv-title').fill('Mission V2 release');
    await first.page.getByTestId('home-intent').fill('[scenario:ask-basic] prepare a release');
    await first.page.getByTestId('home-mode-ask').click();
    await first.page.getByTestId('home-submit').click();
    await expect(first.page.getByTestId('task-room')).toBeVisible();
    taskId = (await first.page.getByTestId('task-room').getAttribute('data-task-id')) ?? '';
    expect(taskId).not.toBe('');
    await expect(first.page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
      timeout: 20_000,
    });
  } finally {
    await first.app.close();
  }

  const database = openDatabase({
    file: join(first.userDataDir, 'app.db'),
    backupDir: join(first.userDataDir, 'backups'),
    migrations: MIGRATIONS,
  });
  try {
    const workspace = database.db
      .prepare('SELECT workspace_id AS id FROM tasks WHERE id = ?')
      .get(taskId) as { id: string } | undefined;
    expect(workspace).toBeTruthy();
    database.db.prepare("UPDATE tasks SET state = 'AWAITING_USER' WHERE id = ?").run(taskId);

    const repository = new MissionRepository(database.db);
    const created = repository.createMission({
      workspaceId: workspace!.id,
      workspaceRoot: fixture,
      originConversationTaskId: taskId,
      title: 'Ship Mission Orchestration V2',
      goal: 'Deliver a recursive, durable Agent team and verify the release.',
      acceptanceCriteria: ['recursive delegation works', 'the user can accept the Mission'],
      lead: {
        principalId: 'e2e-principal-a',
        kind: 'managed_agent',
        displayName: 'Lead agent A',
        runtimeSessionId: taskId,
        requestedRuntime: 'managed',
      },
    });
    createdMissionId = created.mission.id;
    const lead = created.assignments[0]!;
    const leadAttempt = created.attempts[0]!;
    const b = repository.delegate({
      missionId: created.mission.id,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: lead.assigneePrincipalId,
      title: 'Persistence specialist B',
      goal: 'Implement the durable Mission repository.',
      acceptanceCriteria: ['migration and repository tests pass'],
      expectedArtifacts: ['migration', 'repository tests'],
      requestedRuntime: 'codex',
      workMode: 'isolated-write',
      reason: 'Own the persistence workstream.',
      idempotencyKey: 'e2e-persistence-b',
    });
    repository.bindRuntime(b.assignment.id, b.attempt.id, {
      runtimeSessionId: 'runtime-b',
      terminalId: 'terminal-b',
    });
    const d = repository.delegate({
      missionId: created.mission.id,
      supervisorAssignmentId: b.assignment.id,
      actorPrincipalId: b.assignment.assigneePrincipalId,
      title: 'Migration investigator D',
      goal: 'Review the schema and report migration risks to B.',
      acceptanceCriteria: ['schema risks are documented'],
      expectedArtifacts: ['migration review'],
      requestedRuntime: 'claude',
      workMode: 'read-only',
      reason: 'B needs a bounded independent schema review.',
      idempotencyKey: 'e2e-investigator-d',
    });
    repository.bindRuntime(d.assignment.id, d.attempt.id, {
      runtimeSessionId: 'runtime-d',
      terminalId: 'terminal-d',
    });
    const dRuntime = repository.upsertRuntimeSession({
      id: `runtime:${d.attempt.id}`,
      attemptId: d.attempt.id,
      provider: 'claude',
      transport: 'acp',
      externalSessionId: 'claude-session-d',
      processKey: 'claude:fixture-process',
      state: 'WAITING',
      cwd: fixture,
      capabilities: { loadSession: true },
    });
    repository.appendRuntimeEvent(dRuntime.id, d.attempt.id, 'acp.agent_message_chunk', {
      text: 'review complete',
    });
    for (const outbox of repository.listPendingOutbox()) repository.completeOutbox(outbox.id);

    repository.recordProgress({
      attemptId: b.attempt.id,
      principalId: b.assignment.assigneePrincipalId,
      phase: 'implementation',
      summary: 'Repository schema and lifecycle are implemented.',
      completed: ['schema', 'state transitions'],
      remaining: ['migration review'],
    });
    repository.createMessage({
      missionId: created.mission.id,
      fromAssignmentId: d.assignment.id,
      toAssignmentId: b.assignment.id,
      threadId: 'schema-review',
      attemptId: d.attempt.id,
      type: 'question',
      priority: 'high',
      subject: 'Schema ownership check',
      body: 'Should Assignment or Attempt own the runtime session?',
    });
    repository.completeAttempt({
      attemptId: d.attempt.id,
      principalId: d.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'Schema review complete; Attempt owns replaceable runtime identity.',
      artifacts: [
        {
          kind: 'report',
          label: 'Migration review',
          reference: { uri: 'mission://migration-review' },
        },
      ],
      verification: [{ id: 'verify-schema', label: 'Schema checks', state: 'passed' }],
      filesModified: ['packages/persistence/src/migrations.ts'],
    });
    repository.completeAttempt({
      attemptId: b.attempt.id,
      principalId: b.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'Durable Mission repository implemented and verified.',
    });
    repository.completeAttempt({
      attemptId: leadAttempt.id,
      principalId: lead.assigneePrincipalId,
      outcome: 'success',
      summary: 'Mission V2 is ready for user acceptance.',
    });
    expect(repository.snapshot(created.mission.id).mission.state).toBe('VERIFYING');
  } finally {
    database.db.close();
  }

  const second = await launchApp({
    userDataDir: first.userDataDir,
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  const pageErrors: string[] = [];
  second.page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await expect(second.page.getByTestId('rail-view-missions')).toBeVisible({ timeout: 15_000 });
    await second.page.getByTestId('rail-view-missions').click();
    await expect(second.page.getByTestId('mission-center')).toBeVisible();
    await expect(second.page.getByTestId(`mission-center-card-${createdMissionId}`)).toContainText(
      'Ship Mission Orchestration V2',
    );
    await second.page.getByTestId('rail-view-sessions').click();
    await second.page.getByTestId(`home-task-${taskId}`).click();
    const strip = second.page.getByTestId('mission-status-strip');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('Ship Mission Orchestration V2');
    await expect(strip).toContainText('3 of 3 work items done');
    await strip.click();

    const mission = second.page.getByTestId('mission-view');
    await expect(mission).toBeVisible();
    await expect(mission).toContainText('Ship Mission Orchestration V2');
    await expect(second.page.getByTestId('mission-state')).toHaveText('Ready to review');
    await expect(second.page.getByTestId('mission-results')).toBeVisible();

    await second.page.getByTestId('mission-tab-work').click();
    const workMap = second.page.getByTestId('mission-work-map');
    await expect(workMap.locator('.mission-work-card')).toHaveCount(3);
    await expect(workMap).toContainText('Lead agent A');
    await expect(workMap).toContainText('Persistence specialist B');
    await expect(workMap).toContainText('Migration investigator D');
    await expect(workMap.locator('.mission-work-children .mission-work-children')).toHaveCount(1);
    await expect(workMap).toContainText('Review the schema and report migration risks to B.');

    const decisions = second.page.getByTestId('mission-decisions');
    await expect(decisions).toContainText('Schema ownership check');
    await decisions.getByRole('button', { name: 'Respond' }).click();
    await decisions
      .getByPlaceholder('Give the team a clear decision…')
      .fill('Attempt owns runtime identity. Continue with that model.');
    await decisions.getByRole('button', { name: 'Send decision' }).click();
    await expect(decisions).not.toBeVisible();

    await workMap.getByRole('button', { name: /Migration investigator D/ }).click();
    const details = second.page.getByTestId('mission-work-detail');
    await expect(details).toContainText('Schema review complete');
    await expect(second.page.getByTestId('mission-artifacts')).toContainText('Migration review');
    await expect(second.page.getByTestId('mission-artifacts')).toContainText('Schema checks');
    await expect(second.page.getByTestId('mission-artifacts')).toContainText(
      'packages/persistence/src/migrations.ts',
    );
    await details.getByText('Advanced controls and runtime details').click();
    await expect(details).toContainText('SUCCEEDED');
    await expect(details).toContainText('runtime-d');
    await expect(details).toContainText('ACP · WAITING');
    await expect(details).toContainText('claude:fixture-process');
    await expect(details).toContainText('acp.agent_message_chunk');
    await second.page.screenshot({ path: '/tmp/charter-mission-workbench.png' });

    await second.page.getByTestId('mission-tab-results').click();
    await expect(second.page.getByTestId('mission-results')).toContainText('Schema checks');
    await expect(second.page.getByTestId('mission-results')).toContainText(
      'packages/persistence/src/migrations.ts',
    );
    await second.page.setViewportSize({ width: 780, height: 720 });
    const missionBox = await mission.boundingBox();
    expect(missionBox).not.toBeNull();
    expect(missionBox!.x).toBeGreaterThanOrEqual(0);
    expect(missionBox!.x + missionBox!.width).toBeLessThanOrEqual(780);
    await second.page.screenshot({ path: '/tmp/charter-mission-results-narrow.png' });
    await second.page.getByTestId('mission-finish').click();
    await expect(second.page.getByTestId('mission-state')).toHaveText('Accepted');
    await expect(second.page.getByTestId('mission-results')).toContainText(
      'This Mission is complete.',
    );
    const persisted = await second.page.evaluate(async (originTaskId) => {
      return window.product.rpc['mission.forConversation']!({ taskId: originTaskId });
    }, taskId);
    expect(persisted.ok).toBe(true);
    expect(
      (persisted.data as { snapshot: { mission: { state: string } } }).snapshot.mission.state,
    ).toBe('COMPLETED');
    expect(pageErrors).toEqual([]);
  } finally {
    await second.app.close();
    rmSync(first.userDataDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
