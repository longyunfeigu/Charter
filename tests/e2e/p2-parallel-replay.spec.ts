import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/** P2 (ADR-0006, PIVOT-016..018): parallel runs, presence glow, replay, ⌘K. */
test.describe('P2 — parallel runs, session replay, quick launcher', () => {
  test('ADR-0006: two tasks run concurrently; mission control tracks both', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      // Task A pauses mid-run on an ask_user question (holds its run slot).
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-conflict] task A holds a slot');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('q-card')).toBeVisible({ timeout: 20000 });

      // Task B starts WHILE A is still running — with a single slot it would
      // queue forever (A only ends after its question is answered).
      await page.getByTestId('task-room-back').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-hunks] task B in parallel');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // Mission control: B needs review, A still running.
      await page.getByTestId('task-room-back').click();
      await expect(page.getByTestId('home-mc-needs')).toContainText('task B in parallel');
      await expect(page.getByTestId('home-mc-running')).toContainText('task A holds a slot');

      // Jump back to A, answer, and it finishes independently.
      await page.getByTestId('home-mc-running').locator('button.hm-tcard').first().click();
      await expect(page.getByTestId('q-card')).toBeVisible();
      await page.getByTestId('q-option-0').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
    } finally {
      await app.close();
    }
  });

  test('PIVOT-016/017: writes glow in the tree; replay walks the recorded actions', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] glow and replay');
      await page.getByTestId('home-submit').click();

      // Presence glow: the touched directory pulses right after the write (PIVOT-016).
      await expect(page.getByTestId('tree-item-src')).toHaveClass(/glow-pulse/, {
        timeout: 15000,
      });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // Replay (PIVOT-017): action-centric scrubber over the recorded log.
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-view')).toBeVisible();
      await expect(page.getByTestId('replay-count')).toContainText('step 1 /');

      // Step forward until the edit action; its stored per-step patch renders.
      for (let i = 0; i < 30; i += 1) {
        const label = await page.getByTestId('replay-step').textContent();
        if (label?.includes('Edited src/index.ts')) break;
        await page.getByTestId('replay-next').click();
      }
      await expect(page.getByTestId('replay-step')).toContainText('Edited src/index.ts');
      await expect(page.getByTestId('replay-diff')).toContainText('+  return add(3, 4);');
      await expect(page.getByTestId('replay-files')).toContainText('src/index.ts');

      // Keyboard: ← steps back; Escape closes; the working tree was never touched.
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('replay-step')).not.toContainText('Edited src/index.ts');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('replay-view')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('PIVOT-018: ⌘K searches files, tasks and actions, keyboard only', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.keyboard.press(`${mod}+k`);
      await expect(page.getByTestId('qk-view')).toBeVisible();

      // File search → Enter opens the file in the editor.
      await page.getByTestId('qk-input').fill('index');
      await expect(page.getByTestId('qk-file-src/index.ts')).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('qk-view')).toHaveCount(0);
      await expect(page.getByTestId('tab-src/index.ts')).toBeVisible();

      // Actions are searchable; project entries carry their type badge.
      await page.keyboard.press(`${mod}+k`);
      await page.getByTestId('qk-input').fill('settings');
      await expect(page.getByTestId('qk-action-settings')).toBeVisible();
      await page.getByTestId('qk-input').fill('');
      await expect(page.getByTestId('qk-view')).toContainText('node'); // project kind badge
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('qk-view')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
