import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launch.js';
import { createTsSmallFixture, createGitFixture } from './helpers/fixtures.js';

/** Visual acceptance walk for shell v4 — screenshots to /tmp/ui-shots/v4-*.png.
 * Gated behind CHARTER_SHOTS so the normal suite stays lean. */
test.skip(!process.env.CHARTER_SHOTS, 'set CHARTER_SHOTS=1 to capture');

const OUT = '/tmp/ui-shots';

test('shell v4 visual walk', async () => {
  test.setTimeout(240000);
  const fixture = createGitFixture();
  const { app, page } = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('surface-home').click();
    await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
    await page.screenshot({ path: `${OUT}/v4-1-launcher.png` });

    // Plan approval in the room (timeline v2 + persistent sidebar).
    await page
      .getByTestId('home-intent')
      .fill('[scenario:plan-request-changes] Add rate limiting to the login API');
    await page.getByTestId('home-submit').click();
    await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: `${OUT}/v4-2-room-plan.png` });

    // Request changes from the composer → revised plan v2.
    await page.getByTestId('agent-input').fill('also add a verification step please');
    await page.getByTestId('agent-send').click();
    await expect(page.getByTestId('plan-card')).toContainText('Revised', { timeout: 20000 });
    await page.screenshot({ path: `${OUT}/v4-3-room-plan-v2.png` });

    await page.getByTestId('plan-approve').click();
    await page.getByTestId('perm-allow-task').click({ timeout: 20000 });
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
      timeout: 30000,
    });
    await page.screenshot({ path: `${OUT}/v4-4-room-review-ready.png` });

    // Second task: live activity — rail board + sidebar ticker.
    await page.getByTestId('home-new-task').click();
    await page.getByTestId('home-mode-auto').click();
    await page.getByTestId('home-intent').fill('[scenario:edit-live] Live board demo task');
    await page.getByTestId('home-submit').click();
    await expect(page.locator('[data-testid^="live-tile-"]').first()).toBeVisible({
      timeout: 25000,
    });
    await page.screenshot({ path: `${OUT}/v4-5-room-live.png` });

    // Launcher fleet view while running + a review-ready card.
    await page.getByTestId('task-room-back').click();
    await page.screenshot({ path: `${OUT}/v4-6-launcher-fleet.png` });

    // Zero-change answered flow.
    await page.getByTestId('home-mode-ask').click();
    await page.getByTestId('home-intent').fill('[scenario:ask-basic] what is this project?');
    await page.getByTestId('home-submit').click();
    await expect(page.getByTestId('tl-answered')).toBeVisible({ timeout: 30000 });
    await page.screenshot({ path: `${OUT}/v4-7-room-answered.png` });
  } finally {
    await app.close();
  }
});
