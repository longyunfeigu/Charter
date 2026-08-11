import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../packages/persistence/src/database';
import { MIGRATIONS } from '../../packages/persistence/src/migrations';
import { MissionRepository } from '../../packages/persistence/src/mission-repository';
import { createTsSmallFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

test('deleting a parent Session removes its complete delegated Session tree', async () => {
  test.setTimeout(90_000);
  const fixture = createTsSmallFixture();
  const first = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  let taskId = '';
  try {
    await first.page.getByTestId('surface-home').click();
    await first.page.getByTestId('home-advanced-toggle').click();
    await first.page.getByTestId('home-adv-title').fill('Parent collaboration Session');
    await first.page.getByTestId('home-intent').fill('[scenario:ask-basic] prepare delegation');
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
      title: 'Parent collaboration Session',
      goal: 'Delete the parent and its delegated child as one Session tree.',
      lead: {
        principalId: 'delete-tree-lead',
        kind: 'managed_agent',
        displayName: 'Claude Lead',
        runtimeSessionId: `managed-task:${taskId}`,
        requestedRuntime: 'managed',
      },
    });
    missionId = created.mission.id;
    const lead = created.assignments[0]!;
    const child = repository.delegate({
      missionId,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: lead.assigneePrincipalId,
      title: 'Codex child implementation',
      goal: 'Complete the delegated child task.',
      acceptanceCriteria: [],
      requestedRuntime: 'codex',
      workMode: 'read-only',
      reason: 'Bounded delegated work.',
      idempotencyKey: 'e2e-delete-session-tree-child',
    });
    childAssignmentId = child.assignment.id;
    repository.bindRuntime(child.assignment.id, child.attempt.id, {
      runtimeSessionId: 'terminal:delete-tree-child',
      terminalId: 'delete-tree-child',
    });
    for (const outbox of repository.listPendingOutbox()) repository.completeOutbox(outbox.id);
    repository.completeAttempt({
      attemptId: child.attempt.id,
      principalId: child.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'Child complete.',
    });
    repository.completeAttempt({
      attemptId: created.attempts[0]!.id,
      principalId: lead.assigneePrincipalId,
      outcome: 'success',
      summary: 'Parent complete.',
    });
    expect(repository.snapshot(missionId).mission.state).toBe('VERIFYING');
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
    await second.page.setViewportSize({ width: 1440, height: 900 });
    await second.page.getByTestId('rail-view-sessions').click();
    const parent = second.page.getByTestId(`home-task-${taskId}`);
    const child = second.page.getByTestId(`session-mission-${childAssignmentId}`);
    await expect(parent).toBeVisible();
    await expect(child).toBeVisible();

    const removeTree = second.page.getByTestId(`mission-session-tree-delete-${missionId}`);
    await expect(removeTree).toBeVisible();
    await expect(removeTree).toHaveAttribute('aria-label', 'Delete parent and child sessions');
    await second.page.screenshot({ path: '/tmp/charter-session-tree-delete-wide.png' });
    await second.page.setViewportSize({ width: 900, height: 760 });
    await second.page.getByTestId('rail-view-sessions').click();
    await expect(removeTree).toBeVisible();
    await second.page.screenshot({ path: '/tmp/charter-session-tree-delete-narrow.png' });
    await removeTree.click();
    await expect(removeTree).toHaveAttribute(
      'aria-label',
      'Click again to delete the entire session tree',
    );
    await removeTree.click();

    await expect(parent).not.toBeAttached();
    await expect(child).not.toBeAttached();
    await expect(second.page.getByText('Session tree deleted — 2 Sessions removed.')).toBeVisible();

    await second.page.getByTestId('rail-view-missions').click();
    await second.page.getByTestId('mission-scope-deleted').click();
    await expect(second.page.getByTestId(`mission-rail-${missionId}`)).toContainText(
      'Session tree removed',
    );

    const persisted = await second.page.evaluate(async (id) => {
      const result = (await window.product.rpc['task.list']!({
        filter: 'all',
        includeArchived: true,
        scope: 'all',
      })) as {
        ok: boolean;
        data?: { tasks: Array<{ id: string }> };
      };
      return result.data?.tasks.some((task) => task.id === id) ?? true;
    }, taskId);
    expect(persisted).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally {
    await second.app.close();
    rmSync(first.userDataDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
