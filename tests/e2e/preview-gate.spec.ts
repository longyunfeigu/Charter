import { expect, test, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture, createTsSmallFixture } from './helpers/fixtures';

/**
 * ADR-0022 — Visible acceptance: preview tab (port detection bound to the
 * task's own tree), marquee feedback riding the request-fix loop, checks tab
 * (VER semantics unchanged), and the post-accept PR draft that never pushes.
 */

/** Start a tiny http server with a given cwd; resolves its port. */
function startServer(cwd: string, body: string): Promise<{ child: ChildProcess; port: number }> {
  const script = `const s=require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end(${JSON.stringify(
    `<main><h1>${body}</h1><button id="pay">Pay now</button></main>`,
  )})});s.listen(0,'127.0.0.1',()=>console.log('PORT:'+s.address().port));`;
  const child = spawn(process.execPath, ['-e', script], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 10000);
    child.stdout!.on('data', (chunk: Buffer) => {
      const m = chunk.toString().match(/PORT:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.on('exit', () => reject(new Error('server exited early')));
  });
}

/** The task's worktree directory under the isolated user-data dir. */
function findWorktree(userDataDir: string): string {
  const base = join(userDataDir, 'worktrees');
  const wsIds = readdirSync(base);
  expect(wsIds.length).toBeGreaterThan(0);
  for (const wsId of wsIds) {
    const tasks = readdirSync(join(base, wsId));
    if (tasks.length > 0) return join(base, wsId, tasks[0]!);
  }
  throw new Error('no worktree found');
}

async function startWorktreeTask(page: Page, intent: string): Promise<void> {
  await page.getByTestId('surface-home').click();
  await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
  await page.getByTestId('home-advanced-toggle').click();
  const wt = page.getByTestId('home-adv-worktree');
  await expect(wt).toBeVisible();
  await wt.check();
  await page.getByTestId('home-intent').fill(intent);
  await page.getByTestId('home-submit').click();
  await expect(page.getByTestId('task-room-worktree')).toContainText('charter/', {
    timeout: 20000,
  });
  await page.getByTestId('plan-approve').click();
  await page.getByTestId('perm-allow-task').click({ timeout: 20000 });
  await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
    timeout: 30000,
  });
}

test.describe('Preview gate (ADR-0022)', () => {
  test('port detection binds to the worktree, never the main tree; marquee feedback round-trips with the screenshot', async () => {
    const fixture = createGitFixture();
    const { app, page, userDataDir } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    let wtServer: ChildProcess | null = null;
    let mainServer: ChildProcess | null = null;
    try {
      await startWorktreeTask(page, '[scenario:edit-basic] coupon hint fix');
      const worktree = findWorktree(userDataDir);

      // One dev server in the task's worktree, one in the main tree.
      const wt = await startServer(worktree, 'WT preview');
      wtServer = wt.child;
      const main = await startServer(fixture, 'MAIN tree');
      mainServer = main.child;

      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible({ timeout: 15000 });

      // The Preview tab appears (a live port was detected) — open it.
      await page.getByTestId('review-tab-preview').click({ timeout: 15000 });
      await expect(page.getByTestId('preview-pane')).toBeVisible();

      // The worktree's server is listed; the main tree's is NOT (the boundary).
      await expect(page.getByTestId(`preview-port-${wt.port}`)).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId(`preview-port-${main.port}`)).toHaveCount(0);

      // The iframe actually renders the task's own tree.
      const frame = page.getByTestId('preview-frame');
      await expect(frame).toHaveAttribute('src', new RegExp(`localhost:${wt.port}`));
      await expect(page.getByTestId('preview-badge')).toContainText('isolated');

      // Marquee (am.2: the gate uses the shared Draw mode + note popover).
      await page.getByTestId('preview-mode-draw').click();
      const overlay = page.getByTestId('preview-overlay');
      await expect(overlay).toBeVisible();
      const box = (await overlay.boundingBox())!;
      await page.mouse.move(box.x + 40, box.y + 40);
      await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + 140, { steps: 5 });
      await page.mouse.up();
      await expect(page.getByTestId('preview-note-input')).toBeVisible();
      await page.getByTestId('preview-note-input').fill('The hint wraps; disable submit here.');
      await page.getByTestId('preview-note-send').click();

      // Same loop as request-fix: back in the room, feedback on the timeline
      // with the screenshot thumbnail, and a fresh run acknowledges the image.
      await expect(page.getByTestId('task-room')).toBeVisible({ timeout: 15000 });
      // Compact bubble: the note leads; the full structured message (with the
      // coordinates the agent received) stays folded underneath.
      await expect(
        page.getByTestId('tl-user').filter({ hasText: 'The hint wraps' }).first(),
      ).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('tl-preview-feedback').first()).toBeVisible({
        timeout: 15000,
      });
      await expect(
        page.getByTestId('tl-agent').filter({ hasText: 'received 1 image attachment' }).first(),
      ).toBeVisible({ timeout: 20000 });

      // The fix run is a normal run — the plan gate applies to it like any
      // other (one conversation, one rulebook). Approve and let it land.
      await page.getByTestId('plan-approve').click({ timeout: 20000 });
      // Write permission was granted task-scope on run 1; if this run asks
      // again (store variance), allow it — the loop under test is feedback→fix.
      await page
        .getByTestId('perm-allow-task')
        .click({ timeout: 8000 })
        .catch(() => undefined);
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
    } finally {
      wtServer?.kill();
      mainServer?.kill();
      await app.close();
    }
  });

  test('accept produces a PR draft from the evidence ledger — and never pushes or commits', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await startWorktreeTask(page, '[scenario:edit-basic] expiry hint');
      const logBefore = execFileSync('git', ['log', '--oneline'], { cwd: fixture })
        .toString()
        .trim();

      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible({ timeout: 15000 });
      page.once('dialog', (d) => void d.accept());
      await page.getByTestId('review-accept-all').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 30000,
      });

      // The draft card: evidence-ledger body, copy-out only.
      await expect(page.getByTestId('pr-draft-card')).toBeVisible({ timeout: 15000 });
      const body = page.getByTestId('pr-draft-body');
      await expect(body).toContainText('## Goal');
      await expect(body).toContainText('src/index.ts');
      await expect(body).toContainText('## Verification');
      await expect(body).toContainText('GIT-007');

      // Dismissing loses nothing — the draft persists on the timeline.
      await page.getByTestId('pr-draft-dismiss').click();
      await expect(page.getByTestId('pr-draft-card')).toHaveCount(0);
      await expect(page.getByTestId('tl-pr-draft')).toBeVisible();

      // GIT-007, observable: no new commit, no charter/pr branch, no remote.
      // ADR-0032: accept settles the turn only — the worktree Session is
      // still alive, so the MAIN tree stays untouched until archive merges.
      const logAfter = execFileSync('git', ['log', '--oneline'], { cwd: fixture })
        .toString()
        .trim();
      expect(logAfter).toBe(logBefore);
      const branches = execFileSync('git', ['branch', '--list', 'charter/pr/*'], { cwd: fixture })
        .toString()
        .trim();
      expect(branches).toBe('');
      expect(readFileSync(join(fixture, 'src/index.ts'), 'utf8')).toContain('add(2, 3)');

      // Archive closes the Session and lands the merge — still uncommitted.
      await expect(page.locator('.session-notice-open')).toHaveCount(0, { timeout: 10000 });
      await page.getByTestId('session-more').click();
      await page.getByTestId('task-archive').click();
      await page.getByTestId('task-archive-confirm').click();
      await expect
        .poll(() => readFileSync(join(fixture, 'src/index.ts'), 'utf8'), { timeout: 20000 })
        .toContain('add(3, 4)');
      expect(execFileSync('git', ['log', '--oneline'], { cwd: fixture }).toString().trim()).toBe(
        logBefore,
      );
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: fixture })
        .toString()
        .trim();
      expect(status).toContain('src/index.ts');
    } finally {
      await app.close();
    }
  });

  test('checks tab presents verification history: superseded stays visible, latest passes', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-verif-custom').fill('node check-agent.mjs');
      await page.getByTestId('home-verif-custom').press('Enter');
      await page.getByTestId('home-intent').fill('[scenario:verify-fail-fix] make the check pass');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('review-tab-checks').click();
      const review = page.getByTestId('review-view');
      await expect(review.getByTestId('checks-pane')).toBeVisible();

      // Two runs of the same label: the old failure is dimmed-but-present
      // (VER-005), the latest is green.
      await expect(review.locator('[data-testid^="check-row-"]')).toHaveCount(2, {
        timeout: 15000,
      });
      await expect(review.locator('[data-testid^="check-superseded-"]')).toHaveCount(1);
      await expect(review.locator('[data-testid^="check-row-"][data-state="passed"]')).toHaveCount(
        1,
      );
      await expect(review.locator('[data-testid^="check-row-"][data-state="failed"]')).toHaveCount(
        1,
      );
    } finally {
      await app.close();
    }
  });

  test('a non-web project shows no Preview tab; Checks is always there', async () => {
    const fixture = createTsSmallFixture(); // scripts: test/lint only — not webish
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] cli-only change');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('review-tab-changes')).toBeVisible();
      await expect(page.getByTestId('review-tab-checks')).toBeVisible();
      // Give the availability probe a beat — the tab must STILL be absent.
      await page.waitForTimeout(1500);
      await expect(page.getByTestId('review-tab-preview')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('one-click start: the empty state runs the project dev script in a task terminal and the preview appears (am.1)', async () => {
    const fixture = createTsSmallFixture();
    // A real zero-dep dev server + script — the button types `npm run dev`
    // into a task terminal; the gate itself never owns the process.
    writeFileSync(
      join(fixture, 'server.mjs'),
      [
        "import { createServer } from 'node:http';",
        'const s = createServer((q, r) => {',
        "  r.setHeader('content-type', 'text/html');",
        "  r.end('<main><h1>dev up</h1></main>');",
        '});',
        "s.listen(0, '127.0.0.1', () => console.log('listening on', s.address().port));",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify(
        {
          name: 'fixture-oneclick',
          private: true,
          scripts: { dev: 'node server.mjs', test: 'node run-tests.mjs' },
        },
        null,
        2,
      ),
    );
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] one-click preview');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible({ timeout: 15000 });
      // Webish (dev script) → the tab exists even with no live port.
      await page.getByTestId('review-tab-preview').click({ timeout: 15000 });
      await expect(page.getByTestId('preview-empty')).toBeVisible({ timeout: 10000 });

      const start = page.getByTestId('preview-start-dev');
      await expect(start).toContainText('npm run dev');
      await start.click();
      // Real end to end: task terminal spawns → shell runs the script → the
      // port poll attributes it (cwd = project root) → the iframe renders.
      await expect(page.getByTestId('preview-frame')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('preview-badge')).toContainText('task tree');
    } finally {
      await app.close();
    }
  });
});
