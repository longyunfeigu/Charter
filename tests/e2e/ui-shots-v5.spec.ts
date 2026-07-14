import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launch.js';
import { createTsSmallFixture } from './helpers/fixtures.js';

/** Visual acceptance walk for shell v5 (ADR-0014: in-room file peek) —
 * screenshots to /tmp/ui-shots/v5-*.png. Gated behind CHARTER_SHOTS. */
test.skip(!process.env.CHARTER_SHOTS, 'set CHARTER_SHOTS=1 to capture');

const OUT = '/tmp/ui-shots';

test('shell v5 visual walk — peek', async () => {
  test.setTimeout(240000);
  const fixture = createTsSmallFixture();
  const { app, page } = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('surface-home').click();
    await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
    await page.getByTestId('home-mode-auto').click();
    await page.getByTestId('home-intent').fill('[scenario:edit-basic] peek visual walk');
    await page.getByTestId('home-submit').click();
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
      timeout: 30000,
    });

    // Peek closed (baseline room).
    await page.screenshot({ path: `${OUT}/v5-1-room.png` });

    // Peek open — Changes mode.
    await page.getByTestId('task-room-file-src/index.ts').click();
    await expect(page.getByTestId('file-peek')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/v5-2-peek-diff.png` });

    // Peek — File mode (read-only Monaco).
    await page.getByTestId('peek-mode-file').click();
    await expect(page.getByTestId('peek-monaco')).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/v5-3-peek-file.png` });

    // Second tab pinned from the timeline.
    await page.getByTestId('tl-path-src/index.ts').first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/v5-4-peek-tabs.png` });

    // Dark theme (system-following). Close the peek first: a fresh open under
    // dark renders the Monaco layer natively (an emulated mid-session flip can
    // leave a stale composited layer in captures — state itself flips fine).
    await page.keyboard.press('Escape');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(400);
    await page.getByTestId('task-room-file-src/index.ts').click();
    await page.getByTestId('peek-mode-file').click();
    await expect(page.getByTestId('peek-monaco')).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/v5-5-peek-dark.png` });
  } finally {
    await app.close();
  }
});
