import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * ADR-0024 (mock B+D): Room context feeding parity. The session rail gains a
 * persistent Files pane (drag source with a hover quick-add), references land
 * as chips above the composer instead of inline "@path" prose, and a sent
 * message carries its refs into the timeline.
 */
test.describe('Room context feeding — Files pane and reference chips', () => {
  test('Files tab → quick-add chips → send → refs land in the timeline', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();

      // Start a session so the rail's Files pane has a room to feed.
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] context feeding room');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();

      // Sessions ⇄ Files segmented tabs (persistent tree, mock B+D).
      await page.getByTestId('rail-tab-files').click();
      await expect(page.getByTestId('session-files-pane')).toBeVisible();
      await expect(page.getByTestId('explorer')).toBeVisible();

      // Quick-add a file: hover reveals the "+", the chip appears on the composer.
      const fileRow = page.getByTestId('tree-item-src');
      await expect(fileRow).toBeVisible();
      await fileRow.hover();
      await page.getByTestId('tree-add-src').click();
      await expect(page.getByTestId('room-file-refs')).toBeVisible();
      await expect(page.getByTestId('room-file-refs')).toContainText('src');

      // Expand the folder and add a file ref too.
      await fileRow.click();
      const indexRow = page.getByTestId('tree-item-src/index.ts');
      await expect(indexRow).toBeVisible();
      await indexRow.hover();
      await page.getByTestId('tree-add-src/index.ts').click();
      await expect(page.getByTestId('room-file-refs')).toContainText('src/index.ts');

      // Search view yields flat draggable results with the same quick-add.
      await page.getByTestId('session-files-search').fill('util');
      await expect(page.getByTestId('session-files-results')).toBeVisible();
      await page.getByTestId('session-files-hit-src/util.ts').click();
      await expect(page.getByTestId('room-file-refs')).toContainText('src/util.ts');

      // Duplicates are refused at the store (still exactly one util chip).
      await page.getByTestId('session-files-hit-src/util.ts').click();
      const chips = page.getByTestId('room-file-refs').locator('.file-ref-chip');
      await expect(chips).toHaveCount(3);

      // Send — refs ride the message and render as sent chips in the timeline.
      await page.getByTestId('agent-input').fill('use the attached context');
      await page.getByTestId('agent-send').click();
      await expect(page.getByTestId('tl-file-refs').last()).toBeVisible();
      await expect(page.getByTestId('tl-file-refs').last()).toContainText('src/index.ts');
      await expect(page.getByTestId('tl-file-refs').last()).toContainText('src/util.ts');

      // The composer chips cleared after a delivered send.
      await expect(page.getByTestId('room-file-refs')).toHaveCount(0);

      // Removing works before a send: attach again, then remove via the chip ✕.
      await page.getByTestId('session-files-search').fill('');
      const mathRow = page.getByTestId('tree-item-src/mathlib.ts');
      await expect(mathRow).toBeVisible();
      await mathRow.hover();
      await page.getByTestId('tree-add-src/mathlib.ts').click();
      await expect(page.getByTestId('room-file-refs')).toContainText('src/mathlib.ts');
      await page.locator('[data-testid^="file-ref-remove-"]').first().click();
      await expect(page.getByTestId('room-file-refs')).toHaveCount(0);

      // Back to Sessions: the segmented tab restores the session list.
      await page.getByTestId('rail-tab-sessions').click();
      await expect(page.getByTestId('rail-tab-sessions')).toContainText('Sessions');
      await expect(page.getByTestId('rail-session-search')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('the @ picker lands chips (no inline @path prose in the reply)', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] picker chips room');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();

      await page.getByTestId('room-attach').click();
      await page.getByTestId('room-file-input').fill('index');
      await page.getByTestId('room-file-item-src/index.ts').click();

      // A chip appears; the textarea stays free of "@src/index.ts" prose.
      await expect(page.getByTestId('room-file-refs')).toContainText('src/index.ts');
      await expect(page.getByTestId('agent-input')).toHaveValue('');
    } finally {
      await app.close();
    }
  });
});
