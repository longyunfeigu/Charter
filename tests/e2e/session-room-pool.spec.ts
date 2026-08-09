import { expect, test, type Page } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * ADR-0055 — kept-alive Session rooms. The pool re-parents room DOM instead
 * of rebuilding it: switching back must be instant (no timeline reload), the
 * document must only ever contain ONE room's landmarks (detached rooms are
 * invisible to global queries), and the pool stays bounded with eviction
 * falling back to the cached-ledger open path.
 */

async function createSession(page: Page, marker: string): Promise<string> {
  await page.getByTestId('surface-home').click();
  await page.getByTestId('home-intent').fill(`[scenario:ask-basic] ${marker}`);
  await page.getByTestId('home-mode-ask').click();
  await page.getByTestId('home-submit').click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="task-state"]')?.getAttribute('data-state') === 'IDLE',
    undefined,
    { timeout: 30000 },
  );
  const taskId = await page.evaluate(async (wanted) => {
    const bridge = (
      window as never as {
        product: {
          rpc: Record<
            string,
            (
              p: unknown,
            ) => Promise<{ ok: boolean; data?: { tasks: Array<{ id: string; goalMd?: string }> } }>
          >;
        };
      }
    ).product;
    const res = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
    return res.data!.tasks.find((task) => task.goalMd?.includes(wanted))!.id;
  }, marker);
  return taskId;
}

test.describe('ADR-0055 kept-alive Session rooms', () => {
  test('switching rooms preserves DOM, avoids reloads and keeps landmarks unique', async () => {
    test.setTimeout(120000);
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      const taskA = await createSession(page, 'POOL-MARK-ALPHA');
      const taskB = await createSession(page, 'POOL-MARK-BRAVO');

      // Two rooms visited, but the document holds exactly one of each landmark
      // — the hidden room's DOM is detached, not display:none.
      await expect(page.getByTestId('timeline')).toHaveCount(1);
      await expect(page.getByTestId('task-room')).toHaveCount(1);
      await expect(page.getByTestId('timeline')).toContainText('POOL-MARK-BRAVO');
      await expect(page.getByTestId('timeline')).not.toContainText('POOL-MARK-ALPHA');

      // Instrument: switching back to A must never show the timeline loader.
      await page.evaluate(() => {
        const w = window as unknown as { __loaderSeen: number };
        w.__loaderSeen = 0;
        new MutationObserver(() => {
          for (const note of document.querySelectorAll('.rt-note')) {
            if (note.textContent?.includes('Loading timeline')) {
              (window as unknown as { __loaderSeen: number }).__loaderSeen += 1;
            }
          }
        }).observe(document.body, { subtree: true, childList: true });
      });
      await page.getByTestId(`home-task-${taskA}`).click();
      await expect(page.getByTestId('timeline')).toContainText('POOL-MARK-ALPHA', {
        timeout: 3000,
      });
      await expect(page.getByTestId('timeline')).not.toContainText('POOL-MARK-BRAVO');
      expect(
        await page.evaluate(() => (window as unknown as { __loaderSeen: number }).__loaderSeen),
      ).toBe(0);
      await expect(page.getByTestId('timeline')).toHaveCount(1);

      // Composer drafts survive the round trip (React state kept alive).
      await page.getByTestId('agent-input').fill('DRAFT-SURVIVES-SWITCH');
      await page.getByTestId(`home-task-${taskB}`).click();
      await expect(page.getByTestId('timeline')).toContainText('POOL-MARK-BRAVO');
      await page.getByTestId(`home-task-${taskA}`).click();
      await expect(page.getByTestId('agent-input')).toHaveValue('DRAFT-SURVIVES-SWITCH');

      // Exceed the pool: two more sessions evict A (cap 3) — reopening it
      // falls back to the cached ledger and still renders correctly.
      await createSession(page, 'POOL-MARK-CHARLIE');
      await createSession(page, 'POOL-MARK-DELTA');
      await page.getByTestId(`home-task-${taskA}`).click();
      await expect(page.getByTestId('timeline')).toContainText('POOL-MARK-ALPHA', {
        timeout: 5000,
      });
      await expect(page.getByTestId('timeline')).toHaveCount(1);
      await expect(page.getByTestId('task-room')).toHaveCount(1);
    } finally {
      await app.close();
    }
  });
});
