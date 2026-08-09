import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

test.describe('Session navigation sidebar toggle', () => {
  test('gives the active Session the full canvas and restores the rail in place', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15_000 });
      await page.getByTestId('home-mode-auto').click();
      await page
        .getByTestId('home-intent')
        .fill('[scenario:edit-plan-review] verify the sidebar focus toggle');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 30_000,
      });
      await expect(page.getByTestId('task-room')).toBeVisible();

      const sidebar = page.getByTestId('home-sidebar');
      const canvas = page.locator('.session-home-host');
      const toggle = page.getByTestId('sidebar-toggle');
      const before = await canvas.boundingBox();
      const rail = await sidebar.boundingBox();
      expect(before).not.toBeNull();
      expect(rail).not.toBeNull();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');

      await toggle.click();
      await expect(sidebar).toBeHidden();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('task-room')).toBeVisible();
      const expanded = await canvas.boundingBox();
      expect(expanded).not.toBeNull();
      expect(expanded!.x).toBeLessThan(before!.x);
      expect(expanded!.width - before!.width).toBeCloseTo(rail!.width, 0);
      await page.screenshot({
        path: join(tmpdir(), 'charter-session-sidebar-collapsed-1440.png'),
        fullPage: true,
      });

      await toggle.click();
      await expect(sidebar).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      const restored = await canvas.boundingBox();
      expect(restored).not.toBeNull();
      expect(restored!.x).toBeCloseTo(before!.x, 0);
      expect(restored!.width).toBeCloseTo(before!.width, 0);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
