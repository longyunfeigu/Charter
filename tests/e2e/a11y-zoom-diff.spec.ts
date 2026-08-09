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

      // At browser/OS accessibility zoom beyond the product presets, the
      // primary composer action must remain inside the usable viewport.
      await page.getByRole('button', { name: 'Close' }).click();
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2);
      });
      await expect
        .poll(async () =>
          app.evaluate(({ BrowserWindow }) =>
            Math.round(BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor() * 100),
          ),
        )
        .toBe(200);
      const submitBox = await page.getByTestId('home-submit').boundingBox();
      const viewportWidth = await page.evaluate(() => window.innerWidth);
      expect(submitBox).not.toBeNull();
      expect(submitBox!.x).toBeGreaterThanOrEqual(0);
      expect(submitBox!.x + submitBox!.width).toBeLessThanOrEqual(viewportWidth);
      await page.screenshot({ path: '/tmp/charter-home-zoom-200.png' });
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

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(2);
      });
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            Math.round(BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor() * 100),
          ),
        )
        .toBe(200);
      const decisionIds = [
        'session-request-changes',
        'task-rollback',
        'review-bar-accept',
      ] as const;
      const expectInViewport = async (testId: string): Promise<void> => {
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const box = await page.getByTestId(testId).boundingBox();
        expect(box, `${testId} has a rendered box`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      };
      for (const [width, height] of [
        [1440, 900],
        [980, 760],
      ] as const) {
        await app.evaluate(
          ({ BrowserWindow }, bounds) => {
            BrowserWindow.getAllWindows()[0]!.setBounds({ x: 0, y: 0, ...bounds });
          },
          { width, height },
        );
        await expect
          .poll(() => page.evaluate(() => innerWidth))
          .toBeLessThanOrEqual(Math.ceil(width / 2) + 32);
        for (const testId of decisionIds) await expectInViewport(testId);
        const decisionNote = page.locator('.review-decision .session-action-note');
        await expect(decisionNote).toContainText('does not create a Git commit');
        expect(
          await decisionNote.evaluate(
            (element) =>
              element.scrollWidth > element.clientWidth + 1 ||
              element.scrollHeight > element.clientHeight + 1,
          ),
        ).toBe(false);
        await page.getByTestId('review-bar-open').click();
        await expect(page.getByTestId('review-view')).toBeVisible();
        await expectInViewport('review-accept-all');
        await expectInViewport('review-close');
        await page.getByTestId('review-accept-all').click();
        await expect(page.getByTestId('review-accept-all-confirm')).toBeVisible();
        await expectInViewport('review-accept-all-confirm');
        await expectInViewport('review-accept-all-cancel');
        await page.getByTestId('review-accept-all-cancel').click();
        await page.screenshot({ path: `/tmp/charter-review-zoom-200-${width}x${height}.png` });
        await page.getByTestId('review-close').click();
      }
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1);
      });

      await page.getByTestId('session-tool-diff').click();
      // Design D (diff-panel-redesign): the diff expands only after picking a file.
      await page.locator('[data-testid^="session-diff-file-"]').first().click();
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
