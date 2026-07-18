import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * Projects remains global navigation, while Files/Search/Changes own the
 * contextual middle column. Starting work for a project is an explicit action
 * and never requires a second nested project tree.
 */
test.describe('Projects — project actions without a duplicate file tree', () => {
  test('sidebar New project… opens the dialog (also from a Task Room)', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await page.getByTestId('rail-context').click();
      await page.getByTestId('home-new-project').click();
      await expect(page.getByTestId('new-project-dialog')).toBeVisible();
      await page.getByLabel('Close').click();
      await expect(page.getByTestId('new-project-dialog')).toHaveCount(0);
      await page.getByTestId('rail-view-sessions').click();

      // The entry keeps working while a Task Room fills the content area —
      // the dialog is shell-global, not a Launcher local.
      await page.getByTestId('home-mode-auto').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] room for dialog test');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await page.getByTestId('rail-context').click();
      await page.getByTestId('home-new-project').click();
      await expect(page.getByTestId('new-project-dialog')).toBeVisible();
      await page.getByLabel('Close').click();
    } finally {
      await app.close();
    }
  });

  test('the project New Session action binds the shared Composer', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await page.getByTestId('rail-context').click();
      await expect(page.getByTestId('home-project-tree')).toHaveCount(0);
      await page.locator('[data-testid^="project-spawn-pi-"]').first().click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(page.getByTestId('home-intent')).toBeFocused();
      await expect(page.getByTestId('home-project')).toContainText(
        fixture.split('/').pop() ?? 'fixture',
      );
    } finally {
      await app.close();
    }
  });

  test('clicking a project opens the one canonical Files context', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await page.getByTestId('rail-context').click();
      await page.locator('[data-testid^="home-recent-"].active').click();
      await expect(page.getByTestId('project-tool-view')).toBeVisible();
      await expect(page.getByTestId('explorer')).toBeVisible();
      await expect(page.getByRole('tree', { name: 'Files' })).toHaveCount(1);
      await expect(page.getByTestId('home-project-tree')).toHaveCount(0);
      await page.getByTestId('tree-item-src').click();
      await page.getByTestId('tree-item-src/index.ts').click();
      await expect(page.getByTestId('tab-src/index.ts')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
