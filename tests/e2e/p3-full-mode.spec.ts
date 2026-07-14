import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

const ORIGINAL_INDEX = `import { add } from './util';\n\nexport function main(): number {\n  return add(2, 3);\n}\n`;

/**
 * P3 — Full autonomy (ADR-0012): no approval prompts (R1–R3), plan
 * auto-approved, result applied automatically on completion; honest fallbacks
 * (failed verification keeps the task in review) and post-accept rollback.
 */

test.describe('P3 full mode (ADR-0012)', () => {
  test('runs without any approval pause (incl. R3), applies automatically, and can roll back after accept', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      page.on('dialog', (dialog) => void dialog.accept());
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toHaveValue(/mock/, { timeout: 15000 });
      await page.getByTestId('home-mode-full').click();
      await expect(page.getByTestId('home-mode-hint')).toContainText('Full auto');
      // edit-rollback touches create/modify/delete/rename — delete_file is R3,
      // which pauses even Auto mode; Full must sail through.
      await page.getByTestId('home-intent').fill('[scenario:edit-rollback] full auto everything');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();

      // Straight to ACCEPTED — no plan approval, no permission card.
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'ACCEPTED', {
        timeout: 30000,
      });
      await expect(page.getByTestId('perm-card')).toHaveCount(0);
      await expect(page.getByTestId('tl-accepted')).toContainText('automatically');

      // The changes really landed on disk.
      expect(existsSync(join(fixture, 'rollback-note.txt'))).toBe(true);
      expect(readFileSync(join(fixture, 'src/index.ts'), 'utf8')).toContain('add(3, 4)');

      // Replying to a CLOSED task starts a follow-up task (same project/mode)
      // instead of silently doing nothing.
      await page.getByTestId('agent-input').fill('now also add a moon');
      await page.getByTestId('agent-send').click();
      await expect(page.getByTestId('task-room')).toContainText('now also add a moon', {
        timeout: 20000,
      });
      await expect(page.getByTestId('task-state')).not.toHaveAttribute('data-state', 'ACCEPTED');

      // Back to the original room for the rollback half of this test.
      await page.getByTestId('task-room-back').click();
      await page
        .locator('[data-testid^="home-task-"]')
        .filter({ hasText: 'full auto' })
        .first()
        .click();

      // Post-accept rollback (ADR-0012): snapshots survive accept.
      await expect(page.getByTestId('task-room-accepted')).toBeVisible();
      await page.getByTestId('task-rollback').click();
      await page.getByTestId('task-rollback-confirm').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'ROLLED_BACK', {
        timeout: 20000,
      });
      expect(existsSync(join(fixture, 'rollback-note.txt'))).toBe(false);
      expect(readFileSync(join(fixture, 'src/index.ts'), 'utf8')).toBe(ORIGINAL_INDEX);
    } finally {
      await app.close();
    }
  });

  test('failed verification pauses auto-apply — the task stays in review with the failure on record', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toHaveValue(/mock/, { timeout: 15000 });
      await page.getByTestId('home-mode-full').click();
      // Configure a verification command via the Advanced charter.
      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-verif-custom').fill('node check-agent.mjs');
      await page.getByTestId('home-verif-custom').press('Enter');
      await page.getByTestId('home-intent').fill('[scenario:verify-fail-stop] try the check');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();

      // The verification fails and full mode does NOT apply.
      await expect(page.getByTestId('tl-verification-failed')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      // The pause is explained in the timeline, and review stays available.
      await expect(page.getByTestId('timeline')).toContainText('Auto-apply paused', {
        timeout: 20000,
      });
      await expect(page.getByTestId('review-open')).toBeVisible();
      // Still REVIEW_READY (no delayed auto-accept sneaking in).
      await page.waitForTimeout(600);
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY');
    } finally {
      await app.close();
    }
  });
});
