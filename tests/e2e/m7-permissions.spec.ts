import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

async function createTask(
  page: import('@playwright/test').Page,
  goal: string,
  mode: 'ask' | 'edit' | 'auto',
  title = 'Perm task',
) {
  await page.getByTestId('new-task-btn').click();
  await expect(page.getByTestId('new-task-dialog')).toBeVisible();
  await page.getByTestId('task-title').fill(title);
  await page.getByTestId('task-goal').fill(goal);
  await page.getByTestId(`mode-${mode}`).check();
  await expect(page.getByTestId('task-model')).toHaveValue(/mock/);
  await page.getByTestId('task-create-start').click();
}

test.describe('M7 permission engine (PERM-001..010, §13.3)', () => {
  test('E2E-012: user denies an install; the command never runs and the agent adapts', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await createTask(page, '[scenario:command-install] add a dependency', 'edit', 'Install task');

      // The approval card appears; task is AWAITING_PERMISSION.
      await expect(page.getByTestId('perm-card')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('perm-risk')).toHaveText('R3');
      await expect(page.getByTestId('task-state')).toHaveAttribute(
        'data-state',
        'AWAITING_PERMISSION',
      );
      // R3 offers no persistent grant (PERM-003): only "allow once" is present.
      await expect(page.getByTestId('perm-allow-task')).toHaveCount(0);
      await expect(page.getByTestId('perm-allow-workspace')).toHaveCount(0);

      await page.getByTestId('perm-reason').fill('please avoid new dependencies');
      await page.getByTestId('perm-deny').click();

      // The tool call is DENIED and the run continues to a final message + REVIEW_READY.
      await expect(page.getByTestId('tl-tool-run_command')).toHaveAttribute(
        'data-state',
        'DENIED',
        {
          timeout: 20000,
        },
      );
      await expect(page.getByTestId('tl-agent').last()).toContainText('vendor', { timeout: 20000 });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 20000,
      });

      // No node_modules/left-pad was created — the command never started.
      expect(existsSync(join(fixture, 'node_modules', 'left-pad'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  test('E2E-013: high-risk commands (sudo, git push) are refused with zero side effects', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await createTask(page, '[scenario:command-highrisk] do privileged things', 'edit', 'Danger');

      // No approval card is ever shown for R4 — the product refuses outright.
      await expect(page.getByTestId('tl-tool-run_command').first()).toHaveAttribute(
        'data-state',
        'DENIED',
        {
          timeout: 20000,
        },
      );
      await expect(page.getByTestId('perm-card')).toHaveCount(0);
      await expect(page.getByTestId('tl-agent').last()).toContainText('refused', {
        timeout: 20000,
      });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 20000,
      });
    } finally {
      await app.close();
    }
  });

  test('user approves a recognized command in edit mode; it runs and reports its exit code', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      // `npm --version` is a recognized-ish command that exits 0 quickly and needs no network.
      await createTask(
        page,
        '[scenario:command-test] [cmd:--version] check npm',
        'edit',
        'Run cmd',
      );
      await expect(page.getByTestId('perm-card')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('perm-allow-once').click();
      await expect(page.getByTestId('tl-tool-run_command')).toHaveAttribute(
        'data-state',
        'SUCCEEDED',
        {
          timeout: 20000,
        },
      );
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 20000,
      });
    } finally {
      await app.close();
    }
  });

  test('ask_user pauses the run until the user answers', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await createTask(page, '[scenario:ask-clarify] set things up', 'edit', 'Clarify');
      await expect(page.getByTestId('q-card')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('q-option-0').click(); // choose "npm"
      await expect(page.getByTestId('tl-agent').last()).toContainText('proceeding', {
        timeout: 20000,
      });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 20000,
      });
    } finally {
      await app.close();
    }
  });
});
