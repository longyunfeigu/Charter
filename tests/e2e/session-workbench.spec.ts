import { expect, test } from '@playwright/test';
import { realpathSync } from 'node:fs';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

test.describe('Session Rail Workbench', () => {
  test('keeps Sessions present across Pi, in-room editing and the full workspace', async () => {
    const fixture = realpathSync(createGitFixture());
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    try {
      await expect(page.getByTestId('home-sidebar')).toBeVisible();

      // New Session returns directly to the Codex-style task composer; choosing
      // a different native execution surface remains one secondary action away.
      await page.getByTestId('home-new-task').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await page.getByTestId('session-new-menu').click();
      await expect(page.getByTestId('session-create-dialog')).toBeVisible();
      await page.getByTestId('session-kind-claude').click();
      await expect(page.getByTestId('session-create-submit')).toContainText('Claude Session');
      await page.getByTestId('session-kind-codex').click();
      await expect(page.getByTestId('session-create-submit')).toContainText('Codex Session');
      await page.getByTestId('session-kind-pi').click();
      await page.getByTestId('session-create-submit').click();

      await expect(page.getByTestId('home-view')).toBeVisible();
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] session-first edit');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // The real Monaco document model opens beside the continuous Pi run.
      await page.getByTestId('task-room-edit-file').click();
      await expect(page.getByTestId('peek-mode-edit')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('file-peek').getByTestId('editor-groups')).toBeVisible();
      await expect(page.getByTestId('home-sidebar')).toBeVisible();

      // The expert workspace is another view in the same Session shell, not a
      // second global entry; the selected Session remains visible and resumable.
      await page.getByTestId('task-room-open-editor').click();
      await expect(page.getByTestId('editor-area')).toBeVisible();
      await expect(page.getByTestId('home-sidebar')).toContainText('session-first edit');
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('file-peek')).toBeVisible();

      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
