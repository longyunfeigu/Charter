import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * M11-04: the Room timeline renders only its tail and reveals older events on
 * demand, so a long conversation never puts every event in the DOM. The window
 * size is forced small (via the test seam) so a normal ask task already
 * overflows it — the same code path that bounds a 10k-event room.
 */
test.describe('M11-04 timeline windowing', () => {
  test('older events fold behind "load earlier" and reveal on click', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      // Force a 2-event window before any renderer code runs.
      await page.addInitScript(() => {
        (window as unknown as { __PI_IDE_TIMELINE_WINDOW: number }).__PI_IDE_TIMELINE_WINDOW = 2;
      });
      await page.reload({ waitUntil: 'domcontentloaded' });

      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-adv-title').fill('Windowed task');
      await page
        .getByTestId('home-intent')
        .fill('[scenario:ask-with-read] [target:package.json] What does this project do?');
      await page.getByTestId('home-mode-ask').click();
      await page.getByTestId('home-submit').click();

      // The run completes: the final agent message and Done state arrive.
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 20000,
      });

      // With a 2-event window and a multi-event conversation, the earliest event
      // (the user's message) is folded away and the reveal control is present.
      const loadEarlier = page.getByTestId('timeline-load-earlier');
      await expect(loadEarlier).toBeVisible();
      await expect(page.getByTestId('tl-user')).toHaveCount(0);

      // Revealing brings the earlier events (and the user message) back.
      await loadEarlier.click();
      await expect(page.getByTestId('tl-user')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
