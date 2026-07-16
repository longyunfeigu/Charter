import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

async function createAskTask(
  page: import('@playwright/test').Page,
  goal: string,
  title = 'Ask task',
) {
  await page.getByTestId('new-task-btn').click();
  await expect(page.getByTestId('new-task-dialog')).toBeVisible();
  await page.getByTestId('task-title').fill(title);
  await page.getByTestId('task-goal').fill(goal);
  await page.getByTestId('mode-ask').check();
  // mock model auto-selected under PI_IDE_FORCE_MOCK
  await expect(page.getByTestId('task-model')).toHaveValue(/mock/);
  await page.getByTestId('task-create-start').click();
}

test.describe('M6 read-only agent with deterministic runtime', () => {
  test('E2E-009: ask task streams an answer, reads through the gateway, ends REVIEW_READY', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await createAskTask(
        page,
        '[scenario:ask-with-read] [target:package.json] What does this project do?',
      );
      // Timeline: user message → streaming → tool call → final agent message.
      await expect(page.getByTestId('tl-user')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('tl-tool-read_file')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('tl-tool-read_file')).toHaveAttribute(
        'data-state',
        'SUCCEEDED',
      );
      await expect(page.getByTestId('tl-agent').last()).toContainText('package.json', {
        timeout: 20000,
      });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 20000,
      });
      await expect(page.getByTestId('tl-report')).toBeVisible();
      // Usage remains recorded but is summarized once instead of interrupting
      // each turn in the conversation.
      const details = page.getByTestId('tl-run-details');
      await details.locator('summary').click();
      await expect(details).toContainText('Tokens');
    } finally {
      await app.close();
    }
  });

  test('E2E-009b: write tools are refused in ask mode and the agent continues', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await createAskTask(page, '[scenario:edit-basic] please change src/index.ts', 'Sneaky write');
      // read_file succeeds; apply_patch must NOT execute (unknown/denied in ask catalog).
      await expect(page.getByTestId('tl-tool-apply_patch')).toBeVisible({ timeout: 20000 });
      const card = page.getByTestId('tl-tool-apply_patch');
      await expect(card).not.toHaveAttribute('data-state', 'SUCCEEDED');
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 20000,
      });
    } finally {
      await app.close();
    }
  });

  test('E2E-019 (core): SIGKILL the agent worker mid-run — window stays alive, task INTERRUPTED', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await createAskTask(page, '[scenario:slow] long analysis please', 'Slow task');
      await expect(page.getByTestId('tl-user')).toBeVisible({ timeout: 20000 });

      // Find the worker pid from diagnostics and SIGKILL it.
      const pid = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<
                string,
                (p: unknown) => Promise<{
                  ok: boolean;
                  data?: { components: Array<{ name: string; detail: string }> };
                }>
              >;
            };
          }
        ).product;
        const res = await bridge.rpc['diagnostics.get']!({});
        const worker = res.data?.components.find((c) => c.name === 'agent-worker');
        const match = worker?.detail.match(/pid (\d+)/);
        return match ? Number(match[1]) : null;
      });
      expect(pid).not.toBeNull();
      process.kill(pid!, 'SIGKILL');

      await expect(page.getByTestId('tl-crash')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'INTERRUPTED', {
        timeout: 20000,
      });
      // Window is still fully alive: open the palette.
      await page.getByTestId('palette-chip').click();
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
      await page.keyboard.press('Escape');
      // Timeline survives a restart (HIST-002 core): relaunch and reopen the task.
    } finally {
      await app.close();
    }
  });

  test('task history is rebuilt after app restart (HIST-002)', async () => {
    const fixture = createTsSmallFixture();
    const first = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    await createAskTask(first.page, '[scenario:ask-basic] describe the repo', 'History task');
    await expect(first.page.getByTestId('task-state')).toHaveAttribute(
      'data-state',
      'REVIEW_READY',
      {
        timeout: 20000,
      },
    );
    await first.app.close();

    const second = await launchApp({
      userDataDir: first.userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await second.page.getByTestId('activity-tasks').click();
      const item = second.page.locator('[data-testid^="task-item-"]').first();
      await expect(item).toBeVisible({ timeout: 15000 });
      await expect(item).toContainText('History task');
      await item.click();
      await expect(second.page.getByTestId('tl-user')).toBeVisible({ timeout: 15000 });
      await expect(second.page.getByTestId('tl-agent').last()).toContainText('deterministic', {
        timeout: 15000,
      });
    } finally {
      await second.app.close();
    }
  });
});
