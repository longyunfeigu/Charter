import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

test.describe('terminal renderer and character widths', () => {
  test('WebGL degrades safely and compatibility settings apply to real xterm instances', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      await page.keyboard.press('Control+`');
      const first = page.getByTestId('terminal-host').locator('.xterm');
      await expect(first).toBeVisible({ timeout: 15000 });
      await expect(first).toHaveAttribute('data-terminal-unicode', '11');
      await expect(first).toHaveAttribute('data-terminal-renderer', /^(webgl|software)$/);

      await page.getByTestId('home-settings').click();
      await page.getByTestId('settings-section-terminal').click();
      await page.getByTestId('settings-terminal-renderer').selectOption('software');
      await page.getByTestId('settings-terminal-unicode').selectOption('6');
      await page.keyboard.press('Escape');

      // A fresh terminal picks up both settings; an older terminal will sync on
      // its next mount as it moves between the dock, room and side tool canvas.
      await page.getByTestId('terminal-new').click();
      const compatible = page.getByTestId('terminal-host').locator('.xterm');
      await expect(compatible).toHaveAttribute('data-terminal-renderer', 'software');
      await expect(compatible).toHaveAttribute('data-terminal-unicode', '6');
      await compatible.click();
      await page.keyboard.type("printf '中文对齐 ABC123\\n'");
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-host')).toContainText('中文对齐 ABC123', {
        timeout: 15000,
      });

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 900, height: 900 });
      });
      await expect(compatible).toBeVisible();
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(pageErrors).toEqual([]);

      if (process.env.PI_IDE_QA_SCREENSHOT) {
        await page.screenshot({ path: '/tmp/terminal-rendering-compat-900x900.png' });
      }
    } finally {
      await app.close();
    }
  });
});
