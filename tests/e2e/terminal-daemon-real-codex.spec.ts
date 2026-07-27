import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { terminalPtyOutput, terminalPtySnapshot, waitForTerminalOutput } from './helpers/terminal';

const REAL = process.env.PI_IDE_REAL_EXTERNAL_CLI === '1';
const WORKSPACE = process.cwd();
const EVIDENCE_DIR = '/tmp/charter-real-codex-daemon';

interface ExternalTask {
  id: string;
  state: string;
  external?: { cli?: string; terminalId?: string };
}

async function currentCodexTask(page: Page): Promise<ExternalTask | null> {
  return await page.evaluate(async () => {
    const result = (await window.product.rpc['task.list']!({
      filter: 'all',
      includeArchived: false,
      scope: 'all',
    })) as { ok: true; data: { tasks: ExternalTask[] } } | { ok: false };
    if (!result.ok) return null;
    return result.data.tasks.find((task) => task.external?.cli === 'codex') ?? null;
  });
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

async function openTerminal(page: Page): Promise<void> {
  await page.keyboard.press('Control+`');
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 15_000 });
}

async function waitForCodexBackgroundTask(page: Page, terminalId: string): Promise<void> {
  const xterm = page.locator('.xterm').last();
  await xterm.click();
  let handledUpdate = false;
  let handledTrust = false;
  await expect
    .poll(
      async () => {
        const output = await terminalPtyOutput(page, terminalId);
        if (!handledUpdate && /1\. Update now/.test(output) && /2\. Skip/.test(output)) {
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
          handledUpdate = true;
        }
        if (!handledTrust && /Do you trust/.test(output) && /1\. Yes/.test(output)) {
          await page.keyboard.press('Enter');
          handledTrust = true;
        }
        return output;
      },
      { timeout: 180_000, intervals: [500, 1_000, 2_000] },
    )
    .toContain('background terminal running');
}

async function exerciseSlashCommand(
  page: Page,
  terminalId: string,
  command: string,
): Promise<void> {
  const before = (await terminalPtySnapshot(page)).sequences[terminalId] ?? 0;
  await page.locator('.xterm').last().click();
  await page.keyboard.type(command, { delay: 30 });
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await terminalPtySnapshot(page)).sequences[terminalId] ?? 0)
    .toBeGreaterThan(before);
  await page.waitForTimeout(1_000);
  await page.screenshot({
    path: join(EVIDENCE_DIR, `${command.slice(1)}-after-restart.png`),
  });
  await page.keyboard.press('Escape');
}

test.describe('real Codex daemon recovery', () => {
  test.skip(!REAL, 'set PI_IDE_REAL_EXTERNAL_CLI=1 to run the real Codex recovery proof');

  test('real Codex keeps working while Charter is closed and reattaches afterward', async () => {
    test.setTimeout(12 * 60_000);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const environment = {
      PI_IDE_OPEN_WORKSPACE: WORKSPACE,
      PI_IDE_TERMINAL_PERSIST: '1',
    };
    let firstApp: ElectronApplication | null = null;
    let secondApp: ElectronApplication | null = null;
    let userDataDir: string | null = null;
    let terminalId: string | null = null;
    let sequenceBeforeQuit = 0;

    try {
      const first = await launchApp({ env: environment });
      firstApp = first.app;
      userDataDir = first.userDataDir;
      await openTerminal(first.page);
      const initial = await terminalPtySnapshot(first.page);
      terminalId = initial.items.at(-1)?.id ?? null;
      expect(terminalId).not.toBeNull();
      expect(initial.items.at(-1)?.persistence).toBe('daemon');

      await waitForTerminalOutput(first.page, /[%$#❯]/, { terminalId: terminalId! });
      await first.page.locator('.xterm').last().click();
      const prompt =
        "codex -s read-only -a never 'This is a read-only resilience test. Do not edit any file. " +
        'First run this exact shell command and wait for it to finish: ' +
        'i=1; while [ $i -le 12 ]; do echo CODEX_DAEMON_"PROBE_$i"; i=$((i+1)); sleep 5; done. ' +
        'Then inspect the terminal daemon implementation in this repository, run its relevant tests, ' +
        'and summarize exactly three concrete risks. Do not ask questions. End your final response with ' +
        "the words REAL_DAEMON_ followed immediately by REVIEW_DONE.'";
      await first.page.keyboard.type(prompt, { delay: 1 });
      await first.page.keyboard.press('Enter');

      await expect(first.page.locator('[data-testid^="terminal-agent-"]')).toContainText(/codex/i, {
        timeout: 45_000,
      });
      await waitForCodexBackgroundTask(first.page, terminalId!);
      sequenceBeforeQuit = (await terminalPtySnapshot(first.page)).sequences[terminalId!] ?? 0;
      const taskBefore = await expect
        .poll(() => currentCodexTask(first.page), { timeout: 30_000 })
        .not.toBeNull();
      void taskBefore;
      const originalTask = await currentCodexTask(first.page);
      expect(originalTask).not.toBeNull();
      expect(originalTask!.state).not.toBe('INTERRUPTED');
      await first.page.screenshot({ path: join(EVIDENCE_DIR, 'before-app-quit.png') });

      await first.app.close();
      firstApp = null;
      await new Promise((resolveWait) => setTimeout(resolveWait, 18_000));

      const second = await launchApp({
        userDataDir,
        env: environment,
      });
      secondApp = second.app;
      await openTerminal(second.page);
      await expect(second.page.getByTestId(`terminal-tab-${terminalId}`)).toBeVisible({
        timeout: 15_000,
      });
      await expect(second.page.getByText('Restored', { exact: true })).toBeVisible();
      await expect
        .poll(async () => (await terminalPtySnapshot(second.page)).restoredIds)
        .toContain(terminalId!);
      await expect
        .poll(async () => (await terminalPtySnapshot(second.page)).sequences[terminalId!])
        .toBeGreaterThan(sequenceBeforeQuit + 10);

      const taskAfter = await expect
        .poll(() => currentCodexTask(second.page), { timeout: 30_000 })
        .not.toBeNull();
      void taskAfter;
      const reattachedTask = await currentCodexTask(second.page);
      expect(reattachedTask?.id).toBe(originalTask!.id);
      expect(reattachedTask?.state).not.toBe('INTERRUPTED');
      expect(reattachedTask?.state).not.toBe('REVIEW_READY');
      await second.page.screenshot({
        path: join(EVIDENCE_DIR, 'restored-with-offline-output.png'),
      });

      await waitForTerminalOutput(second.page, 'REAL_DAEMON_REVIEW_DONE', {
        terminalId: terminalId!,
        timeout: 8 * 60_000,
      });
      await exerciseSlashCommand(second.page, terminalId!, '/status');
      await exerciseSlashCommand(second.page, terminalId!, '/model');
      await exerciseSlashCommand(second.page, terminalId!, '/skills');
      await exerciseSlashCommand(second.page, terminalId!, '/effort');

      await second.page.locator('.xterm').last().click();
      await second.page.keyboard.type('/exit', { delay: 30 });
      await second.page.keyboard.press('Enter');
      await expect(second.page.locator('[data-testid^="terminal-agent-"]')).toHaveCount(0, {
        timeout: 45_000,
      });
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
      if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
