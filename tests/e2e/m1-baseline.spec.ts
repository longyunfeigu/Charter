import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';

test.describe('M1 engineering baseline', () => {
  test('renderer is isolated and typed IPC works end to end', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await expect(page.getByTestId('app-version')).toHaveText('1.0.0');

      // Renderer isolation (spec §12.3): no Node globals, bridge is the only surface.
      const isolation = await page.evaluate(() => ({
        hasRequire: typeof (window as never as Record<string, unknown>).require !== 'undefined',
        hasProcess: typeof (window as never as Record<string, unknown>).process !== 'undefined',
        hasBridge: typeof (window as never as { product?: unknown }).product === 'object',
      }));
      expect(isolation.hasRequire).toBe(false);
      expect(isolation.hasProcess).toBe(false);
      expect(isolation.hasBridge).toBe(true);

      // Main-process web preferences really are hardened in production mode.
      const prefs = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const wp = (
          win.webContents as unknown as { getLastWebPreferences?: () => Record<string, unknown> }
        ).getLastWebPreferences?.();
        return wp ?? {};
      });
      expect(prefs.nodeIntegration ?? false).toBe(false);
      expect(prefs.contextIsolation ?? true).toBe(true);
      expect(prefs.sandbox ?? true).toBe(true);

      // Unknown channels must not exist on the bridge.
      const unknownChannel = await page.evaluate(() => {
        const bridge = (window as never as { product: { rpc: Record<string, unknown> } }).product;
        return typeof bridge.rpc['fs.readAnything'];
      });
      expect(unknownChannel).toBe('undefined');
    } finally {
      await app.close();
    }
  });
});
