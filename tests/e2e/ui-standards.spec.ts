import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch.js';
import { createGitFixture } from './helpers/fixtures.js';

/**
 * ADR-0061 — the DESIGN.md interface standards, checked on the real surfaces:
 * one state said once, the judged change visible without a click, no red
 * primary for a non-destructive accept, unclipped tool tabs, one page title
 * scale and no rows of zeros on empty surfaces.
 */
test.describe('Interface standards (ADR-0061)', () => {
  test('review lands on the evidence, says each state once and never clips a tab', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });

      // One page grammar: Home's question uses the shared page title scale.
      await expect(page.locator('.hm-hero h1')).toHaveCSS('font-size', '30px');
      await expect(page.locator('.hm-eyebrow')).toHaveCount(0);

      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] tighten retries');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // The change being judged is on screen with no extra click.
      await expect(page.getByTestId('review-bar')).toBeVisible();
      await expect(page.getByTestId('session-review-diff')).toBeVisible();
      await expect(page.getByTestId('session-inline-diff')).toContainText('src/index.ts');

      // Said once: the change set headline lives in the review panel, the
      // verdict in the Action Dock; the Done milestone repeats neither.
      await expect(page.getByTestId('review-bar')).toContainText('1 file changed');
      await expect(page.getByTestId('tl-done')).toHaveText(/Done/);
      await expect(page.getByTestId('tl-done')).not.toContainText('file');
      await expect(page.getByTestId('tl-done')).not.toContainText('unverified');
      await expect(page.getByTestId('review-failed-checks-warning')).toHaveCount(1);
      await expect(page.getByTestId('checks-unverified')).toHaveCount(0);
      await expect(page.locator('[data-testid="session-tool-diff"] small')).toHaveCount(0);

      // Accepting unverified work is a deliberate choice, not a red alarm.
      const accept = page.getByTestId('review-bar-accept');
      await expect(accept).toContainText('Accept without verification');
      await expect(accept).not.toHaveClass(/danger/);
      await accept.click();
      await expect(page.getByTestId('review-bar-accept-confirm')).not.toHaveClass(/danger/);
      await page.getByTestId('review-bar-accept-cancel').click();

      // No tab label is ever cut off, at a wide and at a narrow window.
      for (const size of [
        { width: 1440, height: 900 },
        { width: 1100, height: 800 },
      ]) {
        await page.setViewportSize(size);
        await page.waitForTimeout(250);
        const clipped = await page.evaluate(() => {
          const list = document.querySelector<HTMLElement>('.session-tool-tablist');
          if (!list) return ['no tablist'];
          const bounds = list.getBoundingClientRect();
          return [...list.querySelectorAll<HTMLElement>('[role="tab"]')]
            .filter((tab) => {
              const box = tab.getBoundingClientRect();
              return box.left < bounds.left - 1 || box.right > bounds.right + 1;
            })
            .map((tab) => tab.getAttribute('aria-label') ?? '?');
        });
        expect(clipped).toEqual([]);
      }
    } finally {
      await app.close();
    }
  });

  test('empty Missions and Work show the next step instead of zeros', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByTestId('rail-view-missions').click();
      await expect(page.getByTestId('mission-center')).toBeVisible();
      await expect(page.locator('.mission-center-head h1')).toHaveText('Missions');
      await expect(page.locator('.mission-center-head h1')).toHaveCSS('font-size', '30px');
      await expect(page.locator('.mission-center-metrics')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'No active Missions' })).toBeVisible();

      await page.getByTestId('rail-view-work').click();
      await expect(page.getByTestId('work-view')).toBeVisible();
      await expect(page.locator('.work-summary')).toHaveCount(0);
      await expect(page.getByTestId('work-empty-note')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
