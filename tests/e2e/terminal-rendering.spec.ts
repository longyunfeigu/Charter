import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';
import {
  terminalPtySnapshot,
  typeTerminalCommand,
  waitForTerminalOutput,
} from './helpers/terminal';

async function pressZoomShortcut(page: Page, direction: 'in' | 'out' | 'reset'): Promise<void> {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const key = direction === 'in' ? 'Shift+Equal' : direction === 'out' ? 'Minus' : 'Digit0';
  await page.keyboard.press(`${mod}+${key}`);
}

test.describe('terminal renderer and character widths', () => {
  test('WebGL degrades safely and compatibility settings apply to real xterm instances', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, ZDOTDIR: fixture },
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      await page.evaluate(async () => {
        await window.product.rpc['settings.update']!({
          scope: 'global',
          patch: { general: { theme: 'light' } },
        });
      });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            Math.round(BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor() * 100),
          ),
        )
        .toBe(100);

      await page.keyboard.press('Control+`');
      const first = page.getByTestId('terminal-host').locator('.xterm');
      await expect(first).toBeVisible({ timeout: 15000 });
      await expect(page.locator('.terminal-row-cwd').first()).toContainText('Context cwd');
      await expect(page.locator('.tsb-context').first()).toContainText('context cwd');
      await expect(first).toHaveAttribute('data-terminal-unicode', '11');
      await expect(first).toHaveAttribute('data-terminal-renderer', /^(webgl|software)$/);
      await expect(first).toHaveAttribute('data-terminal-font-size', '15');
      await expect(first).toHaveAttribute('data-terminal-font-weight', '500');
      await expect(first).toHaveAttribute('data-terminal-font-weight-bold', '700');
      await expect(first).toHaveAttribute('data-terminal-line-height', '1.2');
      await expect(first).toHaveAttribute('data-terminal-min-contrast', '4.5');
      await expect(page.getByTestId('terminal-host')).toHaveAttribute(
        'data-terminal-padding',
        '12x10',
      );
      expect(
        await page.getByTestId('terminal-host').evaluate((host) => {
          const style = getComputedStyle(host);
          return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
        }),
      ).toEqual(['10px', '12px', '10px', '12px']);
      expect(
        await page.getByTestId('terminal-host').evaluate((host) => {
          const parts = [
            host,
            host.querySelector('.xterm'),
            host.querySelector('.xterm-screen'),
            host.querySelector('.xterm-viewport'),
          ].filter((part): part is Element => part instanceof Element);
          return parts.map((part) => getComputedStyle(part).backgroundColor);
        }),
      ).toEqual([
        'rgb(255, 255, 255)',
        'rgb(255, 255, 255)',
        'rgb(255, 255, 255)',
        'rgb(255, 255, 255)',
      ]);
      const originalTerminalId = (await terminalPtySnapshot(page)).items[0]!.id;

      // Default typography should stay readable for the mixed Chinese, Latin,
      // links and emphasis that dominate Claude Code / Codex transcripts.
      await first.click();
      await page.keyboard.type(
        "printf '\\033[1mTerminal typography\\033[0m\\n中文排版与 English output\\npackages/app-domain/src/settings.ts:42\\n'",
      );
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, '中文排版与 English output', {
        terminalId: originalTerminalId,
      });
      if (process.env.PI_IDE_QA_SCREENSHOT) {
        await page.screenshot({ path: '/tmp/terminal-typography-default-1440x900.png' });
      }

      await page.getByTestId('home-settings').click();
      await page.getByTestId('settings-section-terminal').click();
      await page.getByTestId('settings-terminal-font-size').fill('16');
      await page.getByTestId('settings-terminal-font-weight').selectOption('600');
      await page.getByTestId('settings-terminal-line-height').fill('1.1');
      await page.getByTestId('settings-terminal-padding-x').fill('6');
      await page.getByTestId('settings-terminal-padding-y').fill('6');
      await page.getByTestId('settings-terminal-renderer').selectOption('software');
      await page.getByTestId('settings-terminal-unicode').selectOption('6');
      await expect(first).toHaveAttribute('data-terminal-font-size', '16');
      await expect(first).toHaveAttribute('data-terminal-font-weight', '600');
      await expect(first).toHaveAttribute('data-terminal-font-weight-bold', '800');
      await expect(first).toHaveAttribute('data-terminal-line-height', '1.1');
      await expect(first).toHaveAttribute('data-terminal-renderer', 'software');
      await expect(first).toHaveAttribute('data-terminal-unicode', '6');
      await expect(page.getByTestId('terminal-host')).toHaveAttribute(
        'data-terminal-padding',
        '6x6',
      );
      expect((await terminalPtySnapshot(page)).items.map((item) => item.id)).toContain(
        originalTerminalId,
      );
      await page.keyboard.press('Escape');

      // Renderer, Unicode and typography all update the existing xterm/PTY.
      const compatible = page.getByTestId('terminal-host').locator('.xterm');
      await expect(compatible).toHaveAttribute('data-terminal-renderer', 'software');
      await expect(compatible).toHaveAttribute('data-terminal-unicode', '6');
      await compatible.click();
      await pressZoomShortcut(page, 'in');
      await expect(compatible).toHaveAttribute('data-terminal-font-size', '17');
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            Math.round(BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor() * 100),
          ),
        )
        .toBe(100);
      await pressZoomShortcut(page, 'reset');
      await expect(compatible).toHaveAttribute('data-terminal-font-size', '16');

      // Outside xterm, the same command keeps its whole-window behavior.
      await page.getByTestId('home-settings').click();
      await pressZoomShortcut(page, 'in');
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            Math.round(BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor() * 100),
          ),
        )
        .toBe(110);
      await pressZoomShortcut(page, 'reset');
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            Math.round(BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor() * 100),
          ),
        )
        .toBe(100);
      await page.keyboard.press('Escape');

      await compatible.click();
      await page.keyboard.type("printf '中文%s ABC123\\n' '对齐'");
      await page.keyboard.press('Enter');
      const terminalId = originalTerminalId;
      await waitForTerminalOutput(page, '中文对齐 ABC123', { terminalId });

      // Exercise Electron's native clipboard and xterm paste handler. A
      // synthetic ClipboardEvent bypasses the browser/OS path and previously
      // produced a misleading line-48 truncation report.
      const probePath = join(fixture, '.terminal-native-paste');
      const expectedLines = Array.from(
        { length: 50 },
        (_, index) => `native-paste-${String(index + 1).padStart(2, '0')}`,
      );
      const clipboardText = expectedLines
        .map(
          (line, index) =>
            `printf '%s\\n' '${line}' ${index === 0 ? '>' : '>>'} .terminal-native-paste`,
        )
        .concat("printf '\\137\\137NATIVE_PASTE_COMPLETE\\137\\137\\n'")
        .join('\n');
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardText);
      await compatible.click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, '__NATIVE_PASTE_COMPLETE__', {
        terminalId,
        timeout: 30_000,
      });
      expect(readFileSync(probePath, 'utf8')).toBe(`${expectedLines.join('\n')}\n`);

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 900, height: 900 });
      });
      await expect(compatible).toBeVisible();
      // Let the responsive rail finish its 170ms compacting transition before
      // judging or capturing the narrow layout.
      await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '0');
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(pageErrors).toEqual([]);

      if (process.env.PI_IDE_QA_SCREENSHOT) {
        await page.screenshot({ path: '/tmp/terminal-typography-custom-900x900.png' });
      }
    } finally {
      await app.close();
    }
  });

  test('alternate-screen programs and Ctrl-D EOF return cleanly', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, ZDOTDIR: fixture },
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      await page.keyboard.press('Control+`');
      const xterm = page.locator('.xterm');
      await expect(xterm).toBeVisible({ timeout: 15_000 });
      const terminal = (await terminalPtySnapshot(page)).items[0]!;

      await typeTerminalCommand(
        page,
        "printf '\\033[?1049h\\033[2J\\033[HALT_%s_ACTIVE' SCREEN; sleep 1; printf '\\033[?1049lALT_%s_DONE\\n' SCREEN",
        { terminalId: terminal.id, xterm },
      );
      await waitForTerminalOutput(page, 'ALT_SCREEN_ACTIVE', { terminalId: terminal.id });
      await waitForTerminalOutput(page, 'ALT_SCREEN_DONE', { terminalId: terminal.id });
      await expect(xterm).toHaveAttribute('data-terminal-renderer', /^(webgl|software)$/);
      expect(pageErrors).toEqual([]);

      // Drive Ctrl-D through xterm's real keyboard path while `cat` owns the
      // foreground PTY. The following shell marker can only run after EOF.
      await typeTerminalCommand(page, 'cat > .terminal-ctrl-d', {
        terminalId: terminal.id,
        xterm,
      });
      await page.keyboard.type('ctrl-d-content');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Control+d');
      await page.waitForTimeout(200);
      await page.keyboard.type("printf '\\137\\137CTRL_D_RETURNED\\137\\137\\n'");
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, '__CTRL_D_RETURNED__', { terminalId: terminal.id });
      expect(readFileSync(join(fixture, '.terminal-ctrl-d'), 'utf8')).toBe('ctrl-d-content\n');
      expect(pageErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
