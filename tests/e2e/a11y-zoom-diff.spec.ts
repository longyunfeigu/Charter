import { expect, test } from '@playwright/test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';

function tsFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-ide-a11y-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'a11y-fixture', version: '1' }));
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  return root;
}

test.describe('M11-05 accessibility', () => {
  test('A11Y-003: UI zoom applies real window zoom and persists across reload', async () => {
    const { app, page } = await launchApp();
    try {
      await page.getByTestId('home-settings').click();
      await expect(page.getByTestId('settings-zoom')).toBeVisible();

      // Pick 150% → the window's real zoom factor changes (Monaco/terminal too).
      await page.getByTestId('settings-zoom-150').click();
      await expect
        .poll(async () =>
          app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0]!;
            return Math.round(win.webContents.getZoomFactor() * 100);
          }),
        )
        .toBe(150);

      // Persisted: reload restores 150% on did-finish-load.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect
        .poll(async () =>
          app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0]!;
            return Math.round(win.webContents.getZoomFactor() * 100);
          }),
        )
        .toBe(150);

      // Reset zoom returns to 100%.
      await page.getByTestId('home-settings').click();
      await page.getByTestId('settings-zoom-100').click();
      await expect
        .poll(async () =>
          app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0]!;
            return Math.round(win.webContents.getZoomFactor() * 100);
          }),
        )
        .toBe(100);
    } finally {
      await app.close();
    }
  });

  test('A11Y-005: diff text mode is keyboard-navigable with F7 and announces changes', async () => {
    const fixture = tsFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-adv-title').fill('A11y diff');
      await page.getByTestId('home-intent').fill('[scenario:edit-multifile] accessible diff');
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      await page.getByTestId('session-tool-diff').click();
      await expect(page.getByTestId('session-inline-diff')).toBeVisible();

      // Switch to the accessible text mode.
      await page.getByTestId('diff-viewmode-text').click();
      await expect(page.getByTestId('session-diff-text')).toBeVisible();
      const firstCard = page.getByTestId('diff-change-0');
      await expect(firstCard).toBeVisible();
      await expect(firstCard).toHaveAttribute('tabindex', '0');

      // F7 moves focus to the first change and the live region announces it.
      await page.getByTestId('session-diff-text').focus();
      await page.keyboard.press('F7');
      await expect(firstCard).toBeFocused();
      await expect(page.getByTestId('diff-live')).toContainText('Change 1 of');

      // F7 again advances (if there is more than one change) or wraps — either
      // way a change card stays focused and the announcement updates.
      await page.keyboard.press('F7');
      await expect(page.locator('.session-diff-change:focus')).toHaveCount(1);
      await expect(page.getByTestId('diff-live')).toContainText(/Change \d+ of/);
    } finally {
      await app.close();
    }
  });
});
