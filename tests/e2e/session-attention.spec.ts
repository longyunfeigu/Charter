import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

test.describe('Session completion attention', () => {
  test('the active Session owns its completion state without covering header actions', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await page.getByTestId('home-mode-auto').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page
        .getByTestId('home-intent')
        .fill('[scenario:edit-basic] active completion stays in the room');
      await page.getByTestId('home-submit').click();

      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30_000,
      });
      await expect(page.getByTestId('session-more')).toBeVisible();
      await expect(page.getByTestId('session-completion-notice')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('completion updates the row live, ripples, and a top-right notice reveals the Session', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    try {
      await expect(page).toHaveTitle(/Charter/i);
      expect(page.url()).toMatch(/^app:\/\//);
      await expect(page.getByTestId('workbench')).toBeVisible();
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-view')).toBeVisible();

      await page.getByTestId('home-mode-auto').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page
        .getByTestId('home-intent')
        .fill('[scenario:edit-live] live completion notification');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await page.getByTestId('task-room-back').click();
      await page.getByTestId('rail-view-sessions').click();

      const notice = page.getByTestId('session-completion-notice').first();
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(notice).toContainText('Ready for review');
      await expect(notice).toContainText('live completion notification');
      const taskId = await notice.getAttribute('data-task-id');
      expect(taskId).toBeTruthy();

      const row = page.getByTestId(`home-task-${taskId!}`);
      await expect(row).toHaveAttribute('data-state', 'REVIEW_READY');
      await expect(row).toHaveAttribute('data-completion', 'review');
      await expect(row).toHaveAttribute('data-reply', 'true');
      await expect(row).toHaveClass(/reply-shake/);
      await expect(row).toHaveCSS('animation-name', 'srAttentionFade');
      await expect(row).toHaveCSS('animation-duration', '1.2s');
      await expect(row.locator('.sr-provider')).toHaveClass(/session-wave/);
      await expect(row).toContainText('Review');
      await page.screenshot({ path: '/tmp/charter-session-completion-desktop.png' });

      await row.evaluate((element) => {
        const animation = element
          .getAnimations()
          .find(
            (candidate) =>
              candidate instanceof CSSAnimation && candidate.animationName === 'srAttentionFade',
          );
        if (animation) {
          animation.pause();
          animation.currentTime = 286;
        }
      });
      await page.setViewportSize({ width: 820, height: 720 });
      const rowBox = await row.boundingBox();
      expect(rowBox).not.toBeNull();
      expect(rowBox!.x).toBeGreaterThanOrEqual(0);
      expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(820);
      await page.screenshot({ path: '/tmp/charter-session-reply-attention-narrow.png' });

      await notice.getByRole('button', { name: /Open Session/i }).click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY');
      await expect(page.getByTestId('rail-view-sessions')).toHaveClass(/active/);
      await expect(row).toHaveClass(/selected/);

      await expect(page.getByTestId('task-room')).toBeVisible();
      await page.screenshot({ path: '/tmp/charter-session-completion-narrow.png' });
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('each project shows three Sessions until its own More is expanded', async () => {
    const fixture = createTsSmallFixture();
    const secondFixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.evaluate(
        async (projects) => {
          const product = (
            window as unknown as {
              product: {
                rpc: Record<
                  string,
                  (payload: unknown) => Promise<{
                    ok: boolean;
                    error?: { userMessage?: string };
                  }>
                >;
              };
            }
          ).product;
          for (const project of projects) {
            for (let index = 0; index < project.count; index += 1) {
              const result = await product.rpc['task.create']!({
                title: `${project.prefix} Session ${String(index + 1).padStart(2, '0')}`,
                goalMd: 'Exercise the per-project Session More control',
                acceptance: [],
                mode: 'ask',
                model: { providerId: 'mock', modelId: 'mock-1' },
                verification: [],
                projectPath: project.path,
                isolation: 'none',
                conversationRefTaskIds: [],
              });
              if (!result.ok) throw new Error(result.error?.userMessage ?? 'task.create failed');
            }
          }
        },
        [
          { path: fixture, prefix: 'Primary', count: 5 },
          { path: secondFixture, prefix: 'Secondary', count: 4 },
        ],
      );

      await page.reload();
      await expect(page.getByTestId('workbench')).toBeVisible();
      await page.getByTestId('rail-view-sessions').click();
      const primary = page.getByTestId(`rail-session-group-${basename(fixture)}`);
      const secondary = page.getByTestId(`rail-session-group-${basename(secondFixture)}`);
      await expect(primary.locator('[data-session-key^="task:"]')).toHaveCount(3);
      await expect(secondary.locator('[data-session-key^="task:"]')).toHaveCount(3);

      const primaryMore = primary.getByTestId('rail-group-more');
      const secondaryMore = secondary.getByTestId('rail-group-more');
      await expect(primaryMore).toContainText('2 more');
      await expect(secondaryMore).toContainText('1 more');
      await page.screenshot({ path: '/tmp/charter-session-group-more-collapsed.png' });
      await primaryMore.click();
      await expect(primary.locator('[data-session-key^="task:"]')).toHaveCount(5);
      await expect(secondary.locator('[data-session-key^="task:"]')).toHaveCount(3);
      await expect(primaryMore).toContainText('Show less');
      await page.screenshot({ path: '/tmp/charter-session-group-more-expanded.png' });
      await primaryMore.click();
      await expect(primary.locator('[data-session-key^="task:"]')).toHaveCount(3);

      await page.setViewportSize({ width: 820, height: 720 });
      await expect(primary).toBeVisible();
      await expect(primaryMore).toBeVisible();
      await page.screenshot({ path: '/tmp/charter-session-group-more-narrow.png' });

      await page.getByTestId('rail-session-search').fill('Primary Session 05');
      await expect(page.locator('[data-session-key^="task:"]')).toHaveCount(1);
      await expect(page.locator('[data-session-key^="task:"]').first()).toContainText(
        'Primary Session 05',
      );
      await expect(page.getByTestId('rail-group-more')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('History is grouped by time and each period paginates independently', async () => {
    const fixture = createTsSmallFixture();
    const { app, page, userDataDir } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      const localTimestamp = (daysAgo: number, minute: number): string => {
        const value = new Date();
        value.setDate(value.getDate() - daysAgo);
        value.setHours(12, minute, 0, 0);
        return value.toISOString();
      };
      const specs = [
        { title: 'History today', updatedAt: localTimestamp(0, 0) },
        { title: 'History yesterday', updatedAt: localTimestamp(1, 0) },
        { title: 'History previous week', updatedAt: localTimestamp(3, 0) },
        ...Array.from({ length: 17 }, (_, index) => ({
          title: `History previous month ${String(index + 1).padStart(2, '0')}`,
          updatedAt: localTimestamp(12, index),
        })),
        { title: 'History older one', updatedAt: localTimestamp(45, 0) },
        { title: 'History older two', updatedAt: localTimestamp(60, 0) },
      ];

      const created = await page.evaluate(
        async ({ projectPath, sessions }) => {
          const product = (
            window as unknown as {
              product: {
                rpc: Record<
                  string,
                  (payload: unknown) => Promise<{
                    ok: boolean;
                    data?: { task?: { id: string } };
                    error?: { userMessage?: string };
                  }>
                >;
              };
            }
          ).product;
          const rows: Array<{ id: string; updatedAt: string }> = [];
          for (const session of sessions) {
            const result = await product.rpc['task.create']!({
              title: session.title,
              goalMd: 'Exercise History time grouping and per-period pagination',
              acceptance: [],
              mode: 'ask',
              model: { providerId: 'mock', modelId: 'mock-1' },
              verification: [],
              projectPath,
              isolation: 'none',
              conversationRefTaskIds: [],
            });
            if (!result.ok || !result.data?.task) {
              throw new Error(result.error?.userMessage ?? 'task.create failed');
            }
            rows.push({ id: result.data.task.id, updatedAt: session.updatedAt });
          }
          return rows;
        },
        { projectPath: fixture, sessions: specs },
      );

      execFileSync('/usr/bin/sqlite3', [
        join(userDataDir, 'app.db'),
        created
          .map(
            ({ id, updatedAt }) =>
              `UPDATE tasks SET state = 'ACCEPTED', updated_at = '${updatedAt}' WHERE id = '${id}';`,
          )
          .join('\n'),
      ]);

      await page.reload();
      await expect(page.getByTestId('workbench')).toBeVisible();
      await page.getByTestId('rail-view-sessions').click();
      const historyToggle = page.getByTestId('rail-group-history');
      await expect(historyToggle).toContainText(String(specs.length));
      await expect(historyToggle).toHaveAttribute('aria-expanded', 'false');
      await historyToggle.click();

      for (const period of ['today', 'yesterday', 'previous-7-days', 'previous-30-days']) {
        await expect(page.getByTestId(`rail-history-period-${period}`)).toBeVisible();
        await expect(page.getByTestId(`rail-history-period-toggle-${period}`)).toHaveAttribute(
          'aria-expanded',
          'true',
        );
      }
      await expect(page.getByTestId('rail-history-period-toggle-older')).toHaveAttribute(
        'aria-expanded',
        'false',
      );

      const previousMonth = page.getByTestId('rail-history-period-previous-30-days');
      const previousMonthMore = page.getByTestId('rail-history-more-previous-30-days');
      await expect(previousMonth.locator('[data-session-key^="task:"]')).toHaveCount(5);
      await expect(previousMonthMore).toContainText('12 more');
      await previousMonthMore.click();
      await expect(previousMonth.locator('[data-session-key^="task:"]')).toHaveCount(15);
      await expect(previousMonthMore).toContainText('2 more');
      await previousMonthMore.click();
      await expect(previousMonth.locator('[data-session-key^="task:"]')).toHaveCount(17);
      await expect(previousMonthMore).toContainText('Show less');
      await previousMonthMore.click();
      await expect(previousMonth.locator('[data-session-key^="task:"]')).toHaveCount(5);
      await page.screenshot({ path: '/tmp/charter-history-periods-desktop.png' });

      await page.getByTestId('rail-session-search').fill('History older two');
      await expect(historyToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('rail-history-period-toggle-older')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(page.getByText('History older two', { exact: true })).toBeVisible();
      await expect(page.locator('[data-testid^="rail-history-more-"]')).toHaveCount(0);
      await page.getByTestId('rail-session-search').fill('');
      await expect(page.getByTestId('rail-history-period-toggle-older')).toHaveAttribute(
        'aria-expanded',
        'false',
      );

      await page.setViewportSize({ width: 820, height: 720 });
      await expect(previousMonth).toBeVisible();
      await page.screenshot({ path: '/tmp/charter-history-periods-narrow.png' });
    } finally {
      await app.close();
    }
  });
});
