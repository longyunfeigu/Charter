import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

/**
 * ADR-0017 rev.2 substrate — xterm 6's open() only attaches on the FIRST call,
 * so every re-mount must move the live element (mountTerminal). These paths
 * all went blank under the old `innerHTML=''; term.open(host)` pattern:
 * dock tab switching, and the Home ⇄ Editor surface round-trip.
 */
test.describe('terminal re-mount regressions', () => {
  test('tab switch A→B→A and ⌘E round-trip keep the pane alive', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      // Terminal A with a distinctive marker in its scrollback.
      await page.keyboard.press('Control+`');
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await page.locator('.xterm').click();
      await page.keyboard.type('echo marker-terminal-A');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-host')).toContainText('marker-terminal-A', {
        timeout: 15000,
      });
      const tabs = page.locator('[data-testid^="terminal-tab-"]');
      await expect(tabs).toHaveCount(1);

      // Terminal B, its own marker.
      await page.getByTestId('terminal-new').click();
      await expect(tabs).toHaveCount(2);
      await page.locator('.xterm').click();
      await page.keyboard.type('echo marker-terminal-B');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-host')).toContainText('marker-terminal-B', {
        timeout: 15000,
      });

      // Switch back to A: the SAME xterm element must re-attach with its
      // scrollback (this went blank before the mountTerminal fix).
      await tabs.nth(0).click();
      await expect(page.getByTestId('terminal-host')).toContainText('marker-terminal-A', {
        timeout: 10000,
      });
      await expect(page.getByTestId('terminal-host')).not.toContainText('marker-terminal-B');

      // And forward again to B.
      await tabs.nth(1).click();
      await expect(page.getByTestId('terminal-host')).toContainText('marker-terminal-B', {
        timeout: 10000,
      });

      // Home ⇄ Editor round-trip: the active terminal survives the surface flip.
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-shell')).toBeVisible({ timeout: 10000 });
      await page.keyboard.press('Meta+e');
      await expect(page.getByTestId('terminal-panel')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('terminal-host')).toContainText('marker-terminal-B', {
        timeout: 10000,
      });

      // The pane is still live, not a stale snapshot: new input still echoes.
      await page.locator('.xterm').click();
      await page.keyboard.type('echo marker-after-roundtrip');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-host')).toContainText('marker-after-roundtrip', {
        timeout: 15000,
      });
    } finally {
      await app.close();
    }
  });
});
