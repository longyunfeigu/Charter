import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch.js';

const directions = [
  ['focus', 'A'],
  ['grouped', 'B'],
  ['activity', 'C'],
] as const;

test('sidebar vnext mock directions render and interact in Electron', async () => {
  const { app, page } = await launchApp({ home: 'keep' });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  try {
    for (const [slug, label] of directions) {
      pageErrors.length = 0;
      consoleErrors.length = 0;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`app://bundle/sidebar-vnext-${slug}.html`);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.locator('.mock-shell')).toBeVisible();
      await expect(page.locator('.rail')).toBeVisible();
      await expect(page.locator('.workbench')).toBeVisible();
      await expect(page.locator('.session-row.selected')).toHaveCount(1);
      await page.screenshot({ path: `/tmp/sidebar-vnext-${label.toLowerCase()}-desktop.png` });

      await page.locator('[data-action="new-session"]').first().click();
      await expect(page.locator('.modal')).toBeVisible();
      await page.locator('[data-action="close-modal"]').first().click();
      await expect(page.locator('.modal')).toHaveCount(0);

      if (slug === 'focus') {
        await page.locator('[data-filter="review"]').click();
        await expect(page.locator('.session-list .session-row')).toHaveCount(2);
      }
      if (slug === 'grouped') {
        const fable = page.locator('[data-group="fable5"]');
        await fable.click();
        await expect(fable).toHaveAttribute('aria-expanded', 'false');
        await fable.click();
        await expect(fable).toHaveAttribute('aria-expanded', 'true');
      }
      if (slug === 'activity') {
        await page.locator('[data-activity="inbox"]').click();
        await expect(page.locator('.panel-heading strong')).toHaveText('Needs you');
      }

      expect(pageErrors, `${label} page errors`).toEqual([]);
      expect(consoleErrors, `${label} console errors`).toEqual([]);
    }

    await page.setViewportSize({ width: 1024, height: 700 });
    await page.goto('app://bundle/sidebar-vnext-grouped.html');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.mock-shell')).toBeVisible();
    await expect(page.locator('.timeline-heading')).toBeVisible();
    await page.screenshot({ path: '/tmp/sidebar-vnext-b-narrow.png' });
  } finally {
    await app.close();
  }
});
