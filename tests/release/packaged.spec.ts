import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import {
  launchPackagedApp,
  packagedExecutablePath,
} from '../e2e/helpers/launch';
import { createGitFixture } from '../e2e/helpers/fixtures';
import { terminalPtySnapshot, waitForTerminalOutput } from '../e2e/helpers/terminal';

// The status bar mirrors package.json — never hardcode the release here.
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

function removeTestDirectory(path: string, maxRetries = 0): void {
  try {
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries,
      retryDelay: 500,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && code === 'EPERM') {
      // The packaged app and daemon assertions have already completed. Windows
      // Defender or the search indexer can retain the now-unused temp root even
      // after all Charter processes and PTYs have exited; runner cleanup owns it.
      console.warn(`[packaged-e2e] deferred locked temp cleanup: ${path}`);
      return;
    }
    throw error;
  }
}

async function openTerminalSession(
  launched: Awaited<ReturnType<typeof launchPackagedApp>>,
): Promise<void> {
  await launched.page.getByRole('button', { name: /Commands/ }).click();
  const command = launched.page.getByRole('textbox', { name: 'Command' });
  await command.fill('Open Terminal Session');
  await launched.page.getByRole('option', { name: /Open Terminal Session/ }).click();
  await expect(launched.page.getByTestId('terminal-panel')).toBeVisible();
  if ((await terminalPtySnapshot(launched.page)).items.length === 0) {
    await launched.page.getByTestId('terminal-new').click();
  }
  try {
    await expect.poll(async () => (await terminalPtySnapshot(launched.page)).items.length).toBe(1);
  } catch (error) {
    const logPath = join(launched.userDataDir, 'logs', 'app.log');
    const appLog = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(no app log)';
    const daemonLogPath = join(launched.userDataDir, 'logs', 'terminal-daemon.log');
    const daemonLog = existsSync(daemonLogPath)
      ? readFileSync(daemonLogPath, 'utf8')
      : '(no daemon log)';
    throw new Error(
      `${String(error)}\nPackaged output:\n${launched.output()}\nApp log:\n${appLog}\nDaemon log:\n${daemonLog}`,
    );
  }
}

test('E2E-024: packaged app starts on a clean profile and survives security checks', async () => {
  const executablePath = packagedExecutablePath();
  expect(existsSync(executablePath)).toBe(true);

  if (process.platform === 'darwin') {
    const appBundle = resolve(dirname(executablePath), '../..');
    // Unsigned Preview still carries a valid ad-hoc signature after fuse
    // mutation. Gatekeeper trust/notarization is deliberately NOT claimed.
    execFileSync('codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'pipe' });
  }

  const rendererErrors: string[] = [];
  const launched = await launchPackagedApp({ executablePath });
  try {
    launched.page.on('pageerror', (error) => rendererErrors.push(error.message));
    await expect(launched.page.getByTestId('workbench')).toBeVisible();
    await expect(launched.page.getByTestId('startup-error')).toHaveCount(0);
    await expect(launched.page.getByTestId('status-version')).toHaveText(`v${version}`);
    expect(launched.page.url()).toMatch(/^app:\/\//);
    expect((await launched.page.locator('body').innerText()).trim().length).toBeGreaterThan(100);

    const rendererBoundary = await launched.page.evaluate(() => ({
      nodeRequire: typeof (window as unknown as { require?: unknown }).require,
      nodeProcess: typeof (window as unknown as { process?: unknown }).process,
      charterBridge: typeof (window as unknown as { product?: unknown }).product,
    }));
    expect(rendererBoundary).toEqual({
      nodeRequire: 'undefined',
      nodeProcess: 'undefined',
      charterBridge: 'object',
    });
    expect(rendererErrors).toEqual([]);
  } finally {
    await launched.close();
    removeTestDirectory(launched.userDataDir, process.platform === 'win32' ? 10 : 0);
  }
});

test('packaged daemon keeps a PTY alive across a full app restart', async () => {
  const executablePath = packagedExecutablePath();
  const fixture = createGitFixture();
  const environment = {
    PI_IDE_OPEN_WORKSPACE: fixture,
    PI_IDE_TERMINAL_PERSIST: '1',
  };
  let first: Awaited<ReturnType<typeof launchPackagedApp>> | null = null;
  let second: Awaited<ReturnType<typeof launchPackagedApp>> | null = null;

  try {
    first = await launchPackagedApp({ executablePath, env: environment });
    await openTerminalSession(first);

    const initial = await terminalPtySnapshot(first.page);
    const terminal = initial.items.at(-1);
    expect(terminal?.persistence).toBe('daemon');
    const terminalId = terminal!.id;

    await waitForTerminalOutput(first.page, /[%$#❯]/, { terminalId });
    const xterm = first.page.locator('.xterm').last();
    await xterm.click();
    await first.page.keyboard.press('Control+u');
    await first.page.keyboard.type(
      "printf 'PACKAGED_BEFORE_RESTART\\n'; sleep 2; printf 'PACKAGED_WHILE_CLOSED\\n'; sleep 30",
      { delay: 1 },
    );
    await first.page.keyboard.press('Enter');
    await waitForTerminalOutput(first.page, 'PACKAGED_BEFORE_RESTART', { terminalId });

    const userDataDir = first.userDataDir;
    await first.close();
    first = null;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));

    second = await launchPackagedApp({ executablePath, userDataDir, env: environment });
    await openTerminalSession(second);
    await expect(second.page.getByTestId(`terminal-tab-${terminalId}`)).toBeVisible();
    await expect(second.page.getByText('Restored', { exact: true })).toBeVisible();

    const restored = await terminalPtySnapshot(second.page);
    expect(restored.restoredIds).toContain(terminalId);
    expect(restored.items.find((item) => item.id === terminalId)?.persistence).toBe('daemon');
    await waitForTerminalOutput(second.page, 'PACKAGED_BEFORE_RESTART', { terminalId });
    await waitForTerminalOutput(second.page, 'PACKAGED_WHILE_CLOSED', { terminalId });

    await second.page.locator('.xterm').last().click();
    await second.page.keyboard.press('Control+c');
    await waitForTerminalOutput(second.page, /[%$#❯]/, { terminalId });
    await second.page.keyboard.type("printf 'PACKAGED_AFTER_RESTART_INPUT_OK\\n'", { delay: 1 });
    await second.page.keyboard.press('Enter');
    await waitForTerminalOutput(second.page, 'PACKAGED_AFTER_RESTART_INPUT_OK', { terminalId });

    const killed = await second.page.evaluate(async (id) => {
      return await window.product.rpc['terminal.kill']!({ id, force: true });
    }, terminalId);
    expect(killed).toMatchObject({ ok: true, data: { closed: true } });
  } finally {
    const userDataDir = second?.userDataDir ?? first?.userDataDir;
    await first?.close().catch(() => undefined);
    await second?.close().catch(() => undefined);
    if (userDataDir) {
      // The persistent daemon keeps Windows file handles open through its
      // documented 5s idle grace after the app window closes.
      if (process.platform === 'win32') {
        await new Promise((resolveWait) => setTimeout(resolveWait, 6_000));
      }
      // Cleanup is not the product assertion. On Windows, keep retrying long
      // enough for the daemon's idle shutdown before deferring a locked root to
      // the ephemeral runner cleanup.
      removeTestDirectory(userDataDir, process.platform === 'win32' ? 60 : 0);
    }
    // Git/Defender can retain a handle in the fixture briefly after the
    // packaged process exits, just as they can for the user-data directory.
    // The PTY restart assertions have already passed at this point.
    removeTestDirectory(fixture, process.platform === 'win32' ? 60 : 0);
  }
});
