import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launch.js';
import { createTsSmallFixture } from './helpers/fixtures.js';

/**
 * ADR-0016 — the room completion presents as STATE (review bar above the
 * composer) instead of a timeline report card, and a reply can re-point the
 * task's model/effort for the next turn.
 */

test.describe('Room ending — review bar (ADR-0016, direction B)', () => {
  test('the review bar carries the completion: evidence meta, review action, rollback overflow', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      // rollbackTask double-checks via a native confirm on top of the armed button.
      page.on('dialog', (dialog) => void dialog.accept());
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] small change');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // The timeline ends in a quiet Done milestone — never a report card.
      await expect(page.getByTestId('tl-done')).toBeVisible();

      // The bar carries the recorded evidence: changed stats + the honest
      // unverified flag (edit-basic runs no verification commands).
      await expect(page.getByTestId('review-bar')).toBeVisible();
      await expect(page.getByTestId('report-changed')).toContainText('file');
      await expect(page.getByTestId('report-unverified')).toContainText(
        'no verification commands were run',
      );

      // Primary action: straight into the review surface, then back.
      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible();
      await page.getByTestId('review-close').click();
      await expect(page.getByTestId('review-bar')).toBeVisible();

      // Rollback lives in the overflow, still double-confirmed.
      await page.getByTestId('review-bar-more').click();
      await page.getByTestId('report-rollback').click();
      await page.getByTestId('report-rollback-confirm').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'ROLLED_BACK', {
        timeout: 15000,
      });
      // The bar is state: it vanishes with REVIEW_READY.
      await expect(page.getByTestId('review-bar')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('a reply re-points the task model/effort for the next turn (ADR-0016)', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] first pass');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // The reply composer's pill mirrors the task's model.
      await expect(page.getByTestId('reply-model')).toContainText('Mock Model 1');

      // Re-point the next turn: Mock Model 2 · low effort.
      await page.getByTestId('reply-model').click();
      await page.getByTestId('reply-model-opt-mock::mock-2').click();
      await page.getByTestId('reply-effort-low').click();
      // The popover opens upward over the timeline — close it with an outside
      // click there, then type the reply.
      await page.getByTestId('timeline').click({ position: { x: 40, y: 40 } });
      await page.getByTestId('agent-input').fill('[scenario:ask-basic] double-check the result');
      await page.getByTestId('agent-send').click();

      // The switch is recorded honestly in the timeline before the turn runs.
      await expect(page.getByTestId('tl-model-changed').first()).toContainText('mock/mock-2');
      await expect(page.getByTestId('tl-model-changed').first()).toContainText('effort low');

      // The reply started a fresh run; it completes on the new model and the
      // pill (seeded from the task record) agrees.
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      await expect(page.getByTestId('reply-model')).toContainText('Mock Model 2');
    } finally {
      await app.close();
    }
  });
});
