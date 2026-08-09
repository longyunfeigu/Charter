import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchApp } from './helpers/launch';

test.describe('Full-page Settings workspace', () => {
  test('replaces the work area, owns Memory and Skills, and returns in place', async () => {
    const { app, page } = await launchApp({ home: 'keep' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      const settingsButton = page.getByTestId('home-settings');
      await settingsButton.click();

      await expect(page.getByTestId('settings-page')).toBeVisible();
      await expect(page.getByTestId('settings-back')).toBeFocused();
      await expect(page.getByTestId('surface-home')).toContainText('Settings');
      await expect(page.locator('.modal-backdrop')).toHaveCount(0);
      await expect(page.locator('.wb-main')).toBeHidden();
      await expect(page.locator('.statusbar')).toBeHidden();
      await expect(page.getByTestId('rail-view-memory')).toHaveCount(0);
      await expect(page.getByTestId('rail-view-skills')).toHaveCount(0);
      await expect(page.getByTestId('settings-section-memory')).toBeVisible();
      await expect(page.getByTestId('settings-section-skills')).toBeVisible();
      await expect(page.getByTestId('settings-section-skill-sources')).toBeVisible();
      await page.screenshot({
        path: join(tmpdir(), 'charter-settings-full-page-1440.png'),
        fullPage: true,
      });

      await page.getByTestId('settings-section-memory').click();
      await expect(page.getByTestId('memory-view')).toBeVisible();
      await expect(page.getByTestId('memory-nav-claude')).toBeVisible();
      await expect(page.getByTestId('memory-nav-codex')).toBeVisible();
      await expect(page.getByTestId('memory-nav-charter')).toBeVisible();
      await page.screenshot({
        path: join(tmpdir(), 'charter-settings-memory-1440.png'),
        fullPage: true,
      });

      await page.getByTestId('settings-section-skills').click();
      await expect(page.getByTestId('skills-main-page')).toBeVisible();
      await expect(page.getByTestId('skills-status-active')).toBeVisible();
      await expect(page.getByLabel('Search Skills')).toBeVisible();
      await page.screenshot({
        path: join(tmpdir(), 'charter-settings-skills-1440.png'),
        fullPage: true,
      });

      await page.setViewportSize({ width: 960, height: 720 });
      await page.getByTestId('settings-section-general').click();
      await expect(page.locator('.st-content-head')).toContainText('General');
      await expect(page.locator('.st-nav')).toHaveCSS('width', '214px');
      await expect(page.getByTestId('settings-back')).toBeInViewport();
      await page.screenshot({
        path: join(tmpdir(), 'charter-settings-full-page-960.png'),
        fullPage: true,
      });

      await page.getByTestId('settings-back').click();
      await expect(page.getByTestId('settings-page')).toHaveCount(0);
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(settingsButton).toBeFocused();
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
