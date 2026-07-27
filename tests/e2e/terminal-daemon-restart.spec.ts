import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';
import { terminalPtySnapshot, waitForTerminalOutput } from './helpers/terminal';

async function sendTerminalCommand(page: Page, terminalId: string, command: string): Promise<void> {
  await waitForTerminalOutput(page, /[%$#❯]/, { terminalId });
  const xterm = page.locator('.xterm').last();
  await xterm.click();
  await page.keyboard.press('Control+u');
  await page.keyboard.type(command, { delay: 1 });
  await page.keyboard.press('Enter');
}

async function killAllTerminals(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const listed = (await window.product.rpc['terminal.list']!({})) as
      { ok: true; data: { items: Array<{ id: string }> } } | { ok: false };
    if (!listed.ok) return;
    for (const terminal of listed.data.items) {
      await window.product.rpc['terminal.kill']!({ id: terminal.id, force: true });
    }
  });
}

async function quitFromAppMenu(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app: electronApp }) => {
    setTimeout(() => electronApp.quit(), 0);
  });
  await closed;
}

test.describe('daemon-backed terminal recovery', () => {
  test('the PTY, offline output and input survive a full app restart', async () => {
    const fixture = createGitFixture();
    const environment = {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_TERMINAL_PERSIST: '1',
    };
    let firstApp: ElectronApplication | null = null;
    let secondApp: ElectronApplication | null = null;

    try {
      const first = await launchApp({ env: environment });
      firstApp = first.app;
      await first.page.keyboard.press('Control+`');
      await expect(first.page.getByTestId('terminal-panel')).toBeVisible();
      let firstSnapshot = await terminalPtySnapshot(first.page);
      if (firstSnapshot.items.length === 0) {
        await first.page.getByTestId('terminal-new').click();
        firstSnapshot = await terminalPtySnapshot(first.page);
      }
      const terminalId = firstSnapshot.items.at(-1)?.id;
      expect(terminalId).toBeTruthy();
      await sendTerminalCommand(
        first.page,
        terminalId!,
        "printf '\\033[?1049h\\033[2J\\033[HBEFORE_RESTART\\n'; sleep 2; printf 'WHILE_APP_CLOSED\\n'; sleep 30",
      );
      await waitForTerminalOutput(first.page, 'BEFORE_RESTART', { terminalId });

      // Exercise the real Command+Q lifecycle, including before/will-quit teardown.
      await quitFromAppMenu(first.app);
      firstApp = null;
      // Stay closed beyond the daemon's 5s idle-grace window. A daemon that
      // lost ownership of the PTY would be gone before the second launch.
      await new Promise((resolve) => setTimeout(resolve, 8_000));

      const second = await launchApp({
        userDataDir: first.userDataDir,
        env: environment,
      });
      secondApp = second.app;
      await second.page.keyboard.press('Control+`');
      await expect(second.page.getByTestId(`terminal-tab-${terminalId}`)).toBeVisible({
        timeout: 15_000,
      });
      await expect(second.page.getByText('Restored', { exact: true })).toBeVisible();
      await waitForTerminalOutput(second.page, 'BEFORE_RESTART', { terminalId });
      await waitForTerminalOutput(second.page, 'WHILE_APP_CLOSED', { terminalId });
      if (process.env.PI_IDE_QA_SCREENSHOT) {
        await second.page.screenshot({ path: '/tmp/charter-terminal-daemon-restored.png' });
      }

      await second.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 980, height: 720 });
      });
      await expect(second.page.getByText('Restored', { exact: true })).toBeVisible();
      await expect(second.page.getByTestId('terminal-host')).not.toBeEmpty();
      if (process.env.PI_IDE_QA_SCREENSHOT) {
        await second.page.screenshot({ path: '/tmp/charter-terminal-daemon-restored-narrow.png' });
      }

      await second.page.locator('.xterm').last().click();
      await second.page.keyboard.press('Control+c');
      await sendTerminalCommand(
        second.page,
        terminalId!,
        "printf '\\033[?1049lAFTER_RESTART_INPUT_OK\\n'",
      );
      await waitForTerminalOutput(second.page, 'AFTER_RESTART_INPUT_OK', { terminalId });

      await second.page
        .getByTestId(`terminal-tab-${terminalId}`)
        .getByRole('button', { name: /Close/ })
        .click();
      const forceClose = second.page.getByTestId('terminal-kill-force');
      await forceClose.waitFor({ state: 'visible', timeout: 2000 }).catch(() => undefined);
      if (await forceClose.isVisible().catch(() => false)) await forceClose.click();
      await expect(second.page.getByTestId(`terminal-tab-${terminalId}`)).toHaveCount(0);
    } finally {
      if (firstApp) {
        const [page] = firstApp.windows();
        if (page) await killAllTerminals(page).catch(() => undefined);
      }
      if (secondApp) {
        const [page] = secondApp.windows();
        if (page) await killAllTerminals(page).catch(() => undefined);
      }
      await firstApp?.close().catch(() => undefined);
      await secondApp?.close().catch(() => undefined);
    }
  });
});
