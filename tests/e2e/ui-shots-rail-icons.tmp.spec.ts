import { test, expect } from '@playwright/test';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch.js';
import { createGitFixture } from './helpers/fixtures.js';

/** TEMP visual check — provider brand marks in the Session Rail.
 * Gated behind CHARTER_SHOTS; screenshots to /tmp/ui-shots/rail-icons-*.png. */
test.skip(!process.env.CHARTER_SHOTS, 'set CHARTER_SHOTS=1 to capture');

const OUT = '/tmp/ui-shots';

function createIdleAgentBins(): string {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-shots-bin-'));
  for (const cli of ['claude', 'codex']) {
    writeFileSync(
      join(bin, cli),
      [
        '#!/usr/bin/env node',
        `console.log(${JSON.stringify(`${cli} ready`)});`,
        'process.stdin.resume();',
        'setTimeout(() => process.exit(0), 120000);',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, cli), 0o755);
  }
  return bin;
}

test('rail provider marks — light/dark + dialog', async () => {
  test.setTimeout(240000);
  const fixture = realpathSync(createGitFixture());
  const bin = createIdleAgentBins();
  const { app, page } = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_FORCE_MOCK: '1',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    },
    home: 'keep',
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('home-sidebar')).toBeVisible();
    await page.getByTestId('home-new-task').click();
    await expect(page.getByTestId('home-view')).toBeVisible();
    await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });

    // A Pi task session (π mark).
    await page.getByTestId('home-mode-auto').click();
    await page
      .getByTestId('home-intent')
      .fill('[scenario:edit-basic] Document PTY data flow architecture');
    await page.getByTestId('home-submit').click();
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
      timeout: 30000,
    });

    // A second Pi task so the rail reads as a list.
    await page.getByTestId('home-new-task').click();
    await expect(page.getByTestId('home-view')).toBeVisible();
    await page.getByTestId('home-mode-auto').click();
    await page
      .getByTestId('home-intent')
      .fill('[scenario:edit-basic] Implement file search functionality');
    await page.getByTestId('home-submit').click();
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
      timeout: 30000,
    });

    // External Claude + Codex terminal sessions (brand marks).
    for (const kind of ['claude', 'codex'] as const) {
      await page.getByTestId('home-new-task').click();
      await page.getByTestId('home-agent').click();
      await expect(page.getByTestId('home-agent-menu')).toBeVisible();
      if (kind === 'codex') {
        // Shared Agent Picker with all three marks visible.
        await page.waitForTimeout(200);
        await page.getByTestId('home-agent-menu').screenshot({
          path: `${OUT}/rail-icons-3-dialog.png`,
        });
      }
      await page.getByTestId(`home-agent-${kind}`).click();
      await page.getByTestId('home-intent').fill(`Inspect the project with ${kind}`);
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('session-terminal-view')).toBeVisible();
      await page.waitForTimeout(600);
    }

    await page.waitForTimeout(800);
    await page.getByTestId('home-sidebar').screenshot({ path: `${OUT}/rail-icons-1-light.png` });

    // Projects panel — hover-revealed π/Claude/Codex starters.
    await page.getByTestId('rail-view-projects').click();
    await page.locator('[data-testid^="home-recent-"]').first().hover();
    await page.waitForTimeout(300);
    await page.getByTestId('home-sidebar').screenshot({ path: `${OUT}/rail-icons-5-projects.png` });
    await page.getByLabel('Back to Sessions').click();

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(500);
    await page.getByTestId('home-sidebar').screenshot({ path: `${OUT}/rail-icons-2-dark.png` });

    await page.getByTestId('rail-view-projects').click();
    await page.locator('[data-testid^="home-recent-"]').first().hover();
    await page.waitForTimeout(300);
    await page
      .getByTestId('home-sidebar')
      .screenshot({ path: `${OUT}/rail-icons-6-projects-dark.png` });
    await page.getByLabel('Back to Sessions').click();
    await page.emulateMedia({ colorScheme: 'light' });

    // Terminal session view header uses the same mark.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/rail-icons-4-terminal-view.png` });
  } finally {
    await app.close();
  }
});
