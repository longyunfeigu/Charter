import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitFixture, createTsSmallFixture } from './helpers/fixtures.js';
import { launchApp } from './helpers/launch.js';

/** TEMPORARY marketing capture, batch 2 — delete after use. */
const OUT = '/tmp/charter-site-shots';
const enabled = process.env.CHARTER_SITE_SHOTS === '1';
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function settle(page: import('@playwright/test').Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((d) => requestAnimationFrame(() => requestAnimationFrame(() => d()))),
  );
  await page.waitForTimeout(ms);
}

function findWorktree(userDataDir: string): string {
  const base = join(userDataDir, 'worktrees');
  const wsIds = readdirSync(base);
  for (const wsId of wsIds) {
    const tasks = readdirSync(join(base, wsId));
    if (tasks.length > 0) return join(base, wsId, tasks[0]!);
  }
  throw new Error('no worktree found');
}

function startServer(cwd: string, html: string): Promise<{ child: ChildProcess; port: number }> {
  const script = `const s=require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end(${JSON.stringify(html)})});s.listen(0,'127.0.0.1',()=>console.log('PORT:'+s.address().port));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd });
    const timer = setTimeout(() => reject(new Error('server start timeout')), 10000);
    child.stdout?.on('data', (b: Buffer) => {
      const m = /PORT:(\d+)/.exec(String(b));
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.on('exit', () => reject(new Error('server exited early')));
  });
}

const DEMO_HTML = `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;height:100vh;background:#fbfaf7;font-family:Georgia,serif;color:#201e1a"><div style="text-align:center"><div style="font-size:34px;font-weight:600">Coupon hint</div><p style="color:#6e6a61;font-family:-apple-system,sans-serif">Running from the Session's isolated worktree.</p><button style="padding:10px 22px;border-radius:9px;border:1px solid #cfcabf;background:#1b1a16;color:#fff;font-size:14px">Apply coupon</button></div></body>`;

test.describe('site shots batch 2', () => {
  test.skip(!enabled, 'Set CHARTER_SITE_SHOTS=1.');

  test('classic workspace: editor, intelligence, git, search', async () => {
    test.setTimeout(300000);
    mkdirSync(OUT, { recursive: true });
    const fixture = createTsSmallFixture();
    writeFileSync(
      join(fixture, 'src/broken.ts'),
      `import { add } from './util';\nconst x: string = add(1, 2);\nexport default x;\n`,
    );
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    const miss: string[] = [];
    const shoot = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        miss.push(`${name}: ${String(e).slice(0, 180)}`);
        await page.screenshot({ path: join(OUT, `debug2-${name}.png`) }).catch(() => undefined);
      }
    };
    try {
      await page.setViewportSize({ width: 1440, height: 900 });

      await shoot('editor', async () => {
        await page.getByTestId('tree-item-src').click();
        await page.getByTestId('tree-item-src/index.ts').click();
        await expect(page.getByTestId('tab-src/index.ts')).toBeVisible();
        await page.getByTestId('tree-item-src/util.ts').click();
        await expect(page.getByTestId('tab-src/util.ts')).toBeVisible();
        await page.getByTestId('project-editor-split').click();
        await expect(page.getByTestId('monaco-pane-1')).toBeVisible({ timeout: 8000 });
        await page.locator('.monaco-editor').first().click();
        await page.keyboard.press(`${mod}+f`);
        await page.keyboard.type('add');
        await settle(page, 500);
        await page.screenshot({ path: join(OUT, 'editor.png') });
        await page.keyboard.press('Escape');
      });

      await shoot('intelligence', async () => {
        await page.getByTestId('tree-item-src/broken.ts').click();
        await expect(page.getByTestId('tab-src/broken.ts')).toBeVisible();
        await expect
          .poll(
            async () =>
              (await page.getByTestId('status-problems').getAttribute('aria-label')) ?? '',
            {
              timeout: 30000,
            },
          )
          .toMatch(/^[1-9]\d* errors?/);
        await page.getByTestId('status-problems').click();
        await expect(page.getByTestId('problems-panel')).toBeVisible();
        await settle(page, 500);
        await page.screenshot({ path: join(OUT, 'intelligence.png') });
        await page
          .getByTestId('status-problems')
          .click()
          .catch(() => undefined);
      });

      await shoot('git', async () => {
        appendFileSync(
          join(fixture, 'src/util.ts'),
          `\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n`,
        );
        writeFileSync(join(fixture, 'NOTES.md'), '# Notes\n\n- add mul helper\n');
        await page.getByTestId('project-tool-changes').click();
        await expect(page.getByTestId('scm-view')).toBeVisible({ timeout: 8000 });
        await expect(page.getByTestId('scm-entry-src/util.ts')).toBeVisible({ timeout: 15000 });
        await page.getByTestId('stage-src/util.ts').click();
        await expect(page.getByTestId('scm-group-staged')).toBeVisible({ timeout: 8000 });
        await page
          .getByTestId('commit-message')
          .fill('feat: add mul helper')
          .catch(() => undefined);
        await settle(page, 400);
        await page.screenshot({ path: join(OUT, 'git.png') });
      });

      await shoot('search', async () => {
        await page.keyboard.press(`${mod}+Shift+f`);
        await expect(page.getByTestId('search-view')).toBeVisible({ timeout: 8000 });
        await page.getByTestId('search-input').fill('add');
        await page.getByTestId('search-run').click();
        await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 8000 });
        await settle(page, 500);
        await page.screenshot({ path: join(OUT, 'search.png') });
      });

      writeFileSync(join(OUT, 'RESULT2.txt'), `MISS:\n${miss.join('\n')}\n`);
    } finally {
      await app.close();
    }
  });

  test('preview in the worktree + steering composer', async () => {
    test.setTimeout(300000);
    mkdirSync(OUT, { recursive: true });
    const source = createGitFixture();
    const parent = mkdtempSync(join(tmpdir(), 'charter-site2-'));
    const fixture = join(parent, 'charter-demo');
    renameSync(source, fixture);
    const { app, page, userDataDir } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    let wtServer: ChildProcess | null = null;
    const miss: string[] = [];
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-advanced-toggle').click();
      const wt = page.getByTestId('home-adv-worktree');
      await expect(wt).toBeVisible();
      await wt.check();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] coupon hint fix');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room-worktree')).toContainText('charter/', {
        timeout: 30000,
      });
      await page.getByTestId('plan-approve').click();
      await page.getByTestId('perm-allow-task').click({ timeout: 20000 });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      const n = page.getByLabel('Dismiss Session notification');
      if (await n.isVisible().catch(() => false)) await n.click();

      try {
        const worktree = findWorktree(userDataDir);
        const srv = await startServer(worktree, DEMO_HTML);
        wtServer = srv.child;
        await page
          .getByTestId('review-bar-open')
          .click()
          .catch(() => undefined);
        await page.getByTestId('review-tab-preview').click({ timeout: 15000 });
        await expect(page.getByTestId('preview-pane')).toBeVisible();
        await expect(page.getByTestId(`preview-port-${srv.port}`)).toBeVisible({ timeout: 15000 });
        await expect(page.getByTestId('preview-frame')).toBeVisible({ timeout: 15000 });
        await settle(page, 800);
        await page.screenshot({ path: join(OUT, 'preview.png') });
        try {
          await page.getByTestId('preview-mode-draw').click();
          const overlay = page.getByTestId('preview-overlay');
          const box = await overlay.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width * 0.36, box.y + box.height * 0.42);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width * 0.66, box.y + box.height * 0.62, {
              steps: 8,
            });
            await page.mouse.up();
          }
          await expect(page.getByTestId('preview-note-input')).toBeVisible({ timeout: 5000 });
          await page
            .getByTestId('preview-note-input')
            .fill('The hint wraps on small widths — tighten this card.');
          await settle(page, 400);
          await page.screenshot({ path: join(OUT, 'preview.png') });
        } catch (e) {
          miss.push(`preview-draw: ${String(e).slice(0, 160)}`);
        }
      } catch (e) {
        miss.push(`preview: ${String(e).slice(0, 180)}`);
        await page.screenshot({ path: join(OUT, 'debug2-preview.png') }).catch(() => undefined);
      }

      try {
        await page.getByTestId('task-room-back').click();
        await expect(page.getByTestId('home-intent')).toBeVisible({ timeout: 8000 });
        await page.getByTestId('home-mode-auto').click();
        await page
          .getByTestId('home-intent')
          .fill('[scenario:edit-live] Write live notes with pauses');
        await page.getByTestId('home-submit').click();
        await page.waitForTimeout(1700);
        await page.getByTestId('agent-input').click();
        await page
          .getByTestId('agent-input')
          .fill('Skip the second note — verify what is there now.');
        await page.waitForTimeout(250);
        await page.screenshot({ path: join(OUT, 'steer.png') });
        await page.waitForTimeout(2600);
      } catch (e) {
        miss.push(`steer: ${String(e).slice(0, 180)}`);
        await page.screenshot({ path: join(OUT, 'debug2-steer.png') }).catch(() => undefined);
      }

      appendFileSync(join(OUT, 'RESULT2.txt'), `B-MISS:\n${miss.join('\n')}\n`);
    } finally {
      wtServer?.kill();
      await app.close();
    }
  });
});
