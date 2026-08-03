import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../packages/persistence/src/database';
import { MIGRATIONS } from '../../packages/persistence/src/migrations';
import { createTsSmallFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

test('a commander Diff includes files produced by its bound worker Sessions', async () => {
  const fixture = createTsSmallFixture();
  const first = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  let commanderTaskId = '';
  try {
    await first.page.getByTestId('surface-home').click();
    await first.page.getByTestId('home-advanced-toggle').click();
    await first.page.getByTestId('home-adv-title').fill('Aggregated Session Diff');
    await first.page.getByTestId('home-intent').fill('[scenario:ask-basic] prepare commander');
    await first.page.getByTestId('home-mode-ask').click();
    await first.page.getByTestId('home-submit').click();
    commanderTaskId =
      (await first.page.getByTestId('task-room').getAttribute('data-task-id')) ?? '';
    expect(commanderTaskId).not.toBe('');
    await expect(first.page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
      timeout: 20_000,
    });
  } finally {
    await first.app.close();
  }

  const changedDir = join(fixture, 'examples', 'aggregate-diff');
  mkdirSync(changedDir, { recursive: true });
  writeFileSync(join(changedDir, 'app.js'), 'export const app = true;\n');
  writeFileSync(join(changedDir, 'worker.js'), 'export const worker = true;\n');

  const database = openDatabase({
    file: join(first.userDataDir, 'app.db'),
    backupDir: join(first.userDataDir, 'backups'),
    migrations: MIGRATIONS,
  });
  const workerTaskId = 'task_e2e_aggregate_worker';
  const now = new Date().toISOString();
  try {
    database.db
      .prepare(
        `INSERT INTO tasks
          (id, workspace_id, title, goal_md, acceptance_json, mode, state, model_json,
           scope_json, verification_json, git_baseline_json, archived, version, created_at,
           updated_at, worktree_json, changed_files, external_json)
         SELECT ?, workspace_id, 'Bound worker', 'Create worker.js', acceptance_json, mode,
                'IDLE', model_json, scope_json, verification_json, git_baseline_json, 0, 1, ?, ?,
                worktree_json, 1, NULL
         FROM tasks WHERE id = ?`,
      )
      .run(workerTaskId, now, now, commanderTaskId);
    database.db
      .prepare('UPDATE tasks SET state = ?, changed_files = ?, updated_at = ? WHERE id = ?')
      .run('REVIEW_READY', 2, now, commanderTaskId);
    database.db
      .prepare(
        `INSERT INTO file_baselines
          (task_id, relative_path, existed, blob_hash, mode, size, encoding, eol, captured_at)
         VALUES (?, ?, 0, NULL, NULL, 0, 'utf8', 'lf', ?)`,
      )
      .run(commanderTaskId, 'examples/aggregate-diff/app.js', now);
    database.db
      .prepare(
        `INSERT INTO file_baselines
          (task_id, relative_path, existed, blob_hash, mode, size, encoding, eol, captured_at)
         VALUES (?, ?, 0, NULL, NULL, 0, 'utf8', 'lf', ?)`,
      )
      .run(workerTaskId, 'examples/aggregate-diff/worker.js', now);
    const sequence = (
      database.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM task_events WHERE task_id = ?',
        )
        .get(commanderTaskId) as { value: number }
    ).value;
    database.db
      .prepare(
        `INSERT INTO task_events
          (id, task_id, sequence, type, schema_version, payload_json, created_at)
         VALUES (?, ?, ?, 'orchestration.workerBound', 1, ?, ?)`,
      )
      .run(
        'evt_e2e_aggregate_worker_bound',
        commanderTaskId,
        sequence,
        JSON.stringify({ terminalId: 'term_e2e_worker', workerTaskId }),
        now,
      );
  } finally {
    database.db.close();
  }

  const second = await launchApp({
    userDataDir: first.userDataDir,
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  const rendererErrors: string[] = [];
  second.page.on('pageerror', (error) => rendererErrors.push(error.message));
  try {
    const room = second.page.getByTestId('task-room');
    if ((await room.count()) === 0) {
      await second.page.getByTestId(`home-task-${commanderTaskId}`).click();
    }
    await expect(room).toHaveAttribute('data-task-id', commanderTaskId, { timeout: 15_000 });
    await expect
      .poll(
        async () =>
          await second.page.evaluate(async (taskId) => {
            const result = (await window.product.rpc['task.changeSet']!({ taskId })) as {
              ok: boolean;
              data?: { changeSet: { files: Array<{ path: string }> } };
            };
            return result.data?.changeSet.files.map((file) => file.path).sort() ?? [];
          }, commanderTaskId),
        { timeout: 15_000 },
      )
      .toEqual(['examples/aggregate-diff/app.js', 'examples/aggregate-diff/worker.js']);
    const diffTab = second.page.getByTestId('session-tool-diff');
    await expect(diffTab).toContainText('2', { timeout: 15_000 });
    await diffTab.click();

    await expect(second.page.getByTestId('session-diff-review')).toContainText('2 files changed');
    await expect(
      second.page.getByTestId('session-diff-file-examples/aggregate-diff/app.js'),
    ).toBeVisible();
    await expect(
      second.page.getByTestId('session-diff-file-examples/aggregate-diff/worker.js'),
    ).toBeVisible();
    await second.page.screenshot({ path: '/tmp/charter-session-aggregate-diff-1440.png' });
    expect(rendererErrors).toEqual([]);
  } finally {
    await second.app.close();
  }
});
