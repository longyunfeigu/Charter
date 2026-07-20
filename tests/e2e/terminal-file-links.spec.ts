import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const modLabel = process.platform === 'darwin' ? '⌘' : 'Ctrl';

/** ADR-0033: ⌘+click file tokens in terminal output — browser for html,
 * editor (with line jump) for code, teaching toast without the modifier. */
test.describe('terminal file links', () => {
  test('hover hints, modifier teaching, browser/editor split', async () => {
    const fixture = createTsSmallFixture();
    writeFileSync(join(fixture, 'rocket.html'), '<!doctype html><title>rocket</title>\n');
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await page.keyboard.press('Control+`');
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });

      await page.locator('.xterm').click();
      await page.keyboard.type('echo rocket.html');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-panel')).toContainText('rocket.html', {
        timeout: 15000,
      });

      // The pure output row (not the prompt line that still contains `echo`).
      const outputRow = page
        .locator('.xterm-rows > div')
        .filter({ hasText: 'rocket.html' })
        .filter({ hasNotText: 'echo' })
        .first();
      await expect(outputRow).toBeVisible();

      // Hover the token (col 0, ~11 cells wide) → hint mirrors the host split.
      await outputRow.hover({ position: { x: 30, y: 8 }, force: true });
      await expect(page.locator('.terminal-link-hint')).toBeVisible();
      await expect(page.locator('.terminal-link-hint')).toHaveText(
        `${modLabel}+click to open in browser`,
      );
      await page.screenshot({ path: test.info().outputPath('link-hover-hint.png') });

      // Plain click keeps meaning "select text" and teaches the modifier.
      await outputRow.click({ position: { x: 30, y: 8 }, force: true });
      await expect(page.locator('.toast')).toContainText(
        `Hold ${modLabel} and click to open the link.`,
      );

      // ⌘+click on the html file: resolved + allowed (PI_IDE_E2E skips the real
      // shell.openExternal). Any resolution failure would surface as a toast.
      await outputRow.click({ position: { x: 30, y: 8 }, modifiers: [mod], force: true });
      await expect(page.locator('.toast', { hasText: 'No file named' })).toHaveCount(0);
      await expect(page.locator('.toast', { hasText: 'outside' })).toHaveCount(0);

      // Code token with :line → opens in the editor.
      await page.locator('.xterm').click();
      await page.keyboard.type('echo src/util.ts:2');
      await page.keyboard.press('Enter');
      const codeRow = page
        .locator('.xterm-rows > div')
        .filter({ hasText: 'src/util.ts:2' })
        .filter({ hasNotText: 'echo' })
        .first();
      await expect(codeRow).toBeVisible({ timeout: 15000 });
      await codeRow.click({ position: { x: 30, y: 8 }, modifiers: [mod], force: true });
      await expect(page.getByTestId('tab-src/util.ts')).toBeVisible({ timeout: 10000 });
    } finally {
      await app.close();
    }
  });
});
