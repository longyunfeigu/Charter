import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { launchApp } from './helpers/launch.js';
import { createTsSmallFixture } from './helpers/fixtures.js';

/** Visual walk for ADR-0022 am.2 (Room live preview) — /tmp/ui-shots/rp-*.png.
 * Gated behind CHARTER_SHOTS. */
test.skip(!process.env.CHARTER_SHOTS, 'set CHARTER_SHOTS=1 to capture');

const OUT = '/tmp/ui-shots';
const CHECKOUT = `<!doctype html><meta charset="utf-8"><title>Checkout</title>
<style>body{font-family:-apple-system,sans-serif;max-width:520px;margin:36px auto;padding:0 16px}
.box{border:1px solid #ddd;border-radius:10px;padding:12px 16px;display:flex;justify-content:space-between;margin-bottom:14px}
.row{display:flex;gap:8px;margin-bottom:10px}.row input{flex:1;padding:8px 10px;border:1px solid #ccc;border-radius:8px;font-family:monospace}
.row button{padding:8px 14px;border:1px solid #ccc;background:#f4f4f4;border-radius:8px}
.hint{width:130px;line-height:1.4;color:#b06f10;background:#faf0dc;border:1px solid #ecd9ae;border-radius:8px;padding:6px 10px;font-size:13px;margin-bottom:12px}
.submit{width:100%;padding:12px 0;border:none;border-radius:10px;background:#1b1a16;color:#fff;font-size:15px}</style>
<h2>Checkout</h2>
<div class="box"><span>Subtotal (2 items)</span><b>¥ 468.00</b></div>
<div class="row"><input value="SUMMER-20 (expired)"><button>Apply coupon</button></div>
<div class="hint" id="coupon-hint">This coupon expired on Jun 30 — replace or remove it</div>
<button class="submit" id="place">Place order</button>`;

function startServer(cwd: string): Promise<{ child: ChildProcess; port: number }> {
  const script = `const s=require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end(${JSON.stringify(CHECKOUT)})});s.listen(0,'127.0.0.1',()=>console.log('PORT:'+s.address().port));`;
  const child = spawn(process.execPath, ['-e', script], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 10000);
    child.stdout!.on('data', (c: Buffer) => {
      const m = c.toString().match(/PORT:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    });
  });
}

test('room live preview visual walk', async () => {
  test.setTimeout(200000);
  const fixture = createTsSmallFixture();
  const { app, page } = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  let server: ChildProcess | null = null;
  try {
    await page.setViewportSize({ width: 1480, height: 920 });
    await page.getByTestId('surface-home').click();
    await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
    await page.getByTestId('home-mode-full').click();
    await page.getByTestId('home-intent').fill('[scenario:edit-basic] coupon expiry hint');
    await page.getByTestId('home-submit').click();
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
      timeout: 30000,
    });

    // 1 — Full-auto task, accepted, no gate. A badge is the only preview entry.
    server = (await startServer(fixture)).child;
    await expect(page.getByTestId('task-room-preview-badge')).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: `${OUT}/rp-1-badge.png` });

    // 2 — rail open beside the (closed) conversation.
    await page.getByTestId('task-room-preview-badge').click();
    await expect(page.getByTestId('preview-frame')).toBeVisible({ timeout: 15000 });
    await expect(
      page.frameLocator('[data-testid="preview-frame"]').locator('#coupon-hint'),
    ).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/rp-2-rail-open.png` });

    // 3 — pick mode armed (hint banner over the frame).
    await page.getByTestId('preview-mode-pick').click();
    await expect(page.getByTestId('preview-pick-hint')).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${OUT}/rp-3-pick-armed.png` });

    // 4 — picked element → composer chip with the selector.
    await page.frameLocator('[data-testid="preview-frame"]').locator('#coupon-hint').click();
    await expect(page.getByTestId('room-preview-ref')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('agent-input').fill('Make this hint a single line.');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/rp-4-chip-in-composer.png` });

    // 5 — dark theme spot check.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/rp-5-dark.png` });
  } finally {
    server?.kill();
    await app.close();
  }
});
