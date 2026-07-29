import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

test.describe('Session identity and working presence', () => {
  test('shows active work, honors reduced motion, and persists rename', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.getByTestId('surface-home').click();
      await page.getByTestId('home-mode-auto').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page
        .getByTestId('home-intent')
        .fill('[scenario:edit-live] Agent activity and rename polish');
      await page.getByTestId('home-submit').click();

      const row = page
        .locator('button[data-testid^="home-task-"]')
        .filter({ hasText: 'Agent activity and rename polish' });
      await expect(row).toHaveAttribute('data-working', 'true', { timeout: 15_000 });
      await expect(row).toHaveClass(/is-working/);
      await expect(row.locator('.sr-provider')).toHaveClass(/is-working/);
      await expect(row).toHaveAttribute('aria-label', /Agent working/);
      expect(
        await row.locator('.sr-provider svg').evaluate((element) => {
          return getComputedStyle(element).animationName;
        }),
      ).toContain('srAgentWorkingSpin');
      expect(
        await row.evaluate((element) => getComputedStyle(element, '::before').animationName),
      ).toContain('srAgentWorkingSheen');

      const railScroll = page.locator('.sr-scroll');
      await expect(railScroll).toHaveCSS('overflow-x', 'hidden');
      const horizontalOverflowSamples = await railScroll.evaluate(async (element) => {
        const samples: number[] = [];
        for (let index = 0; index < 8; index += 1) {
          samples.push(element.scrollWidth - element.clientWidth);
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return samples;
      });
      expect(horizontalOverflowSamples).toEqual(Array(8).fill(0));
      await page.screenshot({ path: '/tmp/charter-working-rail-no-horizontal-scroll-desktop.png' });

      await page.setViewportSize({ width: 1160, height: 760 });
      await expect(row).toHaveAttribute('data-working', 'true');
      await expect
        .poll(() => railScroll.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBe(0);
      await page.screenshot({ path: '/tmp/charter-working-rail-no-horizontal-scroll-narrow.png' });

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect
        .poll(() =>
          row
            .locator('.sr-provider svg')
            .evaluate((element) => getComputedStyle(element).animationName),
        )
        .toBe('none');
      expect(
        await row.evaluate((element) => getComputedStyle(element, '::before').animationName),
      ).toBe('none');

      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30_000,
      });
      await expect(row).toHaveAttribute('data-working', 'false');
      await expect(row.locator('.sr-provider')).not.toHaveClass(/is-working/);
      await expect(row).not.toHaveClass(/completion-ripple/, { timeout: 7_000 });

      const taskId = (await row.getAttribute('data-testid'))?.replace('home-task-', '');
      expect(taskId).toBeTruthy();
      await page.getByTestId('session-more').click();
      await page.getByTestId('task-rename').click();
      await expect(page.getByTestId('session-rename-dialog')).toBeVisible();
      await page.getByTestId('session-rename-input').fill('Release readiness pass');
      await page.getByTestId('session-rename-save').click();
      await expect(page.getByTestId('session-rename-dialog')).toHaveCount(0);
      await expect(page.locator('.session-identity-name .tr-title')).toHaveText(
        'Release readiness pass',
      );
      await expect(page.getByTestId(`home-task-${taskId!}`)).toContainText(
        'Release readiness pass',
      );
      await expect(page.getByTestId(`home-task-${taskId!}`)).not.toHaveClass(/completion-ripple/);

      await page.reload();
      await expect(page.getByTestId('workbench')).toBeVisible();
      await expect(page.getByTestId(`home-task-${taskId!}`)).toContainText(
        'Release readiness pass',
      );

      await page.getByTestId(`home-task-${taskId!}`).dblclick();
      await expect(page.getByTestId('session-rename-dialog')).toBeVisible();
      await expect(page.getByTestId('session-rename-input')).toHaveValue('Release readiness pass');
      await page.getByRole('button', { name: 'Cancel' }).click();
    } finally {
      await app.close();
    }
  });
});
