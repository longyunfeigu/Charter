import { expect, test } from '@playwright/test';
import { realpathSync } from 'node:fs';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

test.describe('Dual-form shell pivot (ADR-0004, PIVOT-001..010)', () => {
  test('Home is the default entry, branding is Charter, surfaces switch both ways', async () => {
    const { app, page } = await launchApp({ home: 'keep' });
    try {
      // PIVOT-001/008: Home first, Charter branding, no directory read yet.
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(page.getByTestId('home-intent')).toBeVisible();
      expect(await page.title()).toBe('Charter');
      await expect(page.getByTestId('home-view')).toContainText('What should we build?');
      await expect(page.getByTestId('home-view')).not.toContainText('Pi IDE');

      // PIVOT-006: into the IDE surface and back.
      await page.getByTestId('home-enter-ide').click();
      await expect(page.getByTestId('home-view')).toHaveCount(0);
      await expect(page.getByTestId('workbench')).toBeVisible();
      await expect(page.locator('.tb-title')).toHaveText('Charter');
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('PIVOT-005/007: charter a task from Home — pick project, type intent, run to review', async () => {
    // Recents store the canonical real path (WS-001) — resolve it up front.
    const fixture = realpathSync(createTsSmallFixture());
    // First launch records the fixture as a recent workspace, then quits.
    const first = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    const userDataDir = first.userDataDir;
    await expect(first.page.getByTestId('workspace-chip')).toBeVisible();
    await first.app.close();

    // Second launch: stay on Home and drive the full fast path through the UI.
    const { app, page } = await launchApp({
      userDataDir,
      env: { PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      await expect(page.getByTestId('home-view')).toBeVisible();

      // PIVOT-002: choose the project from recents; Home stays up (mid-charter).
      await page.getByTestId('home-project').click();
      await page.getByTestId(`home-recent-${fixture}`).click();
      await expect(page.getByTestId('home-project')).toContainText(fixture.split('/').pop()!);
      await expect(page.getByTestId('home-view')).toBeVisible();

      // PIVOT-003/004: model auto-selected (mock), approval policy set to auto.
      await expect(page.getByTestId('home-model')).toHaveValue(/mock/);
      await page.getByTestId('home-mode-auto').click();

      // PIVOT-005: submit switches to the workspace surface with the task running.
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] quick fix from home');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('home-view')).toHaveCount(0);
      await expect(page.getByTestId('agent-panel-main')).toBeVisible();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      await expect(page.getByTestId('tl-report')).toBeVisible();

      // PIVOT-007: back on Home, the task shows up in recent tasks.
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-view')).toContainText('quick fix from home');
    } finally {
      await app.close();
    }
  });

  test('PIVOT-009: provider keys managed in Settings (store, list, delete)', async () => {
    const { app, page } = await launchApp({});
    try {
      page.on('dialog', (dialog) => void dialog.accept());
      await page.getByTestId('activity-settings').click();
      await expect(page.getByTestId('overlay-settings')).toBeVisible();
      await page.getByText('Models', { exact: true }).click();

      await expect(page.getByTestId('providers-empty')).toBeVisible();
      await page.getByTestId('provider-key-input').fill('sk-test-e2e-key-000000');
      await page.getByTestId('provider-key-save').click();
      await expect(page.getByTestId('provider-row-anthropic')).toBeVisible();
      // The hint is masked — the raw key never renders.
      await expect(page.getByTestId('provider-row-anthropic')).not.toContainText(
        'sk-test-e2e-key-000000',
      );
      await expect(page.getByTestId('provider-fetch-anthropic')).toBeVisible();

      await page.getByTestId('provider-delete-anthropic').click();
      await expect(page.getByTestId('providers-empty')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
