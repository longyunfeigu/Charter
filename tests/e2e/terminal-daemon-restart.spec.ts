import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  launchApp,
  restartMainPreservingTerminals,
  shutdownPersistentTestTerminals,
} from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';
import {
  terminalPtySnapshot,
  typeTerminalCommand,
  waitForTerminalOutput,
  waitForTerminalSequenceAdvance,
} from './helpers/terminal';

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

function latestDaemonPid(userDataDir: string): number | null {
  const path = join(userDataDir, 'logs', 'terminal-daemon.log');
  if (!existsSync(path)) return null;
  const entries = readFileSync(path, 'utf8').trim().split('\n').reverse();
  for (const line of entries) {
    try {
      const entry = JSON.parse(line) as { event?: string; pid?: number };
      if (entry.event === 'started' && Number.isInteger(entry.pid)) return entry.pid!;
    } catch {
      // Ignore a partially flushed final log record while polling startup.
    }
  }
  return null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

test.describe('daemon-backed terminal recovery', () => {
  test('normal application quit reaps the daemon, PTY leader and child process', async () => {
    test.skip(process.platform === 'win32', 'Unix process-group lifecycle assertion');
    const fixture = createGitFixture();
    const childPidFile = join(fixture, 'terminal-child.pid');
    let running: Awaited<ReturnType<typeof launchApp>> | null = null;
    try {
      running = await launchApp({
        env: {
          PI_IDE_OPEN_WORKSPACE: fixture,
          PI_IDE_TERMINAL_PERSIST: '1',
        },
      });
      await running.page.keyboard.press('Control+`');
      let snapshot = await terminalPtySnapshot(running.page);
      if (snapshot.items.length === 0) {
        await running.page.getByTestId('terminal-new').click();
      }
      await expect
        .poll(async () => {
          snapshot = await terminalPtySnapshot(running!.page);
          return snapshot.items.at(-1)?.pid ?? -1;
        })
        .toBeGreaterThan(0);
      const ptyPid = snapshot.items.at(-1)!.pid;
      await typeTerminalCommand(
        running.page,
        `${shellQuote(process.execPath)} -e 'setInterval(() => {}, 1000)' & echo $! > ${shellQuote(childPidFile)}; wait`,
        { terminalId: snapshot.items.at(-1)!.id },
      );
      await expect.poll(() => existsSync(childPidFile)).toBe(true);
      const childPid = Number(readFileSync(childPidFile, 'utf8').trim());
      expect(childPid).toBeGreaterThan(0);
      await expect.poll(() => latestDaemonPid(running!.userDataDir)).not.toBeNull();
      const resolvedDaemonPid = latestDaemonPid(running.userDataDir)!;

      const closed = running.app.waitForEvent('close');
      await running.app.evaluate(({ app: electronApp }) => {
        setTimeout(() => electronApp.quit(), 0);
      });
      await closed;
      running = null;

      await expect
        .poll(() => [resolvedDaemonPid, ptyPid, childPid].filter((pid) => processIsAlive(pid)), {
          timeout: 12_000,
        })
        .toEqual([]);
    } finally {
      await running?.app.close().catch(() => undefined);
    }
  });

  test('the PTY, offline output and input survive an explicit Main restart', async () => {
    const fixture = createGitFixture();
    const environment = {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_TERMINAL_PERSIST: '1',
    };
    let firstApp: ElectronApplication | null = null;
    let secondApp: ElectronApplication | null = null;
    let userDataDir: string | null = null;

    try {
      const first = await launchApp({ env: environment });
      firstApp = first.app;
      userDataDir = first.userDataDir;
      await first.page.keyboard.press('Control+`');
      await expect(first.page.getByTestId('terminal-panel')).toBeVisible();
      let firstSnapshot = await terminalPtySnapshot(first.page);
      if (firstSnapshot.items.length === 0) {
        await first.page.getByTestId('terminal-new').click();
        firstSnapshot = await terminalPtySnapshot(first.page);
      }
      const terminalId = firstSnapshot.items.at(-1)?.id;
      expect(terminalId).toBeTruthy();
      await typeTerminalCommand(
        first.page,
        "printf '\\033[?1049h\\033[2J\\033[HBEFORE_RESTART\\n'; sleep 2; printf 'WHILE_APP_CLOSED\\n'; sleep 30",
        { terminalId: terminalId! },
      );
      await waitForTerminalOutput(first.page, 'BEFORE_RESTART', { terminalId });

      // A distinct restart intent preserves daemon PTYs. A normal user quit
      // is covered separately and must terminate the entire process tree.
      await restartMainPreservingTerminals(first.app);
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

      const sequenceBeforeCancel =
        (await terminalPtySnapshot(second.page)).sequences[terminalId!] ?? 0;
      const restoredXterm = second.page.locator('.xterm').last();
      await restoredXterm.click();
      await expect(restoredXterm.locator('.xterm-helper-textarea')).toBeFocused();
      await second.page.keyboard.press('Control+c');
      // The old prompt remains in the replay tail. Wait for a new PTY chunk
      // before accepting that prompt as the post-interrupt command boundary.
      await waitForTerminalSequenceAdvance(second.page, terminalId!, sequenceBeforeCancel);
      await typeTerminalCommand(second.page, "printf '\\033[?1049lAFTER_RESTART_INPUT_OK\\n'", {
        terminalId: terminalId!,
      });
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
      if (userDataDir) await shutdownPersistentTestTerminals(userDataDir).catch(() => undefined);
    }
  });
});
