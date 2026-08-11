import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

/**
 * ADR-0056 — For-you inbox: GitHub issue import. The app under test is the
 * real product; only the GitHub REST endpoint is swapped for a deterministic
 * local server via CHARTER_GITHUB_API_URL (the same seam a GitHub Enterprise
 * deployment would use). The user-visible contract under test is the
 * external-work-inbox flow: import by URL from the For-you rail, inspect the
 * issue in the main surface, duplicate protection, and the launch handoff.
 */

const ISSUE = {
  number: 128,
  title: 'Mission state does not update after closing all Sessions',
  body: [
    'When I start a Mission and then close every Session, the Mission stays Running.',
    '',
    '- [ ] Mission leaves Running when its final Session closes',
    '- [ ] State updates without reopening the Mission page',
  ].join('\n'),
  state: 'open',
  html_url: 'https://github.com/edy/charter-test/issues/128',
  comments: 1,
  created_at: '2026-08-09T05:18:00Z',
  user: { login: 'edy' },
  labels: [{ name: 'bug' }, { name: 'missions' }],
};

const COMMENTS = [
  {
    body: 'This also happens when the last Session is stopped from the terminal toolbar.',
    created_at: '2026-08-09T06:00:00Z',
    user: { login: 'edy' },
  },
];

function startFakeGithub(): Promise<{
  server: Server;
  url: string;
  postedComments: string[];
}> {
  const postedComments: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    const respond = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && path.startsWith('/repos/edy/charter-test/issues/128/comments')) {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        postedComments.push(String((JSON.parse(raw) as { body?: string }).body ?? ''));
        respond(201, {
          html_url: 'https://github.com/edy/charter-test/issues/128#issuecomment-1',
        });
      });
      return;
    }
    if (path.startsWith('/repos/edy/charter-test/issues/128/comments')) {
      respond(200, COMMENTS);
    } else if (path.startsWith('/repos/edy/charter-test/issues/128')) {
      respond(200, ISSUE);
    } else if (path.startsWith('/user')) {
      // Token verification: the deliberately-invalid token is rejected.
      if ((req.headers.authorization ?? '').includes('ghp_invalid')) {
        respond(401, { message: 'Bad credentials' });
      } else {
        respond(200, { login: 'edy' });
      }
    } else {
      respond(404, { message: 'Not Found' });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, postedComments });
    });
  });
}

function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test.describe('For-you inbox — GitHub issue import (ADR-0056)', () => {
  test('imports an issue by URL, inspects it, blocks duplicates, and hands off to a session', async () => {
    const github = await startFakeGithub();
    const fixture = createGitFixture();
    execFileSync('git', ['branch', 'release/next'], { cwd: fixture });
    const { app, page } = await launchApp({
      env: {
        CHARTER_GITHUB_API_URL: github.url,
        PI_IDE_FORCE_MOCK: '1',
        PI_IDE_OPEN_WORKSPACE: fixture,
      },
      home: 'keep',
    });
    const errors = captureErrors(page);
    try {
      // The For-you rail: Attention keeps the session queue; Incoming owns
      // external work and the Import URL entry.
      await page.getByTestId('rail-needs-you').click();
      await expect(page.getByTestId('rail-inbox-panel')).toBeVisible();
      await expect(page.getByTestId('foryou-view')).toBeVisible();
      await expect(page.getByTestId('foryou-view')).toContainText('Select a work item');
      await page.getByTestId('fy-tab-incoming').click();
      await expect(page.getByTestId('fy-empty-list')).toBeVisible();

      // Failure path first: a non-issue URL is rejected inside the dialog with
      // a retry affordance — no item, no dialog dismissal.
      await page.getByTestId('fy-import-url').click();
      await expect(page.getByTestId('fy-import-modal')).toBeVisible();
      await page.getByTestId('fy-import-input').fill('https://example.com/not-github');
      await page.getByTestId('fy-import-submit').click();
      await expect(page.getByTestId('fy-import-error')).toBeVisible();
      await expect(page.getByTestId('fy-import-error')).toContainText('GitHub issue URL');

      // Unreachable issue (fake server 404s unknown repos) names the likely
      // cause instead of failing silently.
      await page.getByTestId('fy-import-input').fill('https://github.com/edy/unknown/issues/1');
      await page.getByTestId('fy-import-submit').click();
      await expect(page.getByTestId('fy-import-error')).toBeVisible();

      // Happy path: resolve the issue — the Incoming list gains the item and
      // the main surface opens the mock's detail: context, labels, discussion,
      // carried-context inventory, and the launch card.
      await page.getByTestId('fy-import-input').fill(ISSUE.html_url);
      await page.getByTestId('fy-import-submit').click();
      await expect(page.getByTestId('fy-import-preview')).toBeVisible();
      await expect(page.getByTestId('fy-import-preview')).toContainText(ISSUE.title);
      await expect(page.getByTestId('fy-import-preview')).toContainText('2 checklist items');
      await expect(page.getByTestId('fy-import-project')).toHaveValue('');
      await page.getByTestId('fy-import-confirm').click();
      await expect(page.getByTestId('fy-import-modal')).toBeHidden();
      await expect(page.getByTestId('fy-detail-title')).toHaveText(ISSUE.title);
      await expect(page.getByTestId('fy-issue-context')).toContainText('Mission stays Running');
      await expect(page.getByTestId('fy-issue-context')).toContainText('bug');
      await expect(page.getByTestId('fy-discussion')).toContainText('terminal toolbar');
      await expect(page.getByTestId('foryou-view')).toContainText('Context Charter will carry in');
      await expect(page.getByTestId('fy-open-source')).toBeVisible();
      const railItems = page.locator('[data-testid^="fy-item-"]');
      await expect(railItems).toHaveCount(1);
      await expect(railItems.first()).toContainText('edy/charter-test · #128');

      // Idempotence: importing the same URL again offers the existing item.
      await page.getByTestId('fy-import-url').click();
      await page.getByTestId('fy-import-input').fill(ISSUE.html_url);
      await page.getByTestId('fy-import-submit').click();
      await expect(page.getByTestId('fy-import-duplicate')).toBeVisible();
      await page.getByTestId('fy-import-open-existing').click();
      await expect(page.getByTestId('fy-import-modal')).toBeHidden();
      await expect(page.getByTestId('fy-detail-title')).toHaveText(ISSUE.title);
      await expect(railItems).toHaveCount(1);

      // No mapped local repository in this fixture → the launch card demands a
      // Project instead of pretending one is resolved.
      await expect(page.getByTestId('fy-launch-unmapped')).toBeVisible();
      await expect(page.getByTestId('fy-launch-unmapped')).toContainText(
        'No local repository mapping',
      );
      await page.getByTestId('fy-project-picker').selectOption({ index: 1 });
      await expect(page.getByTestId('fy-launch')).toBeVisible();
      await expect(page.getByTestId('fy-launch')).toContainText('Ready to start');
      await expect(page.getByTestId('fy-launch')).toContainText('Chosen manually');

      // Launch through the mock's Final check: really creates the Session and
      // links it back; the running card replaces the launch card.
      await page.getByTestId('fy-start').click();
      await expect(page.getByTestId('fy-start-modal')).toBeVisible();
      await page.getByTestId('fy-shape-session-option').click();
      await expect(page.getByTestId('fy-start-branch')).toHaveValue('main');
      await page.getByTestId('fy-start-branch').selectOption('release/next');
      await page.getByTestId('fy-workspace-agent-worktree').click();
      await expect(page.getByTestId('fy-worktree-note')).toContainText(
        'Charter only adds the instruction',
      );
      await expect(page.getByTestId('fy-agent-field-label')).toHaveText('Choose the Session Agent');
      await expect(page.getByTestId('fy-agent-claude')).toContainText('Claude');
      await expect(page.getByTestId('fy-agent-codex')).toContainText('Codex');
      await page.getByTestId('fy-agent-codex').click();
      await expect(page.getByTestId('fy-agent-codex')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('fy-entry-agent-note')).toContainText('Codex');
      await expect(page.getByTestId('fy-entry-agent-note')).toContainText(
        'runs this Session directly',
      );
      await expect(page.getByTestId('fy-start-confirm')).toBeEnabled();
      await expect(page.getByTestId('fy-start-confirm')).toContainText('Start Session');
      await page.screenshot({ path: '/tmp/charter-import-entry-agent.png' });

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 900, height: 760 });
      });
      const startModalFits = await page.getByTestId('fy-start-modal').evaluate((modal) => {
        const rect = modal.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: window.innerWidth,
          height: window.innerHeight,
        };
      });
      expect(startModalFits.left).toBeGreaterThanOrEqual(0);
      expect(startModalFits.top).toBeGreaterThanOrEqual(0);
      expect(startModalFits.right).toBeLessThanOrEqual(startModalFits.width);
      expect(startModalFits.bottom).toBeLessThanOrEqual(startModalFits.height);
      await page.screenshot({ path: '/tmp/charter-import-start-narrow.png' });
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
      });

      await page.getByTestId('fy-agent-pi').click();
      await expect(page.getByTestId('fy-entry-model')).toBeVisible();
      await page.getByTestId('fy-start-confirm').click();
      await expect(page.getByTestId('fy-running')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('fy-running')).toHaveAttribute('data-phase', 'waiting');
      await expect(page.getByTestId('fy-running')).toContainText('Work needs attention');

      const launchWorkspace = await page.evaluate(async (title) => {
        const list = (await window.product.rpc['task.list']!({
          filter: 'all',
          includeArchived: false,
          scope: 'all',
        })) as {
          ok: boolean;
          data?: {
            tasks: Array<{ title: string; goalMd: string; worktree: unknown }>;
          };
        };
        const task = list.data?.tasks.find((candidate) => candidate.title === title);
        return task ? { goalMd: task.goalMd, worktree: task.worktree } : null;
      }, ISSUE.title);
      expect(launchWorkspace?.goalMd).toContain('Selected base branch: "release/next"');
      expect(launchWorkspace?.goalMd).toContain('create a new linked Git worktree');
      expect(launchWorkspace?.goalMd).toContain('Charter will not create or manage this worktree');
      expect(launchWorkspace?.worktree).toBeNull();
      expect(
        execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: fixture })
          .toString()
          .match(/^worktree /gm),
      ).toHaveLength(1);

      // Lifecycle is projected, not painted optimistically forever. Stopping
      // the linked Session updates both the aggregate card and execution badge
      // without reopening the application.
      const stopped = await page.evaluate(async (title) => {
        const list = (await window.product.rpc['task.list']!({
          filter: 'all',
          includeArchived: false,
          scope: 'all',
        })) as {
          ok: boolean;
          data?: { tasks: Array<{ id: string; title: string }> };
        };
        const task = list.data?.tasks.find((candidate) => candidate.title === title);
        if (!list.ok || !task) return false;
        const result = await window.product.rpc['task.stop']!({ taskId: task.id });
        return result.ok;
      }, ISSUE.title);
      expect(stopped).toBe(true);
      await expect(page.getByTestId('fy-running')).toHaveAttribute('data-phase', 'stopped');
      await expect(page.getByTestId('fy-running')).toContainText('Work has stopped');
      await expect(page.getByTestId('fy-execution-phase')).toContainText('Stopped');
      await page.screenshot({ path: '/tmp/charter-import-stopped.png' });

      // Stopping one attempt does not close the issue. Final check can launch
      // another Mission or Session, while the stopped execution remains in
      // the plan as inspectable history.
      await page.getByTestId('fy-start-another').click();
      await expect(page.getByTestId('fy-start-modal')).toBeVisible();
      await page.getByTestId('fy-shape-session-option').click();
      await expect(page.getByTestId('fy-start-confirm')).toContainText('Start Session');
      await page.getByTestId('fy-start-confirm').click();
      await expect(page.locator('.fy-linked-row')).toHaveCount(2, { timeout: 20000 });
      await expect(page.getByTestId('fy-running')).toHaveAttribute('data-phase', 'waiting');

      // Every plan row is a real navigation target. Opening the latest one
      // routes immediately instead of waiting for transcript hydration.
      await page.locator('.fy-linked-row').last().click();
      await expect(page.getByTestId('task-room')).toBeVisible({ timeout: 10000 });
      await page.getByTestId('rail-needs-you').click();
      await page.getByTestId('fy-tab-incoming').click();
      await railItems.first().click();
      await expect(page.locator('.fy-linked-row')).toHaveCount(2);

      const secondStopped = await page.evaluate(async (title) => {
        const list = (await window.product.rpc['task.list']!({
          filter: 'all',
          includeArchived: false,
          scope: 'all',
        })) as {
          ok: boolean;
          data?: { tasks: Array<{ id: string; title: string; state: string }> };
        };
        const task = list.data?.tasks.find(
          (candidate) => candidate.title === title && candidate.state !== 'INTERRUPTED',
        );
        if (!list.ok || !task) return false;
        const result = await window.product.rpc['task.stop']!({ taskId: task.id });
        return result.ok;
      }, ISSUE.title);
      expect(secondStopped).toBe(true);
      await expect(page.getByTestId('fy-running')).toHaveAttribute('data-phase', 'stopped');
      await expect(page.locator('.fy-linked-row')).toHaveCount(2);

      // The same item is an ordinary card on the Work board (one data model,
      // two projections) — the board itself gained no import feature.
      await page.getByTestId('rail-view-work').click();
      await expect(page.getByTestId('work-view')).toBeVisible();
      await expect(page.locator('.work-card')).toHaveCount(1);
      await expect(page.getByTestId('work-import-github')).toHaveCount(0);

      // Imported cards have an explicit, guarded delete path. It removes only
      // the Work record; stopped/running Sessions remain durable and GitHub is
      // never touched.
      await page.getByTestId('rail-needs-you').click();
      await page.getByTestId('fy-tab-incoming').click();
      await railItems.first().click();
      await page.getByTestId('fy-delete-issue').click();
      await expect(page.getByTestId('fy-delete-dialog')).toBeVisible();
      await expect(page.getByTestId('fy-delete-linked-warning')).toContainText(
        'does not stop Sessions or Missions',
      );
      await page.screenshot({ path: '/tmp/charter-import-delete-confirm.png' });
      await page.getByTestId('fy-delete-confirm').click();
      await expect(railItems).toHaveCount(0);
      await expect(page.getByTestId('foryou-view')).toContainText('Select a work item');

      expect(errors).toEqual([]);
    } finally {
      await app.close();
      github.server.close();
    }
  });

  test('review bucket ships the approval-gated GitHub update with an exact preview', async () => {
    const github = await startFakeGithub();
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: {
        CHARTER_GITHUB_API_URL: github.url,
        PI_IDE_FORCE_MOCK: '1',
        PI_IDE_OPEN_WORKSPACE: fixture,
      },
      home: 'keep',
    });
    try {
      // A verified credential first — posting refuses to run without one.
      await page.getByTestId('home-settings').click();
      await page.getByTestId('settings-section-github').click();
      await page.getByTestId('github-token-input').fill('ghp_e2e_valid');
      await page.getByTestId('github-save-token').click();
      await expect(page.getByTestId('github-remove-token')).toBeVisible();
      await page.getByTestId('settings-back').click();

      // Import, then move the item into the Review stage from the board.
      await page.getByTestId('rail-needs-you').click();
      await page.getByTestId('fy-import-url').click();
      await page.getByTestId('fy-import-input').fill(ISSUE.html_url);
      await page.getByTestId('fy-import-submit').click();
      await expect(page.getByTestId('fy-import-preview')).toBeVisible();
      await page.getByTestId('fy-import-confirm').click();
      await expect(page.getByTestId('fy-detail-title')).toHaveText(ISSUE.title);
      // Importing selects the card, so the board opens with the drawer in place.
      await page.getByTestId('rail-view-work').click();
      await expect(page.getByTestId('work-item-detail')).toBeVisible();
      await page.getByTestId('work-detail-stage').selectOption('work-col-review');
      await page.getByTestId('work-detail-close').click();

      // Review bucket: real metrics/evidence surfaces plus the Ship card.
      await page.getByTestId('rail-needs-you').click();
      await page.getByTestId('fy-tab-review').click();
      await page.locator('[data-testid^="fy-item-"]').first().click();
      await expect(page.getByTestId('fy-ship')).toBeVisible();
      await expect(page.getByTestId('fy-ship')).toContainText('External write requires approval');
      await expect(page.getByTestId('fy-evidence')).toContainText('GitHub issue');

      // The exact payload preview gates the one external write.
      await page.getByTestId('fy-post-preview-open').click();
      await expect(page.getByTestId('fy-post-modal')).toBeVisible();
      await expect(page.getByTestId('fy-post-preview')).toContainText('Update from Charter');
      await page.getByTestId('fy-post-confirm').click();
      await expect(page.getByTestId('fy-posted')).toBeVisible();
      expect(github.postedComments).toHaveLength(1);
      expect(github.postedComments[0]).toContain('Update from Charter');
      expect(github.postedComments[0]).toContain('Posted from Charter after human review.');

      // The audit trail records the posted link; the rail shows Posted.
      await expect(page.getByTestId('foryou-view')).toContainText('Update posted');
      await expect(page.locator('[data-testid^="fy-item-"]').first()).toContainText('Posted');
    } finally {
      await app.close();
      github.server.close();
    }
  });

  test('settings verify a token against the API before storing it', async () => {
    const github = await startFakeGithub();
    const { app, page } = await launchApp({
      env: { CHARTER_GITHUB_API_URL: github.url, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      await page.getByTestId('home-settings').click();
      await page.getByTestId('settings-section-github').click();
      await expect(page.getByTestId('github-settings')).toBeVisible();
      // The fake server has no /user route → verification fails → not stored.
      await page.getByTestId('github-token-input').fill('ghp_invalid');
      await page.getByTestId('github-save-token').click();
      await expect(page.getByTestId('github-remove-token')).toHaveCount(0);
    } finally {
      await app.close();
      github.server.close();
    }
  });

  test('keeps the Chinese preview usable in a narrow Electron window', async () => {
    const github = await startFakeGithub();
    const { app, page } = await launchApp({
      env: { CHARTER_GITHUB_API_URL: github.url, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    const errors = captureErrors(page);
    try {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1024, height: 720 });
      });
      await expect
        .poll(() => page.evaluate(() => window.innerWidth), { timeout: 10000 })
        .toBeLessThanOrEqual(1024);

      await page.getByTestId('home-settings').click();
      await page.getByTestId('settings-section-general').click();
      await page.getByTestId('settings-locale').selectOption('zh-CN');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('home-view')).toBeVisible();

      await page.getByTestId('rail-needs-you').click();
      await page.getByTestId('fy-tab-incoming').click();
      await page.getByTestId('fy-import-url').click();
      await expect(page.getByRole('heading', { name: '导入 GitHub issue' })).toBeVisible();
      await page.getByTestId('fy-import-input').fill(ISSUE.html_url);
      await page.getByTestId('fy-import-submit').click();
      await expect(page.getByTestId('fy-import-preview')).toBeVisible();
      await expect(page.getByTestId('fy-import-confirm')).toHaveText('导入工作队列');
      await expect(page.getByTestId('fy-import-project')).toBeVisible();

      const fits = await page.getByTestId('fy-import-modal').evaluate((modal) => {
        const rect = modal.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: window.innerWidth,
          height: window.innerHeight,
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      expect(fits.left).toBeGreaterThanOrEqual(0);
      expect(fits.top).toBeGreaterThanOrEqual(0);
      expect(fits.right).toBeLessThanOrEqual(fits.width);
      expect(fits.bottom).toBeLessThanOrEqual(fits.height);
      expect(fits.pageOverflow).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
      github.server.close();
    }
  });
});
