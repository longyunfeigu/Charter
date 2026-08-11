import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';

/**
 * ADR-0056 real-network acceptance for the For-you inbox: the packaged flow
 * against api.github.com with the developer's own `gh` login — no fake server,
 * no injected fetch. Opt-in (network + credentials + a live issue required):
 *
 *   RUN_REAL_GITHUB=1 npx playwright test --config tests/e2e/playwright.config.ts work-github-import.real
 *
 * Screenshots land outside the repository as temporary review evidence.
 */

const enabled = (process.env.RUN_REAL_GITHUB ?? '') !== '';
const ISSUE_URL =
  process.env.REAL_GITHUB_ISSUE ?? 'https://github.com/longyunfeigu/Charter/issues/2';
const LOCAL_REPO = process.env.REAL_GITHUB_LOCAL_REPO ?? process.cwd();

test.describe('For-you inbox — real GitHub API', () => {
  test.skip(!enabled, 'Set RUN_REAL_GITHUB=1 to run against the live GitHub API.');

  test('imports a live issue with gh CLI credentials and maps the local repo', async () => {
    const shots = join(tmpdir(), 'charter-github-import-real');
    mkdirSync(shots, { recursive: true });
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: LOCAL_REPO, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      // With no PAT stored, the For-you footer reports the gh CLI credential.
      await page.getByTestId('rail-needs-you').click();
      await expect(page.getByTestId('foryou-view')).toBeVisible();
      await expect(page.getByTestId('rail-inbox-panel')).toBeVisible();
      await page.getByTestId('fy-tab-incoming').click();
      await expect(page.locator('.fy-foot')).toContainText('gh CLI', { timeout: 15000 });
      await page.screenshot({ path: join(shots, '1-foryou-incoming-empty.png') });

      await page.getByTestId('fy-import-url').click();
      await page.getByTestId('fy-import-input').fill(ISSUE_URL);
      await page.screenshot({ path: join(shots, '2-import-modal.png') });
      await page.getByTestId('fy-import-submit').click();

      // Live network: allow the API round trip a generous window.
      await expect(page.getByTestId('fy-import-preview')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('fy-import-project')).not.toHaveValue('');
      await page.screenshot({ path: join(shots, '3-import-preview.png') });
      await page.getByTestId('fy-import-confirm').click();
      await expect(page.getByTestId('fy-detail-title')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('fy-launch')).toBeVisible();
      // The mapped local repository must be resolved by git remote, not typed.
      await expect(page.getByTestId('fy-launch')).toContainText('Matched by git remote');
      await page.screenshot({ path: join(shots, '4-imported-detail.png') });

      // Handoff into the composer with the real issue context.
      await page.getByTestId('fy-start').click();
      await expect(page.getByTestId('home-intent')).toContainText('GitHub');
      await page.screenshot({ path: join(shots, '5-composer-prefilled.png') });
    } finally {
      await app.close();
    }
  });
});
