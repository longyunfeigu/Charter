import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Worker pid via the diagnostics channel (same route E2E-019 uses). */
async function workerPid(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const bridge = (
      window as never as {
        product: {
          rpc: Record<
            string,
            (p: unknown) => Promise<{
              ok: boolean;
              data?: { components: Array<{ name: string; detail: string }> };
            }>
          >;
        };
      }
    ).product;
    const res = await bridge.rpc['diagnostics.get']!({});
    const worker = res.data?.components.find((c) => c.name === 'agent-worker');
    const match = worker?.detail.match(/pid (\d+)/);
    return match ? Number(match[1]) : null;
  });
}

test.describe('M10 — crash recovery, reliability, diagnostics', () => {
  test('E2E-020: SIGKILL mid-task — no replay, no orphan, recover or roll back', async () => {
    const fixture = createTsSmallFixture();
    const first = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    const { userDataDir } = first;
    try {
      const { page } = first;
      // Charter a multi-write task in edit mode: every write asks.
      await page.getByTestId('new-task-btn').click();
      await page.getByTestId('task-title').fill('Crash victim');
      await page.getByTestId('task-goal').fill('[scenario:edit-multifile] cross-file change');
      await page.getByTestId('mode-edit').check();
      await expect(page.getByTestId('task-model')).toHaveValue(/mock/);
      await page.getByTestId('task-create-start').click();

      await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('plan-approve').click();

      // First write approved once — it lands on disk.
      await expect(page.getByTestId('perm-card')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('perm-card')).toContainText('src/index.ts');
      await page.getByTestId('perm-allow-once').click();

      // Second write is now WAITING for permission (the crash point).
      await expect(page.getByTestId('perm-card')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('perm-card')).toContainText('src/util.ts');
      await expect
        .poll(() => readFileSync(join(fixture, 'src/index.ts'), 'utf8'))
        .toContain('add(3, 4)');
      expect(readFileSync(join(fixture, 'src/util.ts'), 'utf8')).not.toContain('mul');

      const pid = await workerPid(page);
      expect(pid).not.toBeNull();
      expect(pidAlive(pid!)).toBe(true);

      // Hard-kill the main process — no cleanup code runs.
      first.app.process().kill('SIGKILL');

      // Orphan guard (M10/REL): the worker must notice the parent died and exit.
      await expect.poll(() => pidAlive(pid!), { timeout: 20000 }).toBe(false);
    } finally {
      await first.app.close().catch(() => undefined); // already dead — ignore
    }

    // Restart on the same profile and workspace.
    const second = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      const { page } = second;
      page.on('dialog', (dialog) => void dialog.accept());

      // The interrupted task surfaces on Home under "Needs you" with a
      // recovery entry (REC).
      await page.getByTestId('surface-home').click();
      const needs = page.getByTestId('home-mc-needs');
      await expect(needs).toBeVisible({ timeout: 15000 });
      await expect(needs).toContainText('Interrupted');
      await expect(needs).toContainText('Crash victim');
      await needs.locator('button.hm-tcard').first().click();

      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'INTERRUPTED');
      await expect(page.getByTestId('tl-restart')).toBeVisible();
      // The pending permission died with the process — it must NOT resurrect
      // and NOTHING may execute on restart (REL-002: no tool replay).
      await expect(page.getByTestId('perm-card')).toHaveCount(0);
      const index = readFileSync(join(fixture, 'src/index.ts'), 'utf8');
      expect(index.match(/add\(3, 4\)/g)).toHaveLength(1); // exactly once
      expect(readFileSync(join(fixture, 'src/util.ts'), 'utf8')).not.toContain('mul');

      // Recovery paths are one click away; roll back restores byte-exact.
      await expect(page.getByTestId('task-resume')).toBeVisible();
      await page.getByTestId('task-rollback').click();
      await page.getByTestId('task-rollback-confirm').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'ROLLED_BACK', {
        timeout: 15000,
      });
      expect(readFileSync(join(fixture, 'src/index.ts'), 'utf8')).toContain('add(2, 3)');
      expect(readFileSync(join(fixture, 'src/index.ts'), 'utf8')).not.toContain('add(3, 4)');
    } finally {
      await second.app.close();
    }
  });

  test('renderer crash recovers without losing the main process (M10/REL)', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await page.getByTestId('tree-item-README.md').click();
      await expect(page.getByTestId('tab-README.md')).toBeVisible();
      // Tab state persists on a 500ms debounce; a crash may legitimately lose
      // that window. Wait until it is on disk so the test asserts restore
      // fidelity, not the debounce race.
      await expect
        .poll(async () =>
          page.evaluate(async () => {
            const bridge = (
              window as never as {
                product: { rpc: Record<string, (p: unknown) => Promise<{ data?: unknown }>> };
              }
            ).product;
            const res = await bridge.rpc['tabs.get']!({});
            return JSON.stringify(res.data ?? null);
          }),
        )
        .toContain('README.md');

      const crashed = page.waitForEvent('crash');
      await app.evaluate(({ webContents }) => {
        webContents.getAllWebContents()[0]?.forcefullyCrashRenderer();
      });
      await crashed;

      // Playwright's session for a crashed Electron page never recovers, so
      // assert from the MAIN process (its own live connection): the window
      // auto-reloads (E2E guard) and the renderer is interactive again.
      const rendered = (selector: string) =>
        app.evaluate(async ({ webContents }, sel) => {
          const wc = webContents
            .getAllWebContents()
            .find((w) => !w.isDestroyed() && w.getURL().length > 0);
          if (!wc || wc.isCrashed() || wc.isLoading()) return false;
          try {
            return (await wc.executeJavaScript(
              `Boolean(document.querySelector('[data-testid="${sel}"]'))`,
            )) as boolean;
          } catch {
            return false;
          }
        }, selector);
      await expect.poll(() => rendered('workbench'), { timeout: 25000 }).toBe(true);
      // Session restores after the crash: workspace and tabs come back (APP-003).
      await expect.poll(() => rendered('tab-README.md'), { timeout: 20000 }).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('E2E-022: support bundle exports redacted — no keys, paths or prompts', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      // Store a secret and run a task so the bundle has something to redact.
      await page.getByTestId('activity-settings').click();
      await page.getByText('Models', { exact: true }).click();
      await page.getByTestId('provider-key-input').fill('sk-supersecret-e2e-000111222');
      await page.getByTestId('provider-key-save').click();
      await expect(page.getByTestId('provider-row-anthropic')).toBeVisible();
      await page.keyboard.press('Escape');

      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toHaveValue(/mock/);
      await page.getByTestId('home-mode-auto').click();
      await page
        .getByTestId('home-intent')
        .fill('[scenario:edit-basic] SECRET-PROMPT-MARKER do a thing');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // Export from Diagnostics (command palette route).
      await page.getByTestId('palette-chip').click();
      await page.getByPlaceholder('Type a command…').fill('diagnostics');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('overlay-diagnostics')).toBeVisible();
      await page.getByTestId('support-bundle-export').click();
      const bundlePath = await page.getByTestId('support-bundle-path').textContent({
        timeout: 15000,
      });
      expect(bundlePath).toBeTruthy();

      const content = readFileSync(bundlePath!, 'utf8');
      const bundle = JSON.parse(content) as Record<string, unknown>;
      // Present: what a maintainer needs.
      expect(bundle.kind).toBe('charter-support-bundle');
      expect(bundle.app).toBeTruthy();
      expect(bundle.taskStats).toBeTruthy();
      // Absent: everything the user would regret sharing (SUP redaction rules).
      expect(content).not.toContain('sk-supersecret');
      expect(content).not.toContain('SECRET-PROMPT-MARKER'); // no prompts/goals
      expect(content).not.toContain(fixture); // no workspace path
      expect(content).not.toContain(process.env.HOME ?? '/Users/'); // no home paths
      expect(content).not.toContain('add(2, 3)'); // no file contents
    } finally {
      await app.close();
    }
  });
});
