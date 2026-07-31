import { expect, test, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MissionSnapshotDto, TaskDto, TimelineEventDto } from '@pi-ide/ipc-contracts';
import { openDatabase } from '../../packages/persistence/src/database';
import { MIGRATIONS } from '../../packages/persistence/src/migrations';
import { MissionRepository } from '../../packages/persistence/src/mission-repository';
import { createTsSmallFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

async function openMission(page: Page, missionId: string): Promise<void> {
  await page.getByTestId('rail-view-missions').click();
  await expect(page.getByTestId(`mission-center-card-${missionId}`)).toBeVisible();
  await page.getByTestId(`mission-center-card-${missionId}`).click();
  await expect(page.getByTestId('mission-work-detail')).toBeVisible();
}

async function taskDetail(
  page: Page,
  taskId: string,
): Promise<{ task: TaskDto; timeline: TimelineEventDto[] }> {
  return await page.evaluate(async (id) => {
    const result = (await window.product.rpc['task.get']!({ taskId: id, eventsAfter: 0 })) as
      | { ok: true; data: { task: TaskDto; timeline: TimelineEventDto[] } }
      | { ok: false; error?: { userMessage?: string } };
    if (!result.ok) throw new Error(result.error?.userMessage ?? 'task.get failed');
    return result.data;
  }, taskId);
}

async function missionSnapshot(page: Page, missionId: string): Promise<MissionSnapshotDto> {
  return await page.evaluate(async (id) => {
    const result = (await window.product.rpc['mission.list']!({ limit: 100 })) as
      | { ok: true; data: { missions: MissionSnapshotDto[] } }
      | { ok: false; error?: { userMessage?: string } };
    if (!result.ok) throw new Error(result.error?.userMessage ?? 'mission.list failed');
    const snapshot = result.data.missions.find((item) => item.mission.id === id);
    if (!snapshot) throw new Error(`Mission ${id} not found`);
    return snapshot;
  }, missionId);
}

test('Runtime Inspector buttons open, guide, pause, resume, and change a managed owner', async () => {
  test.setTimeout(120_000);
  const fixture = createTsSmallFixture();
  const first = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  let taskId = '';
  let missionId = '';
  try {
    await first.page.getByTestId('surface-home').click();
    await first.page.getByTestId('home-advanced-toggle').click();
    await first.page.getByTestId('home-adv-title').fill('Runtime control seed');
    await first.page.getByTestId('home-intent').fill('[scenario:ask-basic] establish a session');
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
  try {
    const workspace = database.db
      .prepare('SELECT workspace_id AS id FROM tasks WHERE id = ?')
      .get(taskId) as { id: string } | undefined;
    expect(workspace).toBeTruthy();
    const created = new MissionRepository(database.db).createMission({
      workspaceId: workspace!.id,
      workspaceRoot: fixture,
      originConversationTaskId: taskId,
      title: 'Runtime controls acceptance',
      goal: 'Prove every Runtime Inspector control through the Electron UI.',
      acceptanceCriteria: ['all user controls reach their runtime'],
      lead: {
        principalId: 'runtime-control-lead',
        kind: 'managed_agent',
        provider: 'managed',
        displayName: 'Original Lead',
        runtimeSessionId: `managed-task:${taskId}`,
        requestedRuntime: 'managed',
        requestedModel: 'mock::mock-1',
      },
    });
    missionId = created.mission.id;
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
    await openMission(second.page, missionId);
    const details = second.page.getByTestId('mission-work-detail');

    await details.getByRole('button', { name: 'Open working session' }).click();
    await expect(second.page.getByTestId('task-room')).toHaveAttribute('data-task-id', taskId);
    await second.page.getByTestId('task-room-back').click();
    await openMission(second.page, missionId);

    await details.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(details.getByText('Paused', { exact: true })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(details.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect
      .poll(async () => (await taskDetail(second.page, taskId)).task.state, { timeout: 20_000 })
      .toBe('IDLE');

    const guidance = `GUIDANCE-${Date.now()} use the revised acceptance criteria`;
    await details
      .getByPlaceholder('Add context, change direction, or share a constraint…')
      .fill(guidance);
    await details.getByRole('button', { name: 'Send guidance' }).click();
    await expect
      .poll(
        async () =>
          (await taskDetail(second.page, taskId)).timeline.some((event) => {
            const payload = event.payload as { text?: unknown };
            return (
              event.type === 'user.message' &&
              typeof payload.text === 'string' &&
              payload.text.includes(guidance)
            );
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect
      .poll(async () => (await taskDetail(second.page, taskId)).task.state, { timeout: 20_000 })
      .toBe('IDLE');

    await details.getByRole('button', { name: 'Change owner' }).click();
    await details.getByLabel('Display name').fill('Replacement Lead');
    await details.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(details).toContainText('Replacement Lead');
    await expect
      .poll(
        async () => {
          const snapshot = await missionSnapshot(second.page, missionId);
          const lead = snapshot.assignments.find(
            (assignment) => assignment.id === snapshot.mission.leadAssignmentId,
          );
          const attempt = snapshot.attempts.find((item) => item.id === lead?.activeAttemptId);
          const principal = snapshot.principals.find(
            (item) => item.id === lead?.assigneePrincipalId,
          );
          return {
            owner: principal?.displayName,
            ordinal: attempt?.ordinal,
            runtimeSessionId: attempt?.runtimeSessionId,
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({
        owner: 'Replacement Lead',
        ordinal: 2,
        runtimeSessionId: expect.stringMatching(/^managed-task:/),
      });

    await details.getByRole('button', { name: 'Open working session' }).click();
    const replacementTaskId =
      (await second.page.getByTestId('task-room').getAttribute('data-task-id')) ?? '';
    expect(replacementTaskId).not.toBe('');
    expect(replacementTaskId).not.toBe(taskId);
    expect(pageErrors).toEqual([]);
  } finally {
    await second.app.close();
    rmSync(first.userDataDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
