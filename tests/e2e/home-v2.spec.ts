import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * Home v2 (ADR-0005/0006, PIVOT-011..015): advanced charter, mission control,
 * context feeding. The engine flows underneath are the same ones covered by
 * E2E-009..018 — these tests cover the new shell semantics.
 */
test.describe('Home v2 — advanced charter, mission control, context feeding', () => {
  test('PIVOT-012/015: advanced fields and @refs land in the task charter', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      // Project is already the working directory — the chip shows it, no re-pick.
      await expect(page.getByTestId('home-project')).toContainText(fixture.split('/').pop()!);

      // Advanced charter (PIVOT-012).
      await page.getByTestId('home-advanced-toggle').click();
      await expect(page.getByTestId('home-advanced')).toBeVisible();
      await page.getByTestId('home-adv-boundaries').fill('Do not change public API signatures');
      await page
        .getByTestId('home-adv-criteria')
        .fill('429 after 5 failed attempts\nexisting tests stay green');
      // Suggested verification from package.json scripts (VER-002 detection).
      await expect(page.getByTestId('home-verif-npm test')).toBeVisible();
      await page.getByTestId('home-verif-npm test').click();

      // @ file reference (PIVOT-015).
      await page.getByTestId('home-attach').click();
      await page.getByTestId('home-file-input').fill('index');
      await expect(page.getByTestId('home-file-item-src/index.ts')).toBeVisible();
      await page.getByTestId('home-file-item-src/index.ts').click();
      await expect(page.getByTestId('home-ref-src/index.ts')).toBeVisible();

      await page.getByTestId('home-mode-auto').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] quick change with context');
      await page.getByTestId('home-submit').click();

      // The charter carries everything into the run's opening message; submit
      // opens the Task Room (PIVOT-021/022), never the Editor.
      await expect(page.getByTestId('home-view')).toHaveCount(0);
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      const userCard = page.getByTestId('tl-user').first();
      await expect(userCard).toContainText('Constraints:');
      await expect(userCard).toContainText('Do not change public API signatures');
      await expect(userCard).toContainText('@src/index.ts');
      await expect(userCard).toContainText('Acceptance criteria:');
      await expect(userCard).toContainText('429 after 5 failed attempts');
    } finally {
      await app.close();
    }
  });

  test('PIVOT-013: mission control surfaces needs-you states and drives navigation', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      // edit-basic writes a real change — REVIEW_READY must carry review weight
      // (zero-change tasks are presented as "Answered" instead, ADR-0009).
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] refactor utils');
      await page.getByTestId('home-submit').click();

      // The run pauses for plan approval; Home shows it under "Needs you".
      await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('task-room-back').click();
      const needs = page.getByTestId('home-mc-needs');
      await expect(needs).toBeVisible();
      await expect(needs).toContainText('Plan ready');
      await expect(needs).toContainText('refactor utils');
      await expect(needs).toContainText('Proposed a plan'); // live activity line

      // Card click jumps straight to the waiting task's room.
      await needs.locator('button.hm-tcard').first().click();
      await expect(page.getByTestId('home-view')).toHaveCount(0);
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('plan-card')).toBeVisible();
      await page.getByTestId('plan-approve').click();
      // edit mode: the write itself still asks for permission (PERM-004).
      await page.getByTestId('perm-allow-task').click({ timeout: 20000 });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // Review-ready tasks surface in Needs you and behind the Inbox badge.
      await page.getByTestId('task-room-back').click();
      await expect(page.getByTestId('home-mc-needs')).toContainText('Review');
      await expect(page.getByTestId('home-reviews')).toContainText('1');
      // Inbox routes to the task's room (PIVOT-028); review is one click there.
      await page.getByTestId('home-reviews').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await page.getByTestId('review-open').first().click();
      await expect(page.getByTestId('review-view')).toBeVisible({ timeout: 15000 });
    } finally {
      await app.close();
    }
  });

  test('PIVOT-011/014: follow-system theme is applied and notifications are configurable', async () => {
    const { app, page } = await launchApp({ home: 'keep' });
    try {
      // Theme resolves to a concrete scheme from the system preference.
      const theme = await page.evaluate(() => document.documentElement.dataset.theme);
      expect(['light', 'dark']).toContain(theme);

      await page.getByTestId('home-settings').click();
      await expect(page.getByTestId('overlay-settings')).toBeVisible();
      const toggle = page.getByTestId('settings-notifications');
      await expect(toggle).toBeChecked(); // default on (PIVOT-014)
      await toggle.uncheck();
      await expect(toggle).not.toBeChecked();
    } finally {
      await app.close();
    }
  });
});
