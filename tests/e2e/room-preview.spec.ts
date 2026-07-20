import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * ADR-0022 am.2 — the Room's live window: badge-only detection, persistent
 * rail in ANY state (incl. after full-auto accept), element pick → composer
 * chip → steer with selector+screenshot, console capture with manual send,
 * and closed-task feedback seeding a follow-up task.
 */

const PAGE_HTML = `<main><h1>Checkout</h1><div class="coupon-hint" id="hint">Coupon expired</div><button id="pay">Pay now</button></main>`;

function startServer(
  cwd: string,
  opts: { consoleError?: boolean } = {},
): Promise<{ child: ChildProcess; port: number }> {
  const body = `<!doctype html><meta charset="utf-8">${PAGE_HTML}${
    opts.consoleError ? '<script src="/boom.js"></script>' : ''
  }`;
  const boom = `console.error('TypeError: coupon is undefined');`;
  const script = `const s=require('http').createServer((q,r)=>{
    if(q.url==='/boom.js'){r.setHeader('content-type','text/javascript');r.end(${JSON.stringify(boom)});return;}
    r.setHeader('content-type','text/html');r.end(${JSON.stringify(body)});
  });s.listen(0,'127.0.0.1',()=>console.log('PORT:'+s.address().port));`;
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
  });
}

test.describe('Room live preview (ADR-0022 am.2)', () => {
  test('full-auto task: badge lights, rail opens after auto-accept, pick → chip → follow-up seeded with the screenshot', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    let server: ChildProcess | null = null;
    try {
      // Full mode: no gate ever — the rail is the only window (the hole this
      // amendment closes).
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-full').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] full auto change');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 30000,
      });

      // Server starts AFTER accept — the badge lights via polling; layout
      // stays put until the click.
      const started = await startServer(fixture);
      server = started.child;
      const badge = page.getByTestId('task-room-preview-badge');
      await expect(badge).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('room-preview-rail')).toHaveCount(0);

      await badge.click();
      await expect(page.getByTestId('room-preview-rail')).toBeVisible();
      const frame = page.getByTestId('preview-frame');
      await expect(frame).toBeVisible({ timeout: 15000 });
      await expect(frame).toHaveAttribute('src', new RegExp(`localhost:${started.port}`));
      // Wait for the iframe content to actually commit before picking.
      await expect(page.frameLocator('[data-testid="preview-frame"]').locator('#hint')).toBeVisible(
        { timeout: 15000 },
      );

      // Element pick: injected picker → click the hint INSIDE the iframe →
      // chip lands in the composer with the selector.
      await page.getByTestId('preview-mode-pick').click();
      await expect(page.getByTestId('preview-pick-hint')).toBeVisible({ timeout: 10000 });
      await page.frameLocator('[data-testid="preview-frame"]').locator('#hint').click();
      const chip = page.getByTestId('room-preview-ref');
      await expect(chip).toBeVisible({ timeout: 15000 });
      await expect(chip).toContainText('#hint');

      // The task is closed (full-auto accepted) — sending seeds a FOLLOW-UP
      // task whose first run carries the screenshot.
      await page.getByTestId('agent-input').fill('Make this hint one line.');
      await page.getByTestId('agent-send').click();
      await expect(
        page.getByTestId('tl-user').filter({ hasText: 'Make this hint one line.' }).first(),
      ).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('tl-preview-feedback').first()).toBeVisible({
        timeout: 15000,
      });
      await expect(
        page.getByTestId('tl-agent').filter({ hasText: 'received 1 image attachment' }).first(),
      ).toBeVisible({ timeout: 20000 });
    } finally {
      server?.kill();
      await app.close();
    }
  });

  test('running task: pick feedback steers the SAME run; console errors collect and send manually', async () => {
    const fixture = createTsSmallFixture();
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify(
        {
          name: 'room-preview',
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
    let server: ChildProcess | null = null;
    try {
      const started = await startServer(fixture, { consoleError: true });
      server = started.child;

      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] room rail steer');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // Rail open on a reviewable task.
      await page.getByTestId('task-room-preview-badge').click();
      await expect(page.getByTestId('preview-frame')).toBeVisible({ timeout: 15000 });

      // Console capture: the page's script error surfaces on the chip; manual
      // send lands it in the conversation as a steer.
      const chip = page.getByTestId('preview-console-chip');
      await expect(chip).toBeVisible({ timeout: 15000 });
      await expect(chip).toContainText('⚠');
      await chip.click();
      await expect(page.getByTestId('preview-console')).toBeVisible();
      await page.getByTestId('preview-console-send').click();
      await expect(
        page.getByTestId('tl-user').filter({ hasText: '[Preview console]' }).first(),
      ).toBeVisible({ timeout: 20000 });

      // Draw a region → chip → send with a note → same-conversation fix run.
      await page.getByTestId('preview-mode-draw').click();
      const overlay = page.getByTestId('preview-overlay');
      await expect(overlay).toBeVisible();
      const box = (await overlay.boundingBox())!;
      await page.mouse.move(box.x + 30, box.y + 30);
      await page.mouse.down();
      await page.mouse.move(box.x + 170, box.y + 110, { steps: 5 });
      await page.mouse.up();
      await expect(page.getByTestId('room-preview-ref')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('agent-input').fill('The hint wraps badly.');
      await page.getByTestId('agent-send').click();
      await expect(
        page.getByTestId('tl-user').filter({ hasText: 'The hint wraps badly.' }).first(),
      ).toBeVisible({ timeout: 20000 });
      await expect(
        page.getByTestId('tl-agent').filter({ hasText: 'received 1 image attachment' }).first(),
      ).toBeVisible({ timeout: 20000 });
    } finally {
      server?.kill();
      await app.close();
    }
  });

  test('one-click dev start from the rail keeps you in the Room — no surface flip to the editor', async () => {
    const fixture = createTsSmallFixture();
    // A real dev server + committed script so the rail is webish and the
    // one-click button appears.
    writeFileSync(
      join(fixture, 'server.mjs'),
      [
        "import { createServer } from 'node:http';",
        "const s = createServer((q, r) => { r.setHeader('content-type','text/html'); r.end('<main id=\\'app\\'>dev up</main>'); });",
        "s.listen(0, '127.0.0.1', () => console.log('listening on', s.address().port));",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify(
        { name: 'rail-oneclick', private: true, scripts: { dev: 'node server.mjs' } },
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
      await page.getByTestId('home-mode-full').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] rail one-click');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 30000,
      });

      // Open the rail; no server yet → empty state with the one-click button.
      await page.getByTestId('task-room-preview-badge').click();
      await expect(page.getByTestId('preview-empty')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('preview-start-dev').click();

      // The regression: starting the dev server must NOT flip to the editor.
      // The Room (a Home surface) stays mounted the whole time, and the port
      // is picked up in place.
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('preview-frame')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('task-room')).toBeVisible();
      // The dev log is reachable but only on demand.
      await expect(page.getByTestId('preview-dev-log')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
