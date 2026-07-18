import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGitFixture } from './helpers/fixtures.js';
import { launchApp } from './helpers/launch.js';

const OUT = resolve('docs/assets/readme');
const enabled = process.env.CHARTER_README_SHOTS === '1';

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

      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
