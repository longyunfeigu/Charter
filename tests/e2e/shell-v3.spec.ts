import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * Shell v3 (ADR-0008): Task Room, entry consolidation and humane language.
 * The engine flows underneath are covered by E2E-009..018; these tests pin the
 * task-centric shell semantics.
 */
test.describe('Shell v3 — Task Room and entry consolidation', () => {
  test('PIVOT-021: the room hosts observation, review and the final decision', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    // Accepting unverified changes asks once more (E2E-018 semantics).
    page.on('dialog', (dialog) => void dialog.accept());
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] room flow');
      await page.getByTestId('home-submit').click();

      // Submit opens the Task Room on the Home surface (PIVOT-022: no Editor).
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('agent-panel-main')).toHaveCount(0);
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      // PIVOT-023: the chip speaks human, the machine state lives in data-state.
      await expect(page.getByTestId('task-state')).toHaveText('Ready to review');

      // The rail lists what the agent touched, from recorded change events.
      await expect(page.getByTestId('task-room-file-src/index.ts')).toBeVisible();

      // Review works without ever entering the Editor.
      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible();
      await expect(page.getByTestId('review-file-src/index.ts')).toBeVisible();
      await page.getByTestId('review-accept-all').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 20000,
      });
      // Accept closes the review; if it lingers, close it — the room remains.
      const close = page.getByTestId('review-close');
      if (await close.isVisible().catch(() => false)) await close.click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('task-state')).toHaveText('Settled — reply to continue');
    } finally {
      await app.close();
    }
  });

  test('PIVOT-022: Session tools keep the room and its pending plan mounted', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-intent').fill('[scenario:edit-plan-review] entry check');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 20000 });

      // No main-area workspace chip on Home anymore (entry consolidation).
      await page.getByTestId('task-room-back').click();
      await expect(page.getByTestId('home-enter-ide')).toHaveCount(0);

      // Reopen the Session from the one global rail. There is no alternate
      // workspace shell or duplicate Agent Panel.
      await page.getByTestId(`home-task-${await taskIdOf(page)}`).click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('plan-card')).toBeVisible();
      await expect(page.getByTestId('session-tool-canvas')).toBeVisible();
      await expect(page.getByTestId('agent-panel-main')).toHaveCount(0);

      // The waiting plan is decidable without leaving the conversation.
      // (ADR-0032: this zero-change scenario settles straight to IDLE.)
      await page.getByTestId('plan-approve').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 30000,
      });
    } finally {
      await app.close();
    }
  });
});

test.describe('Shell v3 — layered live supervision (PIVOT-025)', () => {
  test('current work, live file heat and touched files share one event stream', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-live] watch the agent work');
      await page.getByTestId('home-submit').click();

      // Supervision remains in the Session: timeline action, right-side file
      // heat and touched-file evidence all project the same change events.
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('session-summary')).toBeVisible();
      await expect(page.locator('[data-testid^="live-board-"]').first()).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByTestId('live-tile-notes-live-a.txt')).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
    } finally {
      await app.close();
    }
  });
});

test.describe('Shell v3 — Home refinements (PIVOT-027, PIVOT-012 title)', () => {
  test('the active project row opens the canonical Files context and Editor', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      // Projects are global navigation only; the contextual Explorer is the
      // one file tree and lives next to the Editor.
      await page.getByTestId('rail-context').click();
      await page.locator('[data-testid^="home-recent-"].active').click();
      await expect(page.getByTestId('project-tool-view')).toBeVisible();
      await expect(page.getByTestId('home-project-tree')).toHaveCount(0);
      await page.getByTestId('tree-item-src').click();
      await expect(page.getByTestId('tree-item-src/index.ts')).toBeVisible();
      await page.getByTestId('tree-item-src/index.ts').click();
      await expect(page.getByTestId('home-view')).toHaveCount(0);
      await expect(page.getByTestId('tab-src/index.ts')).toBeVisible();
      await expect(page.getByTestId('agent-panel-main')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('Advanced title overrides the derived task title (full-form parity)', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-adv-title').fill('Custom charter title');
      await page
        .getByTestId('home-intent')
        .fill('[scenario:edit-basic] something long and derived');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.locator('.tr-title')).toHaveText('Custom charter title');
    } finally {
      await app.close();
    }
  });
});

/** First (most recent) task id from the sidebar rows. */
async function taskIdOf(page: import('@playwright/test').Page): Promise<string> {
  const el = page.locator('[data-testid^="home-task-"]').first();
  const testid = await el.getAttribute('data-testid');
  return testid!.replace('home-task-', '');
}
