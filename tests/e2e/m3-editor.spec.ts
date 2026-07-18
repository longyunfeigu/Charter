import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

test.describe('M3 workspace and editor', () => {
  test('E2E-002: edit, save, split; tabs and content restored after restart', async () => {
    const fixture = createTsSmallFixture();
    const first = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    const { page } = first;

    // Explorer shows the workspace tree.
    await expect(page.getByTestId('workspace-chip')).toBeVisible();
    await page.getByTestId('tree-item-src').click();
    await page.getByTestId('tree-item-src/index.ts').click();
    await expect(page.getByTestId('tab-src/index.ts')).toBeVisible();

    // Type into Monaco and save.
    await page.locator('.monaco-editor').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type('// edited by e2e');
    await expect(page.getByTestId('status-dirty')).toBeVisible();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect(page.getByTestId('status-dirty')).toHaveCount(0);
    expect(readFileSync(join(fixture, 'src/index.ts'), 'utf8')).toContain('// edited by e2e');

    // Open a second file and split the editor.
    await page.getByTestId('tree-item-src/util.ts').click();
    await expect(page.getByTestId('tab-src/util.ts')).toBeVisible();
    await page.getByTestId('project-editor-split').click();
    await expect(page.getByTestId('monaco-pane-1')).toBeVisible();

    await page.waitForTimeout(800); // allow tabs/layout persistence to flush
    await first.app.close();

    // Restart into the same workspace and user data.
    const second = await launchApp({
      userDataDir: first.userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: fixture },
    });
    await expect(second.page.getByTestId('tab-src/index.ts').first()).toBeVisible({
      timeout: 15000,
    });
    await expect(second.page.getByTestId('tab-src/util.ts').first()).toBeVisible();
    await expect(second.page.getByTestId('monaco-pane-1')).toBeVisible(); // split restored
    await second.app.close();
  });

  test('E2E-003: unsaved buffer vs external change — Reload/Compare/Keep, nothing lost silently', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await page.getByTestId('tree-item-src').click();
      await page.getByTestId('tree-item-src/util.ts').click();
      await page.locator('.monaco-editor').first().click();
      await page.keyboard.type('// user unsaved work\n');
      await expect(page.getByTestId('status-dirty')).toBeVisible();

      // External process rewrites the file on disk.
      writeFileSync(join(fixture, 'src/util.ts'), '// EXTERNAL OVERWRITE\n');

      // Conflict bar must appear; the buffer must keep the user's text.
      await expect(page.getByTestId('conflict-bar')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('conflict-compare')).toBeVisible();
      await expect(page.getByTestId('conflict-reload')).toBeVisible();
      await expect(page.getByTestId('conflict-keep')).toBeVisible();

      // Saving while conflicted must NOT overwrite silently.
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
      expect(readFileSync(join(fixture, 'src/util.ts'), 'utf8')).toBe('// EXTERNAL OVERWRITE\n');

      // Keep my version → explicit save now wins.
      await page.getByTestId('conflict-keep').click();
      await expect(page.getByTestId('conflict-bar')).toHaveCount(0);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
      await expect
        .poll(() => readFileSync(join(fixture, 'src/util.ts'), 'utf8'))
        .toContain('// user unsaved work');
    } finally {
      await app.close();
    }
  });

  test('external change with clean buffer auto-reloads', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await page.getByTestId('tree-item-README.md').click();
      await expect(page.getByTestId('tab-README.md')).toBeVisible();
      writeFileSync(join(fixture, 'README.md'), '# Reloaded externally\n');
      await expect(page.locator('.monaco-editor').first()).toContainText('Reloaded externally', {
        timeout: 15000,
      });
    } finally {
      await app.close();
    }
  });

  test('agent edit refreshes an already-open clean model and review closes without Monaco errors', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    try {
      await page.getByTestId('tree-item-src').click();
      await page.getByTestId('tree-item-src/index.ts').click();
      await expect(page.locator('.monaco-editor').first()).toContainText('add(2, 3)');

      await page.getByTestId('home-new-task').click();
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] update the call');
      await page.getByTestId('home-submit').click();

      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      await page.getByTestId('task-room-file-src/index.ts').click();
      await expect(page.getByTestId('session-diff-review')).toBeVisible();
      await page.getByTestId('session-tool-file').click();
      await page.getByTestId('peek-mode-edit').click();
      const editor = page.locator('.tr-peek-editor .monaco-editor').first();
      await expect(editor).toContainText('add(3, 4)', { timeout: 15000 });
      await expect(editor).not.toContainText('add(2, 3)');
      await expect(page.getByTestId('conflict-bar')).toHaveCount(0);
      await expect(page.getByTestId('status-dirty')).toHaveCount(0);

      await page.getByTestId('session-tool-review').click();
      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-diff')).toBeVisible();
      await expect(page.locator('[data-testid="review-diff"] .monaco-diff-editor')).toBeVisible({
        timeout: 15000,
      });
      await page.getByTestId('review-close').click();
      await expect(page.getByTestId('review-view')).toHaveCount(0);
      await page.waitForTimeout(500);

      expect(
        consoleErrors.filter(
          (message) =>
            message.includes('Could not find source file: review://') ||
            message.includes('TextModel got disposed before DiffEditorWidget model got reset'),
        ),
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
