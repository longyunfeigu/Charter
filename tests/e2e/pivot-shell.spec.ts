import { expect, test } from '@playwright/test';
import { realpathSync } from 'node:fs';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

test.describe('Unified Session shell pivot (ADR-0004, PIVOT-001..010)', () => {
  test('Home is the default entry, branding is Charter, project tools stay in the same shell', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture },
      home: 'keep',
    });
    try {
      // Opening a known project restores its last project-tool context. The
      // back affordance returns to the single Session launcher in this shell.
      await expect(page.getByTestId('project-tool-view')).toBeVisible();
      await page.getByTestId('project-tool-back').click();
      // PIVOT-001/008: Home first, Charter branding, no directory read yet.
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(page.getByTestId('home-intent')).toBeVisible();
      expect(await page.title()).toBe('Charter');
      await expect(page.getByTestId('home-view')).toContainText('What should we build?');
      await expect(page.getByTestId('home-view')).not.toContainText('Pi IDE');

      // Project files are a content state in the same persistent shell: there
      // is no second Activity Bar, Sidebar, or Agent Panel.
      await page.getByTestId('rail-context').click();
      await page.getByTestId(`home-recent-${realpathSync(fixture)}`).click();
      await page.getByTestId('tree-item-src').click();
      await page.getByTestId('tree-item-src/index.ts').click();
      await expect(page.getByTestId('home-view')).toHaveCount(0);
      await expect(page.getByTestId('project-tool-view')).toBeVisible();
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await expect(page.getByTestId('agent-panel')).toHaveCount(0);
      await page.getByTestId('project-tool-back').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('PIVOT-005/007: charter a task from Home — pick project, type intent, run to review', async () => {
    // Recents store the canonical real path (WS-001) — resolve it up front.
    const fixture = realpathSync(createTsSmallFixture());
    // First launch records the fixture as a recent workspace, then quits.
    const first = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    const userDataDir = first.userDataDir;
    await expect(first.page.getByTestId('workspace-chip')).toBeVisible();
    await first.app.close();

    // Second launch: stay on Home and drive the full fast path through the UI.
    const { app, page } = await launchApp({
      userDataDir,
      env: { PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      await expect(page.getByTestId('home-view')).toBeVisible();

      // PIVOT-002: choose the project from recents; Home stays up (mid-charter).
      // ADR-0023: recents live in the rail's Projects panel.
      await page.getByTestId('rail-context').click();
      await page.getByTestId(`project-spawn-pi-${fixture}`).click();
      await expect(page.getByTestId('home-project')).toContainText(fixture.split('/').pop()!);
      await expect(page.getByTestId('home-view')).toBeVisible();

      // PIVOT-003/004: model auto-selected (mock), approval policy set to auto.
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();

      // PIVOT-005/021/022: submit stays on the Home surface — the task's room
      // opens (never the Editor).
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] quick fix from home');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('home-view')).toHaveCount(0);
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });
      // ADR-0016: completion presents as the review bar (state), with a quiet
      // Done milestone in the timeline — no report card.
      await expect(page.getByTestId('review-bar')).toBeVisible();
      await expect(page.getByTestId('tl-done')).toBeVisible();

      // PIVOT-007: back on Home, the task remains in the persistent Session
      // rail; Home no longer repeats a Recent section. Project browsing keeps
      // its own selected rail tab, so explicitly return to Sessions here.
      await page.getByTestId('task-room-back').click();
      await expect(page.getByTestId('home-view')).not.toContainText('quick fix from home');
      await page.getByTestId('rail-view-sessions').click();
      await expect(page.getByTestId('home-sidebar')).toContainText('quick fix from home');
    } finally {
      await app.close();
    }
  });

  test('PIVOT-009: provider keys managed in Settings (store, list, delete)', async () => {
    const { app, page } = await launchApp({});
    try {
      page.on('dialog', (dialog) => void dialog.accept());
      await page.getByTestId('home-settings').click();
      await expect(page.getByTestId('overlay-settings')).toBeVisible();
      await page.getByText('Models', { exact: true }).click();

      await expect(page.getByTestId('providers-empty')).toBeVisible();
      await page.getByTestId('provider-key-input').fill('sk-test-e2e-key-000000');
      await page.getByTestId('provider-key-save').click();
      await expect(page.getByTestId('provider-row-anthropic')).toBeVisible();
      // The hint is masked — the raw key never renders.
      await expect(page.getByTestId('provider-row-anthropic')).not.toContainText(
        'sk-test-e2e-key-000000',
      );
      await expect(page.getByTestId('provider-fetch-anthropic')).toBeVisible();

      await page.getByTestId('provider-delete-anthropic').click();
      await expect(page.getByTestId('providers-empty')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
