import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function createTask(
  page: import('@playwright/test').Page,
  goal: string,
  mode: 'ask' | 'edit' | 'auto',
  title: string,
) {
  await page.getByTestId('surface-home').click();
  await page.getByTestId('home-advanced-toggle').click();
  await page.getByTestId('home-adv-title').fill(title);
  await page.getByTestId('home-intent').fill(goal);
  await page.getByTestId(`home-mode-${mode}`).click();
  await expect(page.getByTestId('home-model')).toContainText(/mock/i);
  await page.getByTestId('home-submit').click();
}

test.describe('M8 agent writes, plan approval and review (E2E-010/011/014/015)', () => {
  test('E2E-010: edit task patches 3 files, runs tests, REVIEW_READY, accept settles the turn (ADR-0032)', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.setViewportSize({ width: 980, height: 760 });
      // The scenario runs tests via run_command (not run_verification), so
      // accepting later uses the explicit unverified-accept step (VER-007).
      await createTask(page, '[scenario:edit-multifile] cross-file change', 'edit', 'Multi');

      // Plan approval gate (AG-007): the run pauses until the user approves.
      await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('task-state')).toHaveAttribute(
        'data-state',
        'AWAITING_PLAN_APPROVAL',
      );
      await page.getByTestId('plan-approve').click();

      // First write asks for permission with a real diff preview (PERM-004).
      await expect(page.getByTestId('perm-card')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('perm-risk')).toHaveText('R1');
      await expect(page.getByTestId('perm-card')).toContainText('+  return add(3, 4);');
      expect(
        await page.getByTestId('perm-risk').evaluate((risk) => {
          const rect = risk.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return hit === risk || risk.contains(hit);
        }),
      ).toBe(true);
      // Scope "task" covers the second apply_patch without another prompt (PERM-002).
      await page.getByTestId('perm-allow-task').click();
      await expect(page.getByTestId('perm-card-resolved').last()).not.toContainText('apply_patch');

      // create_file is a different action kind → asks again.
      await expect(page.getByTestId('perm-card')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('perm-card')).toContainText('Create a file');
      await page.getByTestId('perm-allow-once').click();

      // Recognized verification command still asks in edit mode.
      await expect(page.getByTestId('perm-card')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('perm-card')).toContainText('npm test');
      await page.getByTestId('perm-allow-once').click();

      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // ≥3 files really changed on disk.
      expect(readFileSync(join(fixture, 'src/index.ts'), 'utf8')).toContain('add(3, 4)');
      expect(readFileSync(join(fixture, 'src/util.ts'), 'utf8')).toContain('mul');
      expect(existsSync(join(fixture, 'src/created-by-agent.ts'))).toBe(true);

      // Review shows the change set; accepting settles the turn to IDLE (§6.1 as amended by ADR-0032).
      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible();
      await expect(page.getByTestId('review-file-src/index.ts')).toBeVisible();
      await expect(page.getByTestId('review-file-src/util.ts')).toBeVisible();
      await expect(page.getByTestId('review-file-src/created-by-agent.ts')).toBeVisible();
      await page.getByTestId('review-accept-all').click();
      await page.getByTestId('review-accept-all-confirm').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 20000,
      });
      await expect(page.getByTestId('tl-accepted')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('E2E-011: user edits the proposed plan; agent follows the edited version; history kept', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await createTask(page, '[scenario:edit-plan-review] refactor utils', 'edit', 'Plan review');

      await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('plan-edit-toggle').click();
      await page.getByTestId('plan-step-input-0').fill('REWRITE the util module carefully');
      await page.getByTestId('plan-approve').click();

      // The edit and the decision are immutable events…
      await expect(page.getByTestId('tl-plan-edited')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('tl-plan-decision')).toContainText('approved');
      await expect(page.getByTestId('tl-plan-decision')).toContainText('edits');

      // …and the agent demonstrably received the edited plan (AG-008).
      await expect(
        page.getByTestId('tl-agent').filter({ hasText: 'REWRITE the util module carefully' }),
      ).toHaveCount(1, { timeout: 20000 });
      // ADR-0032: this scenario changes no files — the turn settles as
      // answered and the conversation is immediately continuable.
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 20000,
      });

      // The original proposal remains in the timeline (history not overwritten):
      // the static card still shows plan v1; expanding reveals the original step.
      await expect(page.getByTestId('plan-card-static')).toContainText('Plan v1');
      await page.getByTestId('plan-card-static').locator('button').first().click();
      await expect(page.getByTestId('plan-card-static')).toContainText('Tidy the add function');
    } finally {
      await app.close();
    }
  });

  test('E2E-014: user edits after the agent read; stale patch conflicts; nothing overwritten', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await createTask(page, '[scenario:edit-conflict] concurrent edit', 'auto', 'Conflict');

      // The scenario pauses on ask_user after reading the file.
      await expect(page.getByTestId('q-card')).toBeVisible({ timeout: 20000 });

      // User edits the same file in the editor while the agent is paused.
      await page.keyboard.press(`${mod}+p`);
      await expect(page.getByTestId('quick-open')).toBeVisible();
      await page.getByRole('textbox', { name: 'File name' }).fill('index');
      const indexResult = page.getByTestId('quickopen-item-src/index.ts');
      await expect(indexResult).toBeVisible();
      await indexResult.click();
      await expect(page.getByTestId('tab-src/index.ts')).toBeVisible();
      // Wait for the model content to actually render before positioning the
      // cursor — clicking an empty editor would drop the typing at line 1.
      await expect(page.locator('.monaco-editor').first()).toContainText('add(2, 3)');
      await page.locator('.monaco-editor').first().click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
      await page.keyboard.press('End');
      await page.keyboard.insertText('\n// keep me');
      await expect(page.locator('.monaco-editor').first()).toContainText('// keep me');
      // Observe the dirty transition before waiting for it to clear; otherwise
      // a fast count=0 check can pass against the pre-render state while the
      // asynchronous save response is still being projected into the store.
      await expect(page.getByTestId('status-dirty')).toContainText('1 unsaved');
      await page.keyboard.press(`${mod}+s`);
      // The edit must land at the end of the file (patch context lines intact).
      await expect
        .poll(() => readFileSync(join(fixture, 'src/index.ts'), 'utf8'))
        .toMatch(/\}\s*\n\/\/ keep me/);
      // Cmd/Ctrl+S starts an async RPC. Disk bytes can be visible before the
      // renderer has consumed the save response and cleared its dirty flag;
      // continuing in that window would make the later agent-write broadcast
      // look like an external overwrite of unsaved editor text.
      await expect(page.getByTestId('status-dirty')).toHaveCount(0);

      // Let the agent continue: the stale patch must fail with a version conflict.
      await page.getByTestId('q-option-0').click();
      await expect(page.getByTestId('tl-conflict')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('tl-conflict')).toContainText('nothing was overwritten', {
        ignoreCase: true,
      });

      // The agent re-reads and retries. Assert the retry itself completed so a
      // regression reports the gateway result instead of only the settled task
      // state (a zero-change failed retry correctly settles as Answered/IDLE).
      // The failed stale call renders as the dedicated conflict card above;
      // the ordinary tool row is therefore the retry only.
      const patchCalls = page.getByTestId('tl-tool-apply_patch');
      await expect(patchCalls).toHaveCount(1, { timeout: 20000 });
      const retry = patchCalls.first();
      await retry.locator('button').click();
      await expect(retry).toHaveAttribute('data-state', 'SUCCEEDED');

      // Both the user's line and the successful agent change survive.
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      await expect(page.getByTestId('tl-done').last()).toContainText('Done');
      await expect(page.getByTestId('tl-done').last()).not.toContainText('Latest request failed');
      const content = readFileSync(join(fixture, 'src/index.ts'), 'utf8');
      expect(content).toContain('// keep me');
      expect(content).toContain('add(3, 4)');
    } finally {
      await app.close();
    }
  });

  test('E2E-015: accept one hunk, reject another; file and UI stay consistent', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await createTask(page, '[scenario:edit-hunks] two-block change', 'auto', 'Hunks');
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible();
      await expect(page.getByTestId('review-file-src/mathlib.ts')).toBeVisible();

      // Two independent hunks are shown.
      const acceptButtons = page.locator('[data-testid^="hunk-accept-"]');
      await expect(acceptButtons).toHaveCount(2);

      // Accept the first (alpha) hunk…
      await acceptButtons.first().click();
      await expect(acceptButtons).toHaveCount(1);

      // …and reject the second (omega) hunk: it is reverse-applied on disk.
      await page.locator('[data-testid^="hunk-reject-"]').first().click();
      await expect(page.locator('[data-testid^="hunk-reject-"]')).toHaveCount(0, {
        timeout: 10000,
      });

      const content = readFileSync(join(fixture, 'src/mathlib.ts'), 'utf8');
      expect(content).toContain('return x + 100;'); // accepted hunk kept
      expect(content).toContain('return x / 2;'); // rejected hunk restored
      expect(content).not.toContain('return x / 4;');

      // UI reflects the file: the rejected hunk vanished from the net diff and the
      // remaining hunk is accepted, so the file reads as fully accepted.
      await expect(page.getByTestId('review-file-state-src/mathlib.ts')).toHaveText('accepted');
      await expect(page.locator('[data-testid^="hunk-state-"]').first()).toHaveText('accepted');
    } finally {
      await app.close();
    }
  });
});
