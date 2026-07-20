import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * P2 — agent working-process visibility (ADR-0011):
 * 1. Model thinking streams into the room, persists as a collapsed block,
 *    expands on demand, and never leaks into the evidence (final report).
 * 2. The live activity strip narrates what the agent is doing (tool + time
 *    + tokens) instead of a bare "Working".
 */

test.describe('P2 visibility — thinking + live activity (ADR-0011)', () => {
  test('thinking renders collapsed in the room, expands on click, and stays out of the report', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-ask').click();
      await page.getByTestId('home-intent').fill('what is this project?');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();

      // The persisted thinking block appears (collapsed: no body visible).
      const block = page.getByTestId('tl-thinking');
      await expect(block).toBeVisible({ timeout: 20000 });
      await expect(block).toContainText('Thought');
      await expect(page.getByTestId('tl-thinking-body')).toHaveCount(0);

      // Expands on demand and shows the reasoning text.
      await block.locator('button').first().click();
      await expect(page.getByTestId('tl-thinking-body')).toContainText(
        'deterministic mock thinking',
      );

      // Evidence exclusion: the run finishes; the answer bubble exists and the
      // thinking text is nowhere in the report/answer surfaces.
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 20000,
      });
      await expect(page.getByTestId('tl-agent').last()).toBeVisible();
      const answered = page.getByTestId('tl-answered');
      if (await answered.isVisible().catch(() => false)) {
        await expect(answered).not.toContainText('mock thinking');
      }
    } finally {
      await app.close();
    }
  });

  test('the activity strip narrates the current action while running', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-live] narrate the work');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();

      // The strip is live while the agent works and carries a real action label.
      const strip = page.getByTestId('task-room-activity');
      await expect(strip).toBeVisible({ timeout: 25000 });
      await expect(page.getByTestId('task-room-action')).not.toHaveText('', { timeout: 25000 });
    } finally {
      await app.close();
    }
  });
});
