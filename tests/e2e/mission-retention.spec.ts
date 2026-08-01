import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../packages/persistence/src/database';
import { MIGRATIONS } from '../../packages/persistence/src/migrations';
import { MissionRepository } from '../../packages/persistence/src/mission-repository';
import { createTsSmallFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

test('Mission History supports recoverable deletion while preserving the origin Session', async () => {
  test.setTimeout(90_000);
  const fixture = createTsSmallFixture();
  const first = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  let taskId = '';
  try {
    await first.page.getByTestId('surface-home').click();
    await first.page.getByTestId('home-advanced-toggle').click();
    await first.page.getByTestId('home-adv-title').fill('Mission retention origin');
    await first.page.getByTestId('home-intent').fill('[scenario:ask-basic] seed Mission history');
    await first.page.getByTestId('home-mode-ask').click();
    await first.page.getByTestId('home-submit').click();
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
  let missionId = '';
  let childAssignmentId = '';
  try {
    const workspace = database.db
      .prepare('SELECT workspace_id AS id FROM tasks WHERE id = ?')
      .get(taskId) as { id: string } | undefined;
    expect(workspace).toBeTruthy();
    const repository = new MissionRepository(database.db);
    const created = repository.createMission({
      workspaceId: workspace!.id,
      workspaceRoot: fixture,
      originConversationTaskId: taskId,
      title: 'Delete me without deleting my Session',
      goal: 'Prove Mission ownership and retention are explicit.',
      lead: {
        principalId: 'retention-lead',
        kind: 'managed_agent',
        displayName: 'Mission Lead',
        runtimeSessionId: `managed-task:${taskId}`,
        requestedRuntime: 'managed',
      },
    });
    missionId = created.mission.id;
    const child = repository.delegate({
      missionId,
      supervisorAssignmentId: created.assignments[0]!.id,
      actorPrincipalId: created.assignments[0]!.assigneePrincipalId,
      title: 'Mission-only child',
      goal: 'Remain in Mission history instead of the Session rail.',
      acceptanceCriteria: [],
      requestedRuntime: 'claude',
      workMode: 'read-only',
      reason: 'retention acceptance',
      idempotencyKey: 'mission-retention-child',
    });
    childAssignmentId = child.assignment.id;
    database.db
      .prepare(
        "UPDATE missions SET state = 'COMPLETED', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      )
      .run(missionId);
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
    // A terminal Mission's assignment graph belongs to Mission History. The
    // origin conversation remains a normal, independently managed Session.
    await expect(second.page.getByTestId(`home-task-${taskId}`)).toBeVisible();
    await expect(
      second.page.getByTestId(`session-mission-${childAssignmentId}`),
    ).not.toBeAttached();

    await second.page.getByTestId('rail-view-missions').click();
    await second.page.getByRole('tab', { name: /History/ }).click();
    await expect(second.page.getByTestId(`mission-rail-${missionId}`)).toBeVisible();
    await second.page.getByTestId(`mission-trash-${missionId}`).click();
    await expect(second.page.getByTestId('mission-delete-dialog')).toContainText(
      'The original Session and every project file remain untouched.',
    );
    await second.page.setViewportSize({ width: 1440, height: 900 });
    await second.page.screenshot({ path: '/tmp/charter-mission-delete-wide.png' });
    await second.page.getByTestId('mission-trash-confirm').click();
    await expect(second.page.getByTestId(`mission-rail-${missionId}`)).not.toBeAttached();

    await second.page.getByTestId('mission-scope-deleted').click();
    await expect(second.page.getByTestId(`mission-rail-${missionId}`)).toContainText(
      'original Session kept',
    );
    await second.page.setViewportSize({ width: 900, height: 760 });
    await second.page.getByTestId('rail-view-missions').click();
    await expect(second.page.getByTestId(`mission-rail-${missionId}`)).toBeVisible();
    await second.page.screenshot({ path: '/tmp/charter-mission-deleted-narrow.png' });
    await second.page.setViewportSize({ width: 1440, height: 900 });
    await second.page.getByTestId(`mission-restore-${missionId}`).click();
    await expect(second.page.getByTestId(`mission-rail-${missionId}`)).not.toBeAttached();

    await second.page.getByRole('tab', { name: /History/ }).click();
    await expect(second.page.getByTestId(`mission-rail-${missionId}`)).toBeVisible();
    await second.page.getByTestId(`mission-trash-${missionId}`).click();
    await second.page.getByTestId('mission-trash-confirm').click();
    await second.page.getByTestId('mission-scope-deleted').click();
    await second.page.getByTestId(`mission-delete-permanent-${missionId}`).click();
    await second.page.getByTestId('mission-delete-permanent-confirm').click();
    await expect(second.page.getByTestId(`mission-rail-${missionId}`)).not.toBeAttached();

    await second.page.getByTestId('rail-view-sessions').click();
    await expect(second.page.getByTestId(`home-task-${taskId}`)).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await second.app.close();
    rmSync(first.userDataDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
