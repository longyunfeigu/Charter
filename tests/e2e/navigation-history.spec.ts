import { expect, test } from '@playwright/test';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

test.describe('Unified page history', () => {
  test('Project → Session returns to the exact Project tab and supports Forward', async () => {
    const fixture = realpathSync(createGitFixture());
    const projectName = fixture.split('/').at(-1)!;
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
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await page.getByTestId('home-mode-ask').click();
      await page
        .getByTestId('home-intent')
        .fill('[scenario:ask-basic] navigation history verification');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible({ timeout: 30_000 });

      await page.getByTestId('rail-view-projects').click();
      await page.getByTestId(`home-recent-${fixture}`).click();
      await expect(page.getByTestId('project-center')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('project-center-tab-sessions').click();

      const session = page.locator('.pc-session-card').filter({
        hasText: 'navigation history verification',
      });
      await expect(session).toBeVisible();
      await session.locator('.pc-session-copy').click();

      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('navigation-origin')).toContainText(projectName);
      await expect(page.getByTestId('navigation-origin')).toContainText('sessions');
      await expect(page.getByTestId('task-room-back')).toContainText(projectName);

      await page.getByTestId('task-room-back').click();
      await expect(page.getByTestId('project-center-sessions')).toBeVisible();
      await expect(page.getByTestId('project-center-tab-sessions')).toHaveClass(/active/);

      await page.getByTestId('navigation-forward').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      writeFileSync(join(tmpdir(), 'charter-navigation-history-wide.png'), await page.screenshot());

      await page.setViewportSize({ width: 900, height: 760 });
      await expect(page.getByTestId('navigation-back')).toBeVisible();
      await expect(page.getByTestId('navigation-forward')).toBeVisible();
      const compactClose = page.getByTestId('rail-compact-close');
      if (await compactClose.isVisible()) await compactClose.click();
      await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '0');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      writeFileSync(
        join(tmpdir(), 'charter-navigation-history-narrow.png'),
        await page.screenshot(),
      );

      await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
