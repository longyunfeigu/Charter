import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * Sidebar context feeding + New project entry:
 *  - the Projects section has a "New project…" row opening the (global)
 *    NewProjectDialog from any surface, and
 *  - tree rows drag onto composers as @refs (PIVOT-015 drag source): the Home
 *    composer collects chips, the Task Room reply inlines "@path" text.
 */
test.describe('Sidebar — New project entry and drag-to-@ context feeding', () => {
  test('sidebar New project… opens the dialog (also from a Task Room)', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await page.getByTestId('home-new-project').click();
      await expect(page.getByTestId('new-project-dialog')).toBeVisible();
      await page.getByLabel('Close').click();
      await expect(page.getByTestId('new-project-dialog')).toHaveCount(0);

      // The entry keeps working while a Task Room fills the content area —
      // the dialog is shell-global, not a Launcher local.
      await page.getByTestId('home-mode-auto').click();
      await expect(page.getByTestId('home-model')).toHaveValue(/mock/);
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] room for dialog test');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await page.getByTestId('home-new-project').click();
      await expect(page.getByTestId('new-project-dialog')).toBeVisible();
      await page.getByLabel('Close').click();
    } finally {
      await app.close();
    }
  });

  test('dragging tree files/dirs onto the Home composer adds @ref chips', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await page.locator('[data-testid^="home-recent-"].active').click();
      await expect(page.getByTestId('home-project-tree')).toBeVisible();
      await page.getByTestId('home-tree-src').click();
      await expect(page.getByTestId('home-tree-src/index.ts')).toBeVisible();

      // HTML5 drag: dragstart on the tree row fills the DataTransfer, drop on
      // the composer card consumes it (same object across both events).
      const dt = await page.evaluateHandle(() => new DataTransfer());
      await page.dispatchEvent('[data-testid="home-tree-src/index.ts"]', 'dragstart', {
        dataTransfer: dt,
      });
      await page.dispatchEvent('[data-testid="home-view"] .hm-card', 'drop', {
        dataTransfer: dt,
      });
      await expect(page.getByTestId('home-ref-src/index.ts')).toBeVisible();

      // Directories ref with a trailing slash and survive dedupe.
      const dtDir = await page.evaluateHandle(() => new DataTransfer());
      await page.dispatchEvent('[data-testid="home-tree-src"]', 'dragstart', {
        dataTransfer: dtDir,
      });
      await page.dispatchEvent('[data-testid="home-view"] .hm-card', 'drop', {
        dataTransfer: dtDir,
      });
      await expect(page.getByTestId('home-ref-src/')).toBeVisible();
      await page.dispatchEvent('[data-testid="home-view"] .hm-card', 'drop', {
        dataTransfer: dtDir,
      });
      await expect(page.locator('[data-testid="home-ref-src/"]')).toHaveCount(1);

      // The refs land in the charter exactly like picker-added ones.
      await page.getByTestId('home-mode-auto').click();
      await expect(page.getByTestId('home-model')).toHaveValue(/mock/);
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] drag refs into charter');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      const userCard = page.getByTestId('tl-user').first();
      await expect(userCard).toContainText('@src/index.ts');
      await expect(userCard).toContainText('@src/');
    } finally {
      await app.close();
    }
  });

  test('dragging a tree file onto the Task Room reply inlines @path at the caret', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await page.locator('[data-testid^="home-recent-"].active').click();
      await page.getByTestId('home-tree-src').click();
      await expect(page.getByTestId('home-tree-src/index.ts')).toBeVisible();

      await page.getByTestId('home-mode-auto').click();
      await expect(page.getByTestId('home-model')).toHaveValue(/mock/);
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] drag into room reply');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();

      // The sidebar (and its tree) stays mounted next to the room.
      await page.getByTestId('agent-input').fill('also look at');
      const dt = await page.evaluateHandle(() => new DataTransfer());
      await page.dispatchEvent('[data-testid="home-tree-src/index.ts"]', 'dragstart', {
        dataTransfer: dt,
      });
      await page.dispatchEvent('[data-testid="room-composer"]', 'drop', { dataTransfer: dt });
      await expect(page.getByTestId('agent-input')).toHaveValue('also look at @src/index.ts ');
    } finally {
      await app.close();
    }
  });
});
