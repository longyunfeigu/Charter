import { expect, test } from '@playwright/test';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture, createTsSmallFixture } from './helpers/fixtures';

/**
 * P4 — Review v2 (ADR-0013): Monaco side-by-side diff with per-hunk decisions,
 * "Request fix" feedback loop, and git decorations (explorer letters, tabs,
 * gutter change bars).
 */

test.describe('P4 review v2 + decorations (ADR-0013)', () => {
  test('review opens a side-by-side diff; hunk decisions still work; request-fix flows back to the agent', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-hunks] two-block change');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible();

      // The Monaco diff renders both sides of the selected file.
      await expect(page.getByTestId('review-diff')).toBeVisible();
      await expect(page.locator('[data-testid="review-diff"] .monaco-diff-editor')).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByTestId('review-hunkstrip')).toBeVisible();
      await expect(page.locator('[data-testid^="hunk-accept-"]')).toHaveCount(2);

      // Accept one hunk via the strip (same decision channel as before).
      await page.locator('[data-testid^="hunk-accept-"]').first().click();
      await expect(page.locator('[data-testid^="hunk-accept-"]')).toHaveCount(1);

      // Request fix: select a line in the modified pane → floating button → send.
      const modified = page.locator(
        '[data-testid="review-diff"] .monaco-diff-editor .editor.modified',
      );
      await expect(modified).toBeVisible();
      // Double-click selects a word — a deterministic non-empty selection.
      await modified.locator('.view-line').first().dblclick();
      await expect(page.getByTestId('review-request-fix')).toBeVisible();
      await page.getByTestId('review-request-fix').click();
      await expect(page.getByTestId('request-fix-dialog')).toBeVisible();
      await page.getByTestId('request-fix-note').fill('Use a clearer constant name here.');
      await page.getByTestId('request-fix-send').click();

      // The feedback lands in the room as the user's note with the selected
      // code attached as a structured review ref — the code-context rework
      // replaced the old "Review feedback on <path>" prose message.
      await expect(page.getByTestId('task-room')).toBeVisible();
      const feedback = page
        .getByTestId('tl-user')
        .filter({ hasText: 'Use a clearer constant name here.' })
        .first();
      await expect(feedback).toBeVisible({ timeout: 15000 });
      await expect(feedback.getByTestId('tl-code-context')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('non-git projects still get marks from the agent change records', async () => {
    const fixture = createTsSmallFixture(); // NOT a git repo
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] decorate without git');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // A non-git change remains first-class evidence. Opening it expands the
      // Session-owned File tool and mounts the real editor beside the conversation.
      await page.getByTestId('task-room-file-src/index.ts').click();
      await expect(page.getByTestId('session-diff-review')).toBeVisible();
      await page.getByTestId('session-tool-file').click();
      await page.getByTestId('peek-mode-edit').click();
      await expect(page.getByTestId('file-peek').getByTestId('editor-groups')).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByTestId('tab-src/index.ts')).toBeVisible();
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('git decorations: explorer letters, tab mark and gutter bars follow file changes', async () => {
    const fixture = createGitFixture();
    // One modified + one untracked file before launch.
    appendFileSync(join(fixture, 'src/index.ts'), '\n// decorated\n');
    writeFileSync(join(fixture, 'brand-new.ts'), 'export const fresh = 1;\n');
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture },
    });
    try {
      // The rail tree shows +N −M with amber M on the modified file and a
      // green A on the new one (untracked and added share the "new" visual).
      await page.getByTestId('rail-tab-files').click();
      await expect(page.getByTestId('tree-git-brand-new.ts')).toHaveText('A', { timeout: 15000 });
      await expect(page.getByTestId('tree-diff-brand-new.ts')).not.toBeAttached();
      const srcRow = page.getByTestId('tree-item-src');
      await expect(srcRow).toBeVisible();
      await srcRow.click(); // expand src/
      await expect(page.getByTestId('tree-git-src/index.ts')).toHaveText('M', { timeout: 15000 });
      await expect(page.getByTestId('tree-diff-src/index.ts')).toHaveText('+2−0');

      // Open the modified file: tab mark + gutter bars appear.
      await page.getByTestId('tree-item-src/index.ts').click();
      await expect(page.getByTestId('tab-git-src/index.ts')).toHaveText('M');
      await expect(page.locator('.gutter-added').first()).toBeVisible({ timeout: 15000 });
    } finally {
      await app.close();
    }
  });
});
