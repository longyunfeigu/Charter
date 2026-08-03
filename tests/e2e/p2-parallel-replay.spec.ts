import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/** P2 (ADR-0006, PIVOT-016..018): parallel runs, persistent Sessions and ⌘K. */
test.describe('P2 — parallel runs, Sessions, quick launcher', () => {
  test('ADR-0006: two tasks run concurrently; the Session rail tracks both', async () => {
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

      // The persistent rail keeps both sessions visible; Home does not repeat
      // them in a second mission-control surface.
      await page.getByTestId('task-room-back').click();
      await expect(page.getByTestId('home-mc-needs')).toHaveCount(0);
      await expect(page.getByTestId('home-sidebar')).toContainText('task B in parallel');
      await expect(page.getByTestId('home-sidebar')).toContainText('task A holds a slot');

      // Jump back to A, answer, and it finishes independently.
      await page
        .locator('button[data-testid^="home-task-"]')
        .filter({ hasText: 'task A holds a slot' })
        .click();
      await expect(page.getByTestId('q-card')).toBeVisible();
      await page.getByTestId('q-option-0').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
    } finally {
      await app.close();
    }
  });

  test('PIVOT-016/017: writes surface in the Session ledger without fabricating terminal video', async () => {
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

      // The default supervision layer stays actionable: touched files appear in
      // the Session evidence ledger without opening a second Explorer shell.
      await expect(page.getByTestId('task-room-file-src/index.ts')).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // Managed ACP runs have no PTY byte stream. Terminal Replay is therefore
      // not offered; the product never invents a movie from semantic events.
      await page.getByTestId('session-more').click();
      await expect(page.getByTestId('replay-open')).toHaveCount(0);
      await expect(page.getByTestId('task-room-file-src/index.ts')).toBeVisible();
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
      const projectName = fixture.split('/').at(-1)!;
      await expect(page.getByTestId('rail-search')).toHaveCount(0);

      // A real Session title is indexed across projects.
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page
        .getByTestId('home-intent')
        .fill('[scenario:edit-basic] searchable launcher session');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30_000,
      });

      await page.keyboard.press(`${mod}+k`);
      await page.getByTestId('qk-input').fill('searchable launcher session');
      await expect(page.locator('[data-testid^="qk-task-"]')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.getByTestId('task-room-back').click();

      await page.keyboard.press(`${mod}+k`);
      await expect(page.getByTestId('qk-view')).toBeVisible();

      // File search → Enter opens the file in the editor.
      await page.getByTestId('qk-input').fill('src/index.ts');
      await expect(page.getByTestId('qk-file-src/index.ts')).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('qk-view')).toHaveCount(0);
      await expect(page.getByTestId('tab-src/index.ts')).toBeVisible();

      // Actions are searchable; project entries carry their type badge.
      await page.keyboard.press(`${mod}+k`);
      await page.getByTestId('qk-input').fill('settings');
      await expect(page.getByTestId('qk-action-settings')).toBeVisible();
      await page.getByTestId('qk-input').fill(projectName);
      const projectResult = page
        .locator('[data-testid^="qk-project-"]')
        .filter({ hasText: projectName });
      await expect(projectResult).toBeVisible();
      await expect(projectResult).toContainText('node'); // project kind badge
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('qk-view')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
