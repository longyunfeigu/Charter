import { execSync } from 'node:child_process';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchApp } from './helpers/launch';

/**
 * Renderer crash recovery (2026-08-20 frozen-window bug): when the renderer
 * process dies unexpectedly ({"reason":"killed"}), the product branch of the
 * render-process-gone handler used to open a SYNCHRONOUS dialog, blocking the
 * main-process event loop forever — a frozen window that ignored every click.
 * The fix reloads in place (a crash loop escalates to an async dialog). This
 * spec runs the PRODUCT branch (PI_IDE_E2E='') and proves main stays alive
 * and the window comes back on its own.
 *
 * Safety: only ever kills a renderer whose parent is this test's own main pid.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ownRendererPids(mainPid: number): number[] {
  const out = execSync(
    `ps -Ao pid,ppid,command | grep "Electron Helper (Renderer)" | grep -v grep | awk '$2 == ${mainPid} {print $1}'`,
    { encoding: 'utf8' },
  ).trim();
  return out ? out.split('\n').map(Number) : [];
}

/** Ask the MAIN process about the window — the Playwright page handle dies
 * with the old renderer, so it can never observe the recovery. */
async function windowProbe(
  app: ElectronApplication,
  timeoutMs = 5000,
): Promise<{ mainAlive: boolean; crashed: boolean | null; homeViews: number }> {
  return Promise.race([
    app
      .evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return { mainAlive: true, crashed: null, homeViews: 0 };
        const homeViews = (await win.webContents
          .executeJavaScript('document.querySelectorAll("[data-testid=home-view]").length')
          .catch(() => 0)) as number;
        return { mainAlive: true, crashed: win.webContents.isCrashed(), homeViews };
      })
      .catch(() => ({ mainAlive: false, crashed: null, homeViews: 0 })),
    sleep(timeoutMs).then(() => ({ mainAlive: false, crashed: null, homeViews: 0 })),
  ]);
}

test('renderer killed from outside — main stays alive and the window recovers', async () => {
  test.setTimeout(120000);
  // Empty PI_IDE_E2E is falsy in main, selecting the same branch real users run.
  const { app, page } = await launchApp({ env: { PI_IDE_E2E: '' } });
  const mainPid = app.process().pid ?? 0;
  try {
    await page.getByTestId('home-view').waitFor({ state: 'visible', timeout: 20000 });
    const before = ownRendererPids(mainPid);
    expect(before.length).toBeGreaterThan(0);

    process.kill(before[0]!, 'SIGKILL'); // guarded: ppid == our own main

    // Recovery: main keeps servicing events and the reloaded window reaches
    // Home again. Before the fix, main wedged in showMessageBoxSync and every
    // probe below timed out.
    await expect
      .poll(
        async () => {
          const probe = await windowProbe(app);
          return probe.mainAlive && probe.crashed === false && probe.homeViews >= 1;
        },
        { timeout: 30000, intervals: [1000] },
      )
      .toBe(true);

    // A fresh renderer child exists and it is not the one we killed.
    const after = ownRendererPids(mainPid);
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toContain(before[0]);
  } finally {
    // If recovery regressed, main may be stuck in a modal — never hang teardown.
    await Promise.race([app.close().catch(() => {}), sleep(8000)]);
    try {
      process.kill(mainPid, 'SIGKILL');
    } catch {
      /* already exited */
    }
  }
});
