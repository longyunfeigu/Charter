import { expect, test, type Page } from '@playwright/test';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

async function startMockTask(page: Page, title: string, intent: string): Promise<void> {
  await page.getByTestId('home-new-task').click();
  await expect(page.getByTestId('home-view')).toBeVisible();
  await page.getByTestId('home-advanced-toggle').click();
  await page.getByTestId('home-adv-title').fill(title);
  await page.getByTestId('home-mode-auto').click();
  await expect(page.getByTestId('home-model')).toContainText(/mock/i);
  await page.getByTestId('home-intent').fill(intent);
  await page.getByTestId('home-submit').click();
}

test.describe('Session rail and conversation role polish', () => {
  test('renders the approved rail, semantic badges and per-skin message roles', async () => {
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
      await page.setViewportSize({ width: 1220, height: 780 });
      await startMockTask(
        page,
        'Review earth animation',
        '[scenario:edit-basic] Build an earth rotation animation with a star field.',
      );
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30_000,
      });
      await expect(page.locator('.sr-state.review')).toHaveText('Review');

      await startMockTask(
        page,
        'Explain the render pipeline',
        '[scenario:edit-plan-review] Explain the renderer without changing files.',
      );
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30_000,
      });

      await expect(page.locator('.sr-state.answered')).toHaveText('Answered');
      await expect(page.locator('.sr-state.review')).toHaveText('Review');
      await expect(page.getByTestId('rail-session-search')).toBeVisible();
      await expect(page.getByTestId('rail-needs-filter')).toBeVisible();
      await expect(page.getByTestId('rail-view-sessions')).toHaveClass(/active/);
      await expect(page.locator('.sr-rail')).toHaveCSS('width', '320px');
      await expect(page.locator('.sr-activity')).toHaveCSS('width', '44px');

      await page.getByTestId('rail-session-search').fill('earth animation');
      await expect(page.locator('button[data-testid^="home-task-"]')).toHaveCount(1);
      await page.getByTestId('rail-session-search').fill('');
      await page.getByTestId('rail-needs-filter').click();
      await expect(page.getByTestId('rail-needs-filter')).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('rail-needs-filter').click();

      const userColors: string[] = [];
      for (const skin of ['studio', 'archive', 'terminal', 'index']) {
        const roles = await page.evaluate((nextSkin) => {
          document.documentElement.dataset.skin = nextSkin;
          document.documentElement.dataset.theme = 'light';
          const user = getComputedStyle(
            document.querySelector<HTMLElement>('[data-testid="tl-user"] .rt-text')!,
          );
          const agent = getComputedStyle(
            document.querySelector<HTMLElement>('[data-testid="tl-agent"] .rt-text')!,
          );
          return {
            userBackground: user.backgroundColor,
            userColor: user.color,
            agentBackground: agent.backgroundColor,
            agentBorder: agent.borderTopWidth,
          };
        }, skin);
        userColors.push(roles.userBackground);
        expect(roles.userBackground).not.toBe('rgba(0, 0, 0, 0)');
        expect(roles.userColor).not.toBe(roles.userBackground);
        expect(roles.agentBackground).toBe('rgba(0, 0, 0, 0)');
        expect(roles.agentBorder).toBe('0px');
      }
      expect(new Set(userColors).size).toBe(4);

      await page.evaluate(() => {
        document.documentElement.dataset.skin = 'archive';
        document.documentElement.dataset.theme = 'light';
      });
      await page.screenshot({
        path: join(tmpdir(), 'charter-session-rail-production-desktop.png'),
        fullPage: true,
      });

      await page.setViewportSize({ width: 960, height: 720 });
      await expect(page.locator('.sr-rail')).toHaveCSS('width', '304px');
      await page.screenshot({
        path: join(tmpdir(), 'charter-session-rail-production-narrow.png'),
        fullPage: true,
      });

      await page.setViewportSize({ width: 963, height: 749 });
      await page.getByTestId('home-new-task').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(page.locator('.hm-mc')).toHaveCount(0);
      await expect(page.getByTestId('home-mc-needs')).toHaveCount(0);
      await expect(page.getByTestId('home-mc-running')).toHaveCount(0);
      await expect(page.getByTestId('home-mc-recent')).toHaveCount(0);
      await expect(page.getByTestId('rail-needs-you')).toContainText('1');
      await page.screenshot({
        path: join(tmpdir(), 'charter-home-without-mission-control.png'),
        fullPage: true,
      });

      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('switches project context into the one canonical Files tool', async () => {
    const projectA = realpathSync(createGitFixture());
    const projectB = realpathSync(createGitFixture());
    const first = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: projectA, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    const userDataDir = first.userDataDir;
    await first.app.close();

    const { app, page } = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: projectB, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      await expect(page.getByTestId('rail-context')).toContainText(projectB.split('/').pop()!);
      await page.getByTestId('rail-context').click();
      await expect(page.getByTestId('rail-projects-panel')).toBeVisible();

      await page.getByTestId(`home-recent-${projectA}`).click();
      await expect(page.getByTestId('project-tool-view')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('rail-view-projects')).toHaveClass(/active/);
      await expect(page.getByTestId(`home-recent-${projectA}`)).toHaveClass(/active/);
      await expect(page.getByTestId('explorer')).toBeVisible();
      await expect(page.getByTestId('home-project-tree')).toHaveCount(0);
      await page.screenshot({
        path: join(tmpdir(), 'charter-project-files-canonical.png'),
        fullPage: true,
      });
    } finally {
      await app.close();
    }
  });
});
