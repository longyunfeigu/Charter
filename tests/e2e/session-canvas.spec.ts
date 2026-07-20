import { expect, test } from '@playwright/test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch.js';
import { createGitFixture } from './helpers/fixtures.js';

const OUT = '/tmp/charter-session-canvas';

async function settleLayout(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.waitForTimeout(180);
}

function createAgentBins(): string {
  const bin = mkdtempSync(join(tmpdir(), 'charter-session-agents-'));
  for (const cli of ['claude', 'codex']) {
    const path = join(bin, cli);
    writeFileSync(
      path,
      [
        '#!/usr/bin/env node',
        `console.log(${JSON.stringify(`${cli} ready`)});`,
        "process.stdin.on('data', (chunk) => console.log(`prompt received: ${chunk.toString()}`));",
        'setTimeout(() => process.exit(0), 60000);',
        '',
      ].join('\n'),
    );
    chmodSync(path, 0o755);
  }
  return bin;
}

test.describe('Unified Session Canvas', () => {
  test('keeps one shell while tools zoom and Review becomes evidence-first', async () => {
    test.setTimeout(120000);
    mkdirSync(OUT, { recursive: true });
    const fixture = createGitFixture();
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

      // One Composer owns every backend; no secondary creation dialog or IDE rail.
      await page.getByTestId('home-agent').click();
      await expect(page.getByTestId('home-agent-pi')).toBeVisible();
      await expect(page.getByTestId('home-agent-claude')).toBeVisible();
      await expect(page.getByTestId('home-agent-codex')).toBeVisible();
      await settleLayout(page);
      await page.screenshot({ path: `${OUT}/agent-picker-1440.png` });
      await page.getByTestId('home-agent-pi').click();
      await expect(page.locator('.activitybar')).toHaveCount(0);
      await settleLayout(page);
      await page.screenshot({ path: `${OUT}/launcher-1440.png` });

      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-verif-npm test').click();
      await page.getByTestId('home-mode-auto').click();
      await page
        .getByTestId('home-intent')
        .fill('[scenario:edit-multifile] unify the Session shell');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await expect(page.getByTestId('session-tool-canvas')).toBeVisible();
      await expect(page.getByTestId('session-tool-review')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByTestId('review-bar')).toBeVisible();
      await expect(page.getByTestId('session-action-dock')).toBeVisible();
      await expect(page.getByTestId('agent-panel')).toHaveCount(0);
      await expect(page.getByTestId('sidebar')).toHaveCount(0);
      await settleLayout(page);
      await page.screenshot({ path: `${OUT}/review-1440.png` });

      // File remains a first-class Session tool; Diff is the focused inline
      // review from the selected reference, not a second workspace shell.
      await page.getByTestId('session-tool-file').click();
      await expect(page.getByTestId('file-peek')).toBeVisible();
      await expect(page.locator('.rt-scroll')).toBeVisible();
      await page.getByTestId('session-tool-review').click();
      await expect(page.getByTestId('review-bar')).toBeVisible();
      await page.getByTestId('checks-run').click();
      await expect(page.getByTestId('tl-verification-passed')).toBeVisible({ timeout: 30000 });

      await page.getByTestId('session-tool-diff').click();
      await expect(page.getByTestId('session-diff-review')).toBeVisible();
      await expect(page.locator('[data-testid^="session-diff-file-"]')).toHaveCount(3);
      await expect(page.getByTestId('session-inline-diff')).toBeVisible();
      await expect(page.locator('.session-diff-verification')).toContainText('1 check passed');
      await page.getByTestId('session-diff-file-src/index.ts').click();
      await expect(page.getByTestId('session-inline-diff')).toContainText('src/index.ts');
      const toastDismiss = page.locator('.toast button[aria-label="Dismiss"]');
      if (await toastDismiss.isVisible()) await toastDismiss.click();
      await expect(page.getByTestId('session-tool-expand')).toHaveAttribute('aria-pressed', 'true');
      await settleLayout(page);
      await page.screenshot({ path: `${OUT}/diff-zoom-1440.png` });
      await page
        .getByTestId('session-tool-canvas')
        .screenshot({ path: `${OUT}/diff-panel-1440.png` });

      // At 900px, the tool canvas reorders below the collaboration ledger.
      await page.setViewportSize({ width: 900, height: 900 });
      await expect(page.getByTestId('task-room')).toBeVisible();
      const narrowLayout = await page.evaluate(() => {
        const body = document.querySelector('.session-canvas-body')?.getBoundingClientRect();
        const main = document
          .querySelector('.session-canvas-body > .tr-main')
          ?.getBoundingClientRect();
        const tools = document.querySelector('.session-tool-canvas')?.getBoundingClientRect();
        return {
          body: body ? { width: body.width, left: body.left, right: body.right } : null,
          main: main ? { width: main.width, left: main.left, right: main.right } : null,
          tools: tools ? { width: tools.width, left: tools.left, right: tools.right } : null,
        };
      });
      expect(narrowLayout.body).not.toBeNull();
      expect(narrowLayout.main?.width).toBeCloseTo(narrowLayout.body!.width, 0);
      expect(narrowLayout.tools?.width).toBeCloseTo(narrowLayout.body!.width, 0);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      await settleLayout(page);
      await page.screenshot({ path: `${OUT}/diff-zoom-900.png` });

      // The single Action Dock owns the decision; accepting does not switch shells.
      page.once('dialog', (dialog) => void dialog.accept());
      await page.getByTestId('review-bar-accept').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 15000,
      });
      await expect(page.getByTestId('task-room-accepted')).toBeVisible();
      await expect(page.getByTestId('home-sidebar')).toBeVisible();

      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('the conversation/tool boundary drags, survives Diff auto-expand, and resets', async () => {
    test.setTimeout(90000);
    const fixture = createGitFixture();
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
      await page.getByTestId('project-tool-back').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page
        .getByTestId('home-intent')
        .fill('[scenario:edit-multifile] drag the session split');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      await expect(page.getByTestId('task-room')).toBeVisible();
      await settleLayout(page);

      const mainWidth = (): Promise<number> =>
        page
          .locator('.session-canvas-body > .tr-main')
          .evaluate((el) => el.getBoundingClientRect().width);

      const handle = page.getByTestId('session-split-handle');
      await expect(handle).toBeVisible();
      const before = await mainWidth();

      // Drag the boundary 160px right: the conversation widens live with the
      // readout chip visible, and the ratio is persisted for this Session.
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 300);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 160, box.y + 300, { steps: 8 });
      await expect(page.getByTestId('session-split-chip')).toBeVisible();
      await page.mouse.up();
      const dragged = await mainWidth();
      expect(dragged - before).toBeGreaterThan(100);
      expect(
        await page.evaluate(() =>
          Object.keys(window.localStorage).some((key) => key.startsWith('charter.sessionSplit.')),
        ),
      ).toBe(true);

      // Opening Diff auto-expands the stops model — it must NOT override a
      // hand-dragged ratio anymore.
      await page.getByTestId('session-tool-diff').click();
      await expect(page.getByTestId('session-diff-review')).toBeVisible();
      await settleLayout(page);
      expect(Math.abs((await mainWidth()) - dragged)).toBeLessThan(8);

      // The ratio survives leaving and reopening the room.
      await page.getByTestId('task-room-back').click();
      await page.locator('[data-testid^="home-task-"]').first().click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await settleLayout(page);
      expect(Math.abs((await mainWidth()) - dragged)).toBeLessThan(8);

      // The Expand button is an explicit stop jump: it clears the manual ratio
      // and lands on the expanded 38/62 stop.
      await page.getByTestId('session-tool-expand').click();
      await settleLayout(page);
      expect(before - (await mainWidth())).toBeGreaterThan(100);

      // Double-click resets to the balanced 56/44 default.
      await handle.dblclick();
      await settleLayout(page);
      expect(Math.abs((await mainWidth()) - before)).toBeLessThan(10);

      // Keyboard nudges create a manual ratio again (2% per arrow).
      await handle.focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await settleLayout(page);
      expect((await mainWidth()) - before).toBeGreaterThan(30);

      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('dispatches a native agent from the same Composer and keeps the Session rail', async () => {
    test.setTimeout(60000);
    const fixture = createGitFixture();
    const bin = createAgentBins();
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
      home: 'keep',
    });

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await page.getByTestId('project-tool-back').click();
      await page.getByTestId('home-agent').click();
      await page.getByTestId('home-agent-claude').click();
      await expect(page.getByTestId('home-agent')).toContainText('Claude');
      await page.getByTestId('home-intent').fill('Inspect the Session object model');
      await page.getByTestId('home-submit').click();

      await expect(page.getByTestId('session-terminal-view')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await expect(page.getByTestId('session-terminal-view')).toContainText(fixture);
      await expect(page.getByTestId('session-create-dialog')).toHaveCount(0);
      await expect(page.locator('.activitybar')).toHaveCount(0);
      await expect(page.locator('.sr-provider.claude').first()).toBeVisible({ timeout: 15000 });
      await settleLayout(page);
      await page.screenshot({ path: `${OUT}/claude-session-1440.png` });
    } finally {
      await app.close();
    }
  });
});
