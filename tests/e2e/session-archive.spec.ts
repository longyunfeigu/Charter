import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

const PROJECT_SESSION = '9d639e68-9f1f-40b6-9351-6d3d3ea40e11';
const UNKNOWN_SESSION = '2bdcf345-b581-4baf-9bc0-23e759c5d2d8';

function writeClaudeTranscript(
  home: string,
  folder: string,
  sessionId: string,
  cwd: string,
  title: string,
  file: string,
  skill: string,
  timestamp: string,
): void {
  const root = join(home, '.claude', 'projects', folder);
  mkdirSync(root, { recursive: true });
  const lines = [
    {
      type: 'user',
      sessionId,
      cwd,
      timestamp,
      message: { content: title },
    },
    {
      type: 'assistant',
      sessionId,
      cwd,
      timestamp: new Date(Date.parse(timestamp) + 60_000).toISOString(),
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: { file_path: file } },
          { type: 'tool_use', name: 'Skill', input: { skill } },
        ],
      },
    },
  ];
  writeFileSync(
    join(root, `${sessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
}

async function startTrackedSession(page: Page): Promise<void> {
  await page.getByTestId('home-new-task').click();
  await page.getByTestId('home-advanced-toggle').click();
  await page.getByTestId('home-adv-title').fill('Tracked archive redesign');
  await page.getByTestId('home-mode-auto').click();
  await page.getByTestId('home-intent').fill('[scenario:edit-basic] Improve archive navigation.');
  await page.getByTestId('home-submit').click();
  await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
    timeout: 30_000,
  });
}

test.describe('Session Archive', () => {
  test('retrieves tracked and external history without leaking into Projects', async () => {
    const project = realpathSync(createGitFixture());
    const unknown = realpathSync(mkdtempSync(join(tmpdir(), 'charter-unknown-project-')));
    const archaeologyHome = mkdtempSync(join(tmpdir(), 'charter-archaeology-home-'));
    const now = new Date().toISOString();
    writeClaudeTranscript(
      archaeologyHome,
      'registered-project',
      PROJECT_SESSION,
      project,
      'Refactor session archive search',
      join(project, 'src', 'session-archaeology.ts'),
      'archive-search',
      now,
    );
    writeClaudeTranscript(
      archaeologyHome,
      'unregistered-project',
      UNKNOWN_SESSION,
      unknown,
      'Investigate forgotten prototype',
      join(unknown, 'prototype.ts'),
      'prototype-audit',
      now,
    );

    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: project,
        PI_IDE_FORCE_MOCK: '1',
        PI_IDE_ARCHAEOLOGY_HOME: archaeologyHome,
      },
      home: 'keep',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    try {
      await page.setViewportSize({ width: 1380, height: 860 });
      await startTrackedSession(page);

      // The persistent rail can be widened directly from its right edge.
      const rail = page.getByTestId('home-sidebar');
      const resizeHandle = page.getByTestId('rail-resize-handle');
      const railBefore = await rail.boundingBox();
      const handleBefore = await resizeHandle.boundingBox();
      expect(railBefore).not.toBeNull();
      expect(handleBefore).not.toBeNull();
      await page.mouse.move(
        handleBefore!.x + handleBefore!.width / 2,
        handleBefore!.y + handleBefore!.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        handleBefore!.x + handleBefore!.width / 2 + 110,
        handleBefore!.y + handleBefore!.height / 2,
        { steps: 6 },
      );
      await page.mouse.up();
      await expect
        .poll(async () => (await rail.boundingBox())?.width ?? 0)
        .toBeGreaterThan(railBefore!.width + 90);
      const widened = (await rail.boundingBox())!.width;
      const storedWidth = await page.evaluate(() =>
        Number(window.localStorage.getItem('charter.rail.width.v3')),
      );
      expect(Math.abs(storedWidth - widened)).toBeLessThanOrEqual(1);

      // The global archive is a Sessions retrieval path, never a Projects card.
      await expect(page.getByTestId('rail-session-archive')).toBeVisible();
      await page.getByTestId('rail-view-projects').click();
      await expect(page.getByTestId('rail-agent-activity')).toHaveCount(0);
      await page.getByTestId('rail-view-sessions').click();
      await page.getByTestId('rail-session-archive').click();
      await expect(page.getByTestId('archaeology-view')).toBeVisible();
      await expect(page.getByTestId('rail-view-sessions')).toHaveClass(/active/);
      await expect(page.locator('.arch-heading')).toContainText('Session Archive');

      // One time-first catalog contains Charter records and raw transcripts.
      await expect(page.getByTestId('archaeology-view')).toContainText('Tracked archive redesign');
      await expect(page.getByTestId('archaeology-view')).toContainText(
        'Refactor session archive search',
      );
      await expect(page.getByTestId('archaeology-view')).toContainText(
        'Investigate forgotten prototype',
      );
      await expect(page.getByTestId('arch-dir')).toHaveCount(1);

      const projectRow = page.getByTestId('arch-row').filter({
        hasText: 'Refactor session archive search',
      });
      await projectRow.click();
      await expect(page.getByTestId('arch-inspector')).toContainText('session-archaeology.ts');
      await expect(page.getByTestId('arch-inspector')).toContainText('archive-search');
      await expect(page.getByTestId('arch-inspector').getByTestId('arch-resume')).toBeVisible();

      const search = page.getByLabel('Search session archive');
      await search.fill('archive-search');
      await expect(page.getByTestId('arch-row')).toHaveCount(1);
      await expect(page.getByTestId('arch-row')).toContainText('Refactor session archive search');
      await search.fill('');
      await page.getByTestId('arch-filter-tracked').click();
      await expect(page.getByTestId('arch-row')).toHaveCount(1);
      await expect(page.getByTestId('arch-row')).toContainText('Tracked archive redesign');
      await page.getByTestId('arch-filter-all').click();
      await page.screenshot({ path: join(tmpdir(), 'charter-session-archive-desktop.png') });

      // Project Sessions is the scoped archaeology view, including external work.
      await page.getByTestId('rail-view-projects').click();
      await expect(page.getByTestId('project-center')).toBeVisible();
      await page.getByTestId('project-center-tab-sessions').click();
      await expect(page.getByTestId('project-center-sessions')).toContainText(
        'Tracked archive redesign',
      );
      await expect(page.getByTestId('project-center-sessions')).toContainText(
        'Refactor session archive search',
      );
      await expect(page.getByTestId('project-center-sessions')).not.toContainText(
        'Investigate forgotten prototype',
      );
      await page.getByLabel('Search project sessions').fill('archive-search');
      await expect(page.locator('.pc-session-card')).toHaveCount(1);
      await page.screenshot({ path: join(tmpdir(), 'charter-project-session-history.png') });

      await page.getByRole('button', { name: /Browse all machine history/ }).click();
      await expect(page.getByTestId('archaeology-view')).toBeVisible();

      // Compact width keeps the primary retrieval path usable and overflow-free.
      await page.setViewportSize({ width: 900, height: 900 });
      await expect(resizeHandle).toBeHidden();
      const closeRail = page.getByTestId('rail-compact-close');
      if (await closeRail.isVisible()) await closeRail.click();
      await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '0');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(tmpdir(), 'charter-session-archive-narrow.png') });

      await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
