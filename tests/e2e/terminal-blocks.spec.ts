import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch.js';
import { createTsSmallFixture } from './helpers/fixtures.js';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * ADR-0021 legible terminal. The specs drive the OSC 133/9;4 parser with
 * explicit printf sequences — deterministic on any machine/shell — while the
 * real zsh/bash injection is covered by unit tests plus recorded smoke runs.
 * A full A→B→C→D cycle emitted from inside a command composes safely with a
 * live integration: its own marks close around ours (lost-D honesty rule).
 */

const OK_BLOCK = String.raw`printf '\033]133;A\007\033]133;B\007fake-ok\n\033]133;C\007output-line\n\033]133;D;0\007'`;
const ERR_BLOCK = String.raw`printf '\033]133;A\007\033]133;B\007fake-err\n\033]133;C\007boom\n\033]133;D;1\007'`;
const LONG_BLOCK = String.raw`printf '\033]133;A\007\033]133;B\007fake-long\n\033]133;C\007\033]9;4;1;42\007'; sleep 6; printf '\033]133;D;1\007'`;

function seededUserData(settings: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-ide-e2e-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  return dir;
}

test.describe('ADR-0021 terminal blocks', () => {
  test('TERM-007/008: OSC 133 builds blocks — rail dots, ⌘↑ jump, block actions', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    const rendererErrors: string[] = [];
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    try {
      await page.keyboard.press('Control+`');
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await page.locator('.xterm').click();

      // One finished command = one green dot on the rail.
      await page.keyboard.type(OK_BLOCK);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-rail-ok').first()).toBeVisible({ timeout: 15000 });

      // A non-zero exit = a red dot.
      await page.keyboard.type(ERR_BLOCK);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-rail-err').first()).toBeVisible({ timeout: 15000 });

      // ⌘↑ selects the last block and opens the toolbar on it.
      await page.keyboard.press(`${mod}+ArrowUp`);
      const toolbar = page.getByTestId('terminal-block-toolbar');
      await expect(toolbar).toBeVisible();
      await expect(toolbar).toContainText('fake-err');
      await expect(toolbar).toContainText('exit 1');

      // ⌘↓ below the last block leaves selection mode (back to live tail).
      await page.keyboard.press(`${mod}+ArrowDown`);
      await expect(toolbar).toHaveCount(0);

      // The red dot is click-reachable and lands on the failed block.
      await page.getByTestId('terminal-rail-err').first().click();
      await expect(toolbar).toBeVisible();
      await expect(toolbar).toContainText('exit 1');
      if (process.env.PI_IDE_QA_SCREENSHOT) {
        await page.screenshot({ path: '/tmp/terminal-blocks-selected.png' });
      }
      // Rerun is armed (recorded command, idle shell); Room send needs a room.
      await expect(page.getByTestId('block-rerun')).toBeEnabled();
      await expect(page.getByTestId('block-send-room')).toBeDisabled();
      await page.getByTestId('block-dismiss').click();
      await expect(toolbar).toHaveCount(0);

      expect(rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('TERM-009/010: sourced progress on three surfaces + finish bell when unfocused', async () => {
    const fixture = createTsSmallFixture();
    const userDataDir = seededUserData({ terminal: { longCommandSeconds: 5 } });
    const { app, page } = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: fixture },
    });
    try {
      await page.keyboard.press('Control+`');
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await page.locator('.xterm').click();

      const firstTerminalId = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<
                string,
                (p: unknown) => Promise<{ ok: boolean; data?: { items: Array<{ id: string }> } }>
              >;
            };
          }
        ).product;
        const res = await bridge.rpc['terminal.list']!({});
        return res.data?.items[0]?.id ?? null;
      });
      expect(firstTerminalId).not.toBeNull();

      // Long command reporting OSC 9;4 progress: the status bar and the row
      // ring paint the same sourced 42% — nothing invented.
      await page.keyboard.type(LONG_BLOCK);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('status-terminal-run')).toContainText('42%', {
        timeout: 10000,
      });
      await expect(page.getByTestId(`terminal-ring-${firstTerminalId}`)).toBeVisible();

      // Look elsewhere: a second terminal takes the dock focus.
      await page.getByTestId('terminal-new').click();

      // When the long command finishes unfocused, its row rings the bell
      // (system banners are muted under PI_IDE_E2E — same switchboard).
      await expect(page.getByTestId(`terminal-bell-${firstTerminalId}`)).toBeVisible({
        timeout: 15000,
      });
      // Progress cleared with the block: the status item is gone.
      await expect(page.getByTestId('status-terminal-run')).toHaveCount(0);

      // Looking at the terminal clears the bell.
      await page.getByTestId(`terminal-tab-${firstTerminalId}`).click();
      await expect(page.getByTestId(`terminal-bell-${firstTerminalId}`)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('TERM-011: integration off degrades to plain scrollback without errors', async () => {
    const fixture = createTsSmallFixture();
    const userDataDir = seededUserData({ terminal: { shellIntegration: false } });
    const { app, page } = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: fixture },
    });
    const rendererErrors: string[] = [];
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    try {
      await page.keyboard.press('Control+`');
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await page.locator('.xterm').click();
      await page.keyboard.type('echo degraded-but-fine');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-panel')).toContainText('degraded-but-fine', {
        timeout: 15000,
      });
      // No marks → no blocks, no rail, no toolbar; the feature disappears
      // instead of erroring (TERM-003 preserved).
      await expect(page.getByTestId('terminal-block-rail')).toHaveCount(0);
      await expect(page.getByTestId('terminal-block-toolbar')).toHaveCount(0);
      expect(rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
