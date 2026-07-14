import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * Shell v5 (ADR-0014): the room zoom continuum. PIVOT-034 (in-room file peek),
 * PIVOT-035 (Editor demoted to explicit intent) and PIVOT-036 (room ⇄ Editor
 * continuity: task context, draft, peek survive the round-trip).
 */
test.describe('Shell v5 — in-room file peek and zoom continuity', () => {
  test('PIVOT-034/035: file references peek beside the conversation; Editor only by explicit intent', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] peek flow');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // Rail file row → peek opens IN the room (no surface switch), diff mode.
      await page.getByTestId('task-room-file-src/index.ts').click();
      await expect(page.getByTestId('file-peek')).toBeVisible();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('peek-mode-diff')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('peek-body')).toContainText('return add(3, 4);');
      // The conversation stays interactive: the composer is still there.
      await expect(page.getByTestId('room-composer')).toBeVisible();

      // File mode shows the CURRENT content through the task's mount (Monaco).
      await page.getByTestId('peek-mode-file').click();
      await expect(page.getByTestId('peek-monaco')).toBeVisible();
      await expect(page.getByTestId('peek-body')).toContainText('add(3, 4)', { timeout: 10000 });

      // Timeline evidence paths open the peek too (read tool → file mode).
      await page.getByTestId('peek-close').click();
      await expect(page.getByTestId('file-peek')).toHaveCount(0);
      await page.getByTestId('tl-path-src/index.ts').first().click();
      await expect(page.getByTestId('file-peek')).toBeVisible();
      await expect(page.getByTestId(`peek-tab-src/index.ts`)).toBeVisible();

      // Esc closes the peek and the rail returns; still in the room.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('file-peek')).toHaveCount(0);
      await expect(page.getByTestId('task-room-file-src/index.ts')).toBeVisible();

      // Escape hatch: the peek header button is an EXPLICIT Editor entry.
      await page.getByTestId('task-room-file-src/index.ts').click();
      await page.getByTestId('peek-open-editor').click();
      await expect(page.getByTestId('home-shell')).toHaveCount(0);
      await expect(page.getByTestId('agent-panel-main')).toBeVisible();
      await expect(page.getByTestId('tab-src/index.ts')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('PIVOT-036: draft and peek survive the room → Editor → room round-trip', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] continuity check');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // Open a peek and start typing a reply — then jump to the Editor.
      await page.getByTestId('task-room-file-src/index.ts').click();
      await expect(page.getByTestId('file-peek')).toBeVisible();
      await page.getByTestId('agent-input').fill('also add a unit test for main()');
      await page.getByTestId('task-room-open-editor').click();

      // The Editor carries the task context: panel visible, SAME draft text.
      await expect(page.getByTestId('home-shell')).toHaveCount(0);
      await expect(page.getByTestId('agent-panel-main')).toBeVisible();
      await expect(page.getByTestId('agent-input')).toHaveValue('also add a unit test for main()');

      // ⌂ Home returns to the same room with the draft AND the peek intact.
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('file-peek')).toBeVisible();
      await expect(page.getByTestId('agent-input')).toHaveValue('also add a unit test for main()');
    } finally {
      await app.close();
    }
  });
});
