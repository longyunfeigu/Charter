import { test, expect } from '@playwright/test';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch.js';
import { createTsSmallFixture, createGitFixture } from './helpers/fixtures.js';

/**
 * Shell v4 (ADR-0009, PIVOT-028..032): persistent shell, global cross-project
 * tasks on a multi-mount engine, worktree isolation with merge-back, the
 * composer as the plan "Request changes" control, and light completion for
 * zero-change tasks.
 */

test.describe('Shell v4 — persistent shell (PIVOT-028)', () => {
  test('the sidebar stays alive inside a Task Room and navigates between rooms and launcher', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-intent').fill('[scenario:edit-plan-review] shell walk');
      await page.getByTestId('home-submit').click();

      // Submitting opens the room — the sidebar must still be there (PIVOT-028).
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 20000 });

      // The room's task row is highlighted in the sidebar.
      const row = page.locator('[data-testid^="home-task-"]').first();
      await expect(row).toHaveClass(/sel/);

      // "New task" returns to the launcher without losing the room's task.
      await page.getByTestId('home-new-task').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(page.getByTestId('home-sidebar')).toBeVisible();

      // Clicking the sidebar task row re-enters its room directly.
      await row.click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('plan-card')).toBeVisible();

      // Settings opens as an overlay ON TOP of Home — no surface maroon trap.
      await page.getByTestId('home-settings').click();
      await expect(page.getByTestId('overlay-settings')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('task-room')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});

test.describe('Shell v4 — global tasks on a multi-mount engine (ADR-0009)', () => {
  test('a task launched in project A stays alive, approvable and finishable while project B is focused', async () => {
    const projectA = realpathSync(createTsSmallFixture());
    const projectB = realpathSync(createTsSmallFixture());

    // Register B in the recents list, then relaunch focused on A.
    const first = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: projectB, PI_IDE_FORCE_MOCK: '1' },
    });
    const userDataDir = first.userDataDir;
    await first.app.close();

    const { app, page } = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: projectA, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-intent').fill('[scenario:edit-plan-review] cross project plan');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 20000 });

      // Back home, focus project B — the pending task must NOT be cancelled.
      // Its Files context replaces the former duplicate tree in Projects.
      await page.getByTestId('task-room-back').click();
      await page.getByTestId('rail-context').click();
      await page.getByTestId(`home-recent-${projectB}`).click();
      await expect(page.getByTestId('project-tool-view')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('home-project-tree')).toHaveCount(0);
      await expect(page.locator('.project-tool-title')).toContainText(
        projectB.split('/').pop() ?? 'fixture',
        { timeout: 15000 },
      );

      // The A-task is still in the global sidebar, grouped under its project.
      await page.getByTestId('rail-view-sessions').click();
      const row = page.locator('[data-testid^="home-task-"]').first();
      await expect(row).toBeVisible();
      await expect(row).toHaveAttribute('data-state', 'AWAITING_PLAN_APPROVAL');
      await expect(page.getByTestId('rail-needs-you')).toContainText('1');

      // Open its room from B, approve the plan there — multi-mount execution.
      await row.click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('task-room-project')).toContainText(
        projectA.split('/').pop() ?? 'fixture',
      );
      await page.getByTestId('plan-approve').click();

      // edit-plan-review writes nothing → light completion (PIVOT-031, ADR-0032):
      // the answered turn settles straight to the IDLE conversation.
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 30000,
      });
      await expect(page.getByTestId('task-room-answered')).toBeVisible();
      await expect(page.getByTestId('tl-answered')).toBeVisible();
      // ADR-0016: no Done ceremony and no review bar for an answered task.
      await expect(page.getByTestId('tl-done')).toHaveCount(0);
      await expect(page.getByTestId('tl-accepted')).toHaveCount(0);
      await expect(page.getByTestId('review-bar')).toHaveCount(0);
      await expect(page.getByTestId('review-bar-open')).toHaveCount(0);
      await expect(page.getByTestId('task-done')).toHaveCount(0);

      // Defense in depth: stale clients may still send task.accept. Repeating
      // it for an already answered turn is a no-op and must not write events.
      const taskTestId = await row.getAttribute('data-testid');
      const taskId = taskTestId?.slice('home-task-'.length);
      expect(taskId).toBeTruthy();
      const acceptedEventCount = await page.evaluate(async (id) => {
        const bridge = window.product.rpc;
        const payload = {
          taskId: id,
          confirmUnverified: false,
          confirmConflicts: false,
        };
        await bridge['task.accept']!(payload);
        await bridge['task.accept']!(payload);
        const snapshot = await bridge['task.get']!({ taskId: id, eventsAfter: 0 });
        if (!snapshot.ok) return -1;
        return (snapshot.data as { timeline: Array<{ type: string }> }).timeline.filter(
          (event) => event.type === 'task.accepted',
        ).length;
      }, taskId!);
      expect(acceptedEventCount).toBe(0);
    } finally {
      await app.close();
    }
  });
});

test.describe('Shell v4 — worktree isolation and merge-back (ADR-0009)', () => {
  test('an isolated Session never touches the main tree until ARCHIVE merges it back (ADR-0032)', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-advanced-toggle').click();
      const wt = page.getByTestId('home-adv-worktree');
      await expect(wt).toBeVisible();
      await wt.check();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] isolated fix');
      await page.getByTestId('home-submit').click();

      // Room header shows the isolation branch (ADR-0009 am.2: its own chip
      // with terminal/Finder escape hatches; slug-based branch name).
      await expect(page.getByTestId('task-room-worktree')).toContainText('charter/', {
        timeout: 20000,
      });
      await page.getByTestId('plan-approve').click();
      await page.getByTestId('perm-allow-task').click({ timeout: 20000 });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // The agent edited the file — but only inside the worktree.
      expect(readFileSync(join(fixture, 'src/index.ts'), 'utf8')).toContain('add(2, 3)');

      // PIVOT-034 (ADR-0014): the in-room peek reads through the task's mount,
      // so File mode shows the WORKTREE content while the main tree is
      // untouched — and the Editor escape hatch is hidden (not honest here).
      await page.getByTestId('task-room-file-src/index.ts').click();
      await expect(page.getByTestId('session-diff-review')).toBeVisible();
      await page.getByTestId('session-tool-file').click();
      await expect(page.getByTestId('file-peek')).toBeVisible();
      await expect(page.getByTestId('peek-body')).toContainText('add(3, 4)', { timeout: 10000 });
      await expect(page.getByTestId('peek-open-editor')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('file-peek')).toHaveCount(0);

      // Review, accept-all, accept the task (native confirm for unverified).
      await page.getByTestId('session-tool-review').click();
      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible({ timeout: 15000 });
      page.once('dialog', (d) => void d.accept());
      await page.getByTestId('review-accept-all').click();

      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 30000,
      });
      // Accepting a git-project task offers a PR draft — dismiss the modal.
      const prDismiss = page.getByTestId('pr-draft-dismiss');
      if (await prDismiss.isVisible().catch(() => false)) await prDismiss.click();
      await expect(page.getByTestId('pr-draft-card')).toHaveCount(0);
      // ADR-0032: accepting settles the turn but the conversation lives on —
      // the worktree survives and the MAIN tree stays untouched.
      expect(readFileSync(join(fixture, 'src/index.ts'), 'utf8')).toContain('add(2, 3)');
      await expect(page.getByTestId('tl-merged-back')).toHaveCount(0);

      // Archiving is the Session's close — merge-back happens exactly here.
      // (The room closes with it; the filesystem is the honest witness.)
      // The settle notice toast overlays the More button for ~5s — let it expire.
      await expect(page.locator('.session-notice-open')).toHaveCount(0, { timeout: 10000 });
      await page.getByTestId('session-more').click();
      await page.getByTestId('task-archive').click();
      await page.getByTestId('task-archive-confirm').click();
      await expect
        .poll(() => readFileSync(join(fixture, 'src/index.ts'), 'utf8'), { timeout: 20000 })
        .toContain('add(3, 4)');
    } finally {
      await app.close();
    }
  });
});

test.describe('Shell v4 — the composer is "Request changes" (ADR-0009)', () => {
  test('typing while a plan awaits approval sends feedback and the agent revises to v2', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-intent').fill('[scenario:plan-request-changes] revise me');
      await page.getByTestId('home-submit').click();

      await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('plan-card')).toContainText('First attempt');

      // The reply pill IS the request-changes control while a plan is open.
      await expect(page.getByTestId('agent-input')).toHaveAttribute(
        'placeholder',
        /Request changes/,
      );
      await page.getByTestId('agent-input').fill('please add a verification step');
      await page.getByTestId('agent-send').click();

      // Feedback lands in the timeline; the revised v2 plan arrives.
      await expect(page.getByTestId('tl-plan-decision').first()).toContainText(
        'asked for plan changes',
      );
      await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('plan-card')).toContainText('Revised');

      await page.getByTestId('plan-approve').click();
      await page.getByTestId('perm-allow-task').click({ timeout: 20000 });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      // One real change this time → full review weight, no "Answered" veneer.
      // ADR-0016: the review bar carries the completion; the timeline gets Done.
      await expect(page.getByTestId('review-bar')).toBeVisible();
      await expect(page.getByTestId('tl-done')).toBeVisible();
      await expect(page.getByTestId('task-room-answered')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

test.describe('Shell v4 — heartbeat + focus layers (PIVOT-028/025)', () => {
  test('running Sessions tick in the rail and show actionable evidence in the room', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-live] live activity');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();

      // Fleet layer: the persistent rail keeps the running Session and its
      // current activity visible. Home no longer duplicates a Live Board.
      await page.getByTestId('task-room-back').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(page.locator('.hm-mc')).toHaveCount(0);
      await expect(page.locator('[data-testid^="live-board-"]')).toHaveCount(0);
      const railSession = page.locator('button[data-testid^="home-task-"]').first();
      await expect(railSession).toBeVisible({ timeout: 25000 });
      await expect(railSession.locator('[data-testid^="home-task-ticker-"]')).toBeVisible();
      await page.screenshot({ path: '/tmp/charter-live-launcher-1440.png' });

      await railSession.click();
      await expect(page.getByTestId('task-room')).toBeVisible();

      // Focus layer: the same write events become stable file heat tiles in
      // the Session tool canvas; the timeline and rail keep their own layers.
      await expect(page.getByTestId('session-summary')).toBeVisible();
      const roomBoard = page.locator('[data-testid^="live-board-"]').first();
      await expect(roomBoard).toBeVisible();
      await expect(roomBoard).toContainText('THIS SESSION');
      await expect(roomBoard.getByTestId('live-tile-notes-live-a.txt')).toBeVisible({
        timeout: 25000,
      });
      await expect(roomBoard.getByTestId('live-tile-notes-live-b.txt')).toBeVisible({
        timeout: 25000,
      });

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: '/tmp/charter-live-presence-1440.png' });
      await page.setViewportSize({ width: 900, height: 900 });
      await expect(roomBoard).toBeVisible();
      await page.screenshot({ path: '/tmp/charter-live-presence-900.png' });
      await page.setViewportSize({ width: 1440, height: 900 });

      // Live file rows are evidence shortcuts, not decoration.
      await roomBoard.getByTestId('live-tile-notes-live-a.txt').click();
      await expect(page.getByTestId('session-diff-review')).toBeVisible();

      // Heartbeat layer: the sidebar row ticks with the current action.
      await expect(page.locator('[data-testid^="home-task-ticker-"]').first()).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
