import { expect, test, type Page } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * M10 soak: 50 consecutive tasks through the full engine (charter → plan →
 * write → review-ready → rollback) on ONE app instance. Run explicitly:
 *   PI_IDE_SOAK=1 npx playwright test tests/e2e/soak.spec.ts
 * Asserts: zero worker restarts (no crash-cycling), a single stable worker
 * pid, every task terminal, and a clean worker exit on quit (no orphans).
 */
test.skip(!process.env.PI_IDE_SOAK, 'soak is opt-in: set PI_IDE_SOAK=1');

async function diagWorker(page: Page): Promise<{ pid: number | null; restarts: number | null }> {
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
    const pid = worker?.detail.match(/pid (\d+)/);
    const restarts = worker?.detail.match(/restarts (\d+)/);
    return {
      pid: pid ? Number(pid[1]) : null,
      restarts: restarts ? Number(restarts[1]) : null,
    };
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('soak: 50 consecutive tasks, one worker, zero restarts, clean exit', async () => {
  test.setTimeout(20 * 60 * 1000);
  const fixture = createTsSmallFixture();
  const { app, page } = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  page.on('dialog', (dialog) => void dialog.accept());
  let firstPid: number | null = null;
  try {
    for (let i = 1; i <= 50; i += 1) {
      // Back to the launcher: from the previous task's room, or from the Editor
      // on the first lap (ADR-0008 navigation).
      if (
        await page
          .getByTestId('task-room-back')
          .isVisible()
          .catch(() => false)
      ) {
        await page.getByTestId('task-room-back').click();
      } else {
        await page.getByTestId('surface-home').click();
      }
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill(`[scenario:edit-basic] soak run ${i}`);
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      // Roll back so the next run patches a pristine file (and rollback itself
      // gets 50 reps). ADR-0016: rollback lives in the review bar's overflow.
      await page.getByTestId('review-bar-more').click();
      await page.getByTestId('report-rollback').click();
      await page.getByTestId('report-rollback-confirm').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'ROLLED_BACK', {
        timeout: 15000,
      });

      const worker = await diagWorker(page);
      expect(worker.restarts).toBe(0);
      if (firstPid === null) firstPid = worker.pid;
      expect(worker.pid).toBe(firstPid); // one stable worker across all runs
    }
  } finally {
    await app.close();
  }
  // Clean shutdown (will-quit teardown): the worker exits with the app.
  if (firstPid !== null) {
    await expect.poll(() => pidAlive(firstPid!), { timeout: 15000 }).toBe(false);
  }
});
