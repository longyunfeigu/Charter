import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';

test.describe('Codex application skin', () => {
  test('matches the quiet white and green visual language at wide and narrow desktop sizes', async () => {
    const { app, page } = await launchApp({ home: 'keep' });
    const rendererErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
    page.on('pageerror', (error) => rendererErrors.push(error.message));

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByTestId('workbench')).toBeVisible();
      await page.getByTestId('home-settings').click();
      await expect(page.getByTestId('overlay-settings')).toBeVisible();

      const skinOptions = page
        .getByRole('radiogroup', { name: 'Application skin' })
        .getByRole('radio');
      await expect(skinOptions).toHaveCount(6);
      await page
        .locator('.st-row')
        .filter({ hasText: 'Brightness' })
        .locator('select')
        .selectOption('light');
      await page.getByTestId('settings-skin-codex').click();

      await expect(page.locator('html')).toHaveAttribute('data-skin', 'codex');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect(page.getByTestId('settings-skin-codex')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('settings-skin-codex')).toContainText('Soft white');
      expect(
        await page.evaluate(() => {
          const style = getComputedStyle(document.documentElement);
          return {
            editor: style.getPropertyValue('--bg-editor').trim(),
            sidebar: style.getPropertyValue('--bg-sidebar').trim(),
            border: style.getPropertyValue('--border').trim(),
            accent: style.getPropertyValue('--accent').trim(),
            radius: style.getPropertyValue('--radius-card').trim(),
          };
        }),
      ).toEqual({
        editor: '#fcfcfb',
        sidebar: '#f4f5f4',
        border: '#e2e5e3',
        accent: '#0d9f6e',
        radius: '12px',
      });
      await page.screenshot({ path: '/tmp/charter-codex-skin-picker.png' });

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('overlay-settings')).not.toBeVisible();
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(page.locator('.titlebar')).toHaveCSS('background-color', 'rgb(250, 250, 250)');
      await expect(page.locator('.sr-activity')).toHaveCSS(
        'background-color',
        'rgb(250, 250, 250)',
      );
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await page.screenshot({ path: '/tmp/charter-codex-skin-wide.png' });

      await page.setViewportSize({ width: 1080, height: 720 });
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(page.locator('#root')).not.toBeEmpty();
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await page.screenshot({ path: '/tmp/charter-codex-skin-narrow.png' });

      expect(rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
