import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGitFixture } from './helpers/fixtures.js';
import { launchApp } from './helpers/launch.js';

const OUT = resolve('docs/assets/readme');
const enabled = process.env.CHARTER_README_SHOTS === '1';

const PREVIEW_PAGE = `<!doctype html><meta charset="utf-8"><title>Checkout recovery</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:560px;margin:42px auto;padding:0 24px;color:#222;background:#fffdf8}
  .eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#777}h1{font-size:30px;margin:8px 0 28px}
  .summary{display:flex;justify-content:space-between;padding:18px;border:1px solid #e6dfd2;border-radius:14px;background:white;box-shadow:0 10px 30px #5e513311}
  .coupon{display:flex;gap:10px;margin-top:18px}.coupon input{flex:1;padding:11px 13px;border:1px solid #cfc7b8;border-radius:10px;font-family:monospace}.coupon button{padding:0 16px;border:1px solid #cfc7b8;border-radius:10px;background:#f5f0e7}
  .hint{display:inline-block;margin:12px 0 22px;padding:8px 11px;color:#a45d08;background:#fff1d7;border:1px solid #edcf97;border-radius:9px;font-size:13px}
  .submit{width:100%;padding:13px;border:0;border-radius:11px;background:#1f1d18;color:#fff;font-size:15px}
</style>
<div class="eyebrow">Order #CH-2048</div><h1>Checkout</h1>
<div class="summary"><span>Subtotal · 2 items</span><strong>¥468.00</strong></div>
<div class="coupon"><input value="SUMMER-20 (expired)"><button>Apply coupon</button></div>
<div class="hint" id="coupon-hint">This coupon expired on Jun 30 — replace or remove it</div>
<button class="submit">Place order</button>`;

function startPreviewServer(cwd: string): Promise<{ child: ChildProcess; port: number }> {
  const script = `const s=require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end(${JSON.stringify(PREVIEW_PAGE)})});s.listen(0,'127.0.0.1',()=>console.log('PORT:'+s.address().port));`;
  const child = spawn(process.execPath, ['-e', script], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview server start timeout')), 10000);
    child.stdout!.on('data', (chunk: Buffer) => {
      const match = chunk.toString().match(/PORT:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, port: Number(match[1]) });
    });
  });
}

async function settleLayout(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
  );
  await page.waitForTimeout(250);
}

function createReadmeFixture(): string {
  const source = createGitFixture();
  const parent = mkdtempSync(join(tmpdir(), 'charter-readme-'));
  const destination = join(parent, 'charter-demo');
  renameSync(source, destination);
  return destination;
}

test.describe('README product images', () => {
  test.skip(!enabled, 'Set CHARTER_README_SHOTS=1 to refresh repository-owned README images.');

  test('captures the real Session-first Electron surface', async () => {
    test.setTimeout(120000);
    mkdirSync(OUT, { recursive: true });
    const fixture = createReadmeFixture();
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
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await page.getByTestId('project-tool-back').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });

      await page.getByTestId('home-agent').click();
      await expect(page.getByTestId('home-agent-pi')).toBeVisible();
      await expect(page.getByTestId('home-agent-claude')).toBeVisible();
      await expect(page.getByTestId('home-agent-codex')).toBeVisible();
      await settleLayout(page);
      await page.screenshot({
        path: join(OUT, 'agent-picker.png'),
        clip: { x: 0, y: 0, width: 1440, height: 520 },
      });
      await page.getByTestId('home-agent-pi').click();

      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-adv-title').fill('Harden checkout retries');
      await page.getByTestId('home-verif-npm test').click();
      await page.getByTestId('home-mode-auto').click();
      await page
        .getByTestId('home-intent')
        .fill('[scenario:edit-multifile] Harden checkout retries and add regression coverage');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      const notificationDismiss = page.getByLabel('Dismiss Session notification');
      await notificationDismiss.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
      if (await notificationDismiss.isVisible().catch(() => false)) {
        await notificationDismiss.click();
      }
      const toastDismiss = page.locator('.toast button[aria-label="Dismiss"]');
      if (await toastDismiss.isVisible().catch(() => false)) await toastDismiss.click();

      await expect(page.getByTestId('session-tool-review')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await page.getByTestId('checks-run').click();
      await expect(page.getByTestId('tl-verification-passed')).toBeVisible({ timeout: 30000 });
      await toastDismiss.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);
      if (await toastDismiss.isVisible().catch(() => false)) await toastDismiss.click();
      if (await notificationDismiss.isVisible().catch(() => false)) {
        await notificationDismiss.click();
      }
      await settleLayout(page);
      await page.screenshot({ path: join(OUT, 'session-review.png') });

      await page.getByTestId('session-tool-diff').click();
      await expect(page.getByTestId('session-diff-review')).toBeVisible();
      await page.getByTestId('session-diff-file-src/index.ts').click();
      await expect(page.getByTestId('session-inline-diff')).toContainText('src/index.ts');
      await settleLayout(page);
      await page.screenshot({ path: join(OUT, 'session-diff.png') });

      // Capture the in-progress file heat surface, then leave the Room so the
      // completion notice and Session-rail ripple are visible together.
      await page.getByTestId('home-new-task').click();
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-live] refine recovery notes');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('live-tile-notes-live-a.txt')).toBeVisible({
        timeout: 15000,
      });
      await settleLayout(page);
      await page.screenshot({ path: join(OUT, 'live-file-activity.png') });

      await page.getByTestId('task-room-back').click();
      await page.getByTestId('rail-view-sessions').click();
      const completionNotice = page.getByTestId('session-completion-notice').first();
      await expect(completionNotice).toBeVisible({ timeout: 30000 });
      const completedTaskId = await completionNotice.getAttribute('data-task-id');
      expect(completedTaskId).toBeTruthy();
      const completedRow = page.getByTestId(`home-task-${completedTaskId!}`);
      await expect(completedRow.locator('.sr-provider')).toHaveClass(/session-wave/);
      await completedRow.evaluate((element) => {
        for (const animation of element.getAnimations({ subtree: true })) {
          animation.pause();
          animation.currentTime = 280;
        }
      });
      await page.screenshot({ path: join(OUT, 'completion-attention.png') });

      await completionNotice.getByLabel('Dismiss Session notification').click();
      await page.getByTestId('rail-view-memory').click();
      await expect(page.getByTestId('memory-view')).toBeVisible();
      await page.getByTestId('memory-nav-charter').click();
      await page
        .getByTestId('memory-add-rule-input')
        .fill('Run focused tests before broad verification.');
      await page.getByTestId('memory-add-rule').click();
      await expect(page.getByTestId('memory-rule-row').first()).toContainText('focused tests');
      await page
        .getByTestId('memory-add-rule-input')
        .fill('Keep checkout recovery copy short and actionable.');
      await page.getByTestId('memory-add-rule').click();
      await expect(page.getByTestId('memory-rule-row').first()).toBeVisible();
      await settleLayout(page);
      await page.evaluate(async () => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        const resetHorizontalScroll = (): void => {
          for (const element of document.querySelectorAll<HTMLElement>('*')) {
            if (element.scrollLeft !== 0) element.scrollLeft = 0;
          }
        };
        resetHorizontalScroll();
        await new Promise<void>((done) => requestAnimationFrame(() => done()));
        resetHorizontalScroll();
      });
      await page.screenshot({ path: join(OUT, 'memory-management.png') });

      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('captures the live Preview inside the Session', async () => {
    test.setTimeout(120000);
    mkdirSync(OUT, { recursive: true });
    const fixture = createReadmeFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    let server: ChildProcess | null = null;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await page.getByTestId('project-tool-back').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-full').click();
      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-adv-title').fill('Fix coupon recovery in place');
      await page
        .getByTestId('home-intent')
        .fill('[scenario:edit-basic] improve the expired coupon recovery');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 30000,
      });

      server = (await startPreviewServer(fixture)).child;
      await expect(page.getByTestId('task-room-preview-badge')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('task-room-preview-badge').click();
      await expect(page.getByTestId('preview-frame')).toBeVisible({ timeout: 15000 });
      await expect(
        page.frameLocator('[data-testid="preview-frame"]').locator('#coupon-hint'),
      ).toBeVisible({ timeout: 15000 });
      await page.getByTestId('preview-mode-pick').click();
      await page.frameLocator('[data-testid="preview-frame"]').locator('#coupon-hint').click();
      await expect(page.getByTestId('room-preview-ref')).toBeVisible({ timeout: 15000 });
      await page
        .getByTestId('agent-input')
        .fill('Keep this recovery hint on one line and improve its contrast.');
      await settleLayout(page);
      await page.screenshot({ path: join(OUT, 'live-preview.png') });

      await page.setViewportSize({ width: 1000, height: 760 });
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('preview-frame')).toBeVisible();
      await page.screenshot({ path: join(tmpdir(), 'charter-readme-preview-narrow.png') });
      expect(errors).toEqual([]);
    } finally {
      server?.kill();
      await app.close();
    }
  });
});
