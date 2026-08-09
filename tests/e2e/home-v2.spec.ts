import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createGitFixture, createTsSmallFixture } from './helpers/fixtures';

/**
 * Home v2 (ADR-0005/0006, PIVOT-011..015): advanced charter, persistent Inbox,
 * context feeding. The engine flows underneath are the same ones covered by
 * E2E-009..018 — these tests cover the new shell semantics.
 */
test.describe('Home v2 — advanced charter, persistent Inbox, context feeding', () => {
  test('Codex-style @ picker references a completed conversation in a new task', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await page.getByTestId('home-mode-ask').click();
      await page.getByTestId('home-intent').fill('[scenario:ask-basic] source conversation marker');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('tl-agent').first()).toBeVisible({ timeout: 30000 });
      await page.getByTestId('task-room-back').click();

      await page.getByTestId('home-attach').click();
      await page.getByTestId('home-file-input').fill('source conversation marker');
      const sourceItem = page
        .locator('[data-testid^="home-conversation-item-"]')
        .filter({ hasText: 'source conversation marker' })
        .first();
      await expect(sourceItem).toBeVisible();
      const sourceTestId = await sourceItem.getAttribute('data-testid');
      const sourceTaskId = sourceTestId!.replace('home-conversation-item-', '');
      await sourceItem.click();
      await expect(page.getByTestId(`home-conversation-ref-${sourceTaskId}`)).toContainText(
        'source conversation marker',
      );

      await page
        .getByTestId('home-intent')
        .fill('[scenario:ask-basic] continue with the referenced decision');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId(`tl-conversation-ref-${sourceTaskId}`)).toContainText(
        'source conversation marker',
        { timeout: 30000 },
      );
      await expect(page.getByTestId('tl-user').first()).toContainText(
        'continue with the referenced decision',
      );
    } finally {
      await app.close();
    }
  });

  test('PIVOT-012/015: advanced fields and @refs land in the task charter', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      // Project is already the working directory — the chip shows it, no re-pick.
      await expect(page.getByTestId('home-project')).toContainText(fixture.split('/').pop()!);

      // Advanced charter (PIVOT-012).
      await page.getByTestId('home-advanced-toggle').click();
      await expect(page.getByTestId('home-advanced')).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Boundaries' })).toBeVisible();
      await expect(
        page.getByRole('textbox', { name: 'Success criteria (one per line)' }),
      ).toBeVisible();
      await expect(page.getByTestId('home-adv-worktree-explainer')).toContainText(
        'separate checkout and branch',
      );
      await page.getByTestId('home-adv-boundaries').fill('Do not change public API signatures');
      await page
        .getByTestId('home-adv-criteria')
        .fill('429 after 5 failed attempts\nexisting tests stay green');
      // Suggested verification from package.json scripts (VER-002 detection).
      await expect(page.getByTestId('home-verif-npm test')).toBeVisible();
      await page.getByTestId('home-verif-npm test').click();

      // @ file reference (PIVOT-015).
      await page.getByTestId('home-attach').click();
      await page.getByTestId('home-file-input').fill('index');
      await expect(page.getByTestId('home-file-item-src/index.ts')).toBeVisible();
      await page.getByTestId('home-file-item-src/index.ts').click();
      await expect(page.getByTestId('home-ref-src/index.ts')).toBeVisible();

      await page.getByTestId('home-mode-auto').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] quick change with context');
      await page.getByTestId('home-submit').click();

      // The charter carries everything into the run's opening message; submit
      // opens the Task Room (PIVOT-021/022), never the Editor.
      await expect(page.getByTestId('home-view')).toHaveCount(0);
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      const userCard = page.getByTestId('tl-user').first();
      await expect(userCard).toContainText('Constraints:');
      await expect(userCard).toContainText('Do not change public API signatures');
      await expect(userCard).toContainText('@src/index.ts');
      const taskContext = page.getByTestId('tl-task-context');
      await expect(taskContext).toContainText('Acceptance checks · 2');
      await taskContext.locator('summary').click();
      await expect(taskContext).toContainText('429 after 5 failed attempts');
    } finally {
      await app.close();
    }
  });

  test('PIVOT-013: the persistent Inbox surfaces needs-you states and drives navigation', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      // edit-basic writes a real change — REVIEW_READY must carry review weight
      // (zero-change tasks are presented as "Answered" instead, ADR-0009).
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] refactor utils');
      await page.getByTestId('home-submit').click();

      // The run pauses for plan approval; the global Inbox owns that queue.
      await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('task-room-back').click();
      await expect(page.getByTestId('home-mc-needs')).toHaveCount(0);
      await expect(page.getByTestId('rail-needs-you')).toContainText('1');
      await page.getByTestId('rail-needs-you').click();
      const needs = page.getByTestId('rail-inbox-panel');
      await expect(needs).toContainText('Plan ready');
      await expect(needs).toContainText('refactor utils');

      // Inbox row click jumps straight to the waiting task's room.
      await needs.locator('button[data-testid^="home-task-"]').first().click();
      await expect(page.getByTestId('home-view')).toHaveCount(0);
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('plan-card')).toBeVisible();
      await page.getByTestId('plan-approve').click();
      // edit mode: the write itself still asks for permission (PERM-004).
      await page.getByTestId('perm-allow-task').click({ timeout: 20000 });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // Review-ready tasks surface behind the single Inbox badge.
      await page.getByTestId('task-room-back').click();
      await expect(page.getByTestId('home-mc-needs')).toHaveCount(0);
      await expect(page.getByTestId('rail-needs-you')).toContainText('1');
      await page.getByTestId('rail-needs-you').click();
      await expect(page.getByTestId('rail-inbox-panel')).toContainText('Review');
      await page
        .locator('[data-testid="rail-inbox-panel"] [data-testid^="home-task-"]')
        .first()
        .click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('session-tool-review')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible({ timeout: 15000 });
    } finally {
      await app.close();
    }
  });

  test('configured checks are distinguished from unconfigured tasks and can be run from review', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-verif-npm test').click();
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] verified change');
      await page.getByTestId('home-submit').click();

      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      await expect(page.getByTestId('checks-unverified')).toContainText('No verification has run');
      await page.getByTestId('checks-run').click();
      await expect(page.getByTestId('tl-verification-passed')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('checks-unverified')).toHaveCount(0);
      await expect(page.getByTestId('checks-pane')).toContainText('npm test');
      await expect(page.getByTestId('checks-pane')).toContainText('passed');
      await expect(page.getByTestId('checks-run')).toContainText('Run verification');
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await expect(page.getByTestId('task-room')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('PIVOT-011/014: follow-system theme is applied and notifications are configurable', async () => {
    const { app, page } = await launchApp({ home: 'keep' });
    try {
      // Theme resolves to a concrete scheme from the system preference.
      const theme = await page.evaluate(() => document.documentElement.dataset.theme);
      expect(['light', 'dark']).toContain(theme);

      await page.getByTestId('home-settings').click();
      await expect(page.getByTestId('settings-page')).toBeVisible();
      const toggle = page.getByTestId('settings-notifications');
      await expect(toggle).toBeChecked(); // default on (PIVOT-014)
      await toggle.uncheck();
      await expect(toggle).not.toBeChecked();
    } finally {
      await app.close();
    }
  });

  test('no-model state blocks submission and links directly to Model settings', async () => {
    const { app, page } = await launchApp({ home: 'keep' });
    try {
      await expect(page.getByTestId('home-model')).toContainText('No model', { timeout: 15000 });
      await page.getByTestId('home-intent').fill('Start a task that should stay blocked');
      await expect(page.getByTestId('home-submit')).toBeDisabled();

      await page.getByTestId('home-model').click();
      await page.getByTestId('home-model-settings').click();
      await expect(page.getByTestId('settings-page')).toBeVisible();
      await expect(page.getByTestId('settings-section-models')).toHaveAttribute(
        'aria-current',
        'page',
      );
      await page.getByTestId('settings-use-mock-runtime').check();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('home-model')).toContainText('Mock Model 1');
      await expect(page.getByTestId('home-submit')).toBeEnabled();
    } finally {
      await app.close();
    }
  });
});
