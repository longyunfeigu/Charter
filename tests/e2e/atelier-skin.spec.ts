import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';

const SHOTS = '/tmp/charter-atelier-skin';

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

function collectRendererErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test.describe('Atelier application skin', () => {
  test('selects live, keeps its material tokens in both themes, and remains usable at 1280px', async () => {
    const { app, page } = await launchApp({ home: 'keep' });
    const errors = collectRendererErrors(page);
    try {
      await expect(page.getByTestId('home-view')).toBeVisible();
      await page.getByTestId('home-settings').click();
      await expect(page.getByTestId('settings-page')).toBeVisible();

      const brightness = page
        .locator('.st-row')
        .filter({ hasText: 'Brightness' })
        .locator('select');
      await brightness.selectOption('light');
      await page.getByTestId('settings-skin-atelier').click();

      await expect(page.locator('html')).toHaveAttribute('data-skin', 'atelier');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect(page.getByTestId('settings-skin-atelier')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(page.getByTestId('settings-skin-atelier')).toContainText('Paper');

      expect(
        await page.evaluate(() => {
          const style = getComputedStyle(document.documentElement);
          return {
            app: style.getPropertyValue('--bg-app').trim(),
            editor: style.getPropertyValue('--bg-editor').trim(),
            accent: style.getPropertyValue('--accent').trim(),
            radius: style.getPropertyValue('--radius-card').trim(),
            uiFont: style.getPropertyValue('--font-ui').trim(),
            paperTexture: getComputedStyle(document.body, '::after').backgroundImage,
          };
        }),
      ).toMatchObject({
        app: '#f6f2e8',
        editor: '#fbf8f0',
        accent: '#a8442e',
        radius: '4px',
        uiFont: expect.stringContaining('Iowan Old Style'),
        paperTexture: expect.stringContaining('repeating-linear-gradient'),
      });

      await page.screenshot({ path: join(SHOTS, 'settings-light.png') });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('settings-page')).toHaveCount(0);
      await expect(page.getByTestId('home-view')).toBeVisible();
      await page.screenshot({ path: join(SHOTS, 'home-light-1440.png') });

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 768 });
      });
      await expect(page.getByTestId('home-view')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({ path: join(SHOTS, 'home-light-1280.png') });

      await page.getByTestId('home-settings').click();
      await brightness.selectOption('dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(
        await page.evaluate(() => {
          const style = getComputedStyle(document.documentElement);
          return {
            editor: style.getPropertyValue('--bg-editor').trim(),
            accent: style.getPropertyValue('--accent').trim(),
          };
        }),
      ).toEqual({ editor: '#292319', accent: '#d46a4b' });
      await page.screenshot({ path: join(SHOTS, 'settings-dark-1280.png') });

      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
