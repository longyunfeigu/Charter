import { expect, test } from '@playwright/test';
import { appendFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

test.describe('Project Center', () => {
  test('removes a recent project from navigation after its folder is deleted', async () => {
    const deletedProject = realpathSync(createGitFixture());
    const activeProject = realpathSync(createGitFixture());
    const first = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: deletedProject, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    const userDataDir = first.userDataDir;
    await first.app.close();

    const { app, page } = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: activeProject, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      await page.getByTestId('rail-view-projects').click();
      await expect(page.getByTestId(`home-recent-${deletedProject}`)).toBeVisible();
      await page.getByTestId('rail-view-sessions').click();

      rmSync(deletedProject, { recursive: true, force: true });
      await page.getByTestId('rail-view-projects').click();

      await expect(page.getByTestId(`home-recent-${deletedProject}`)).toHaveCount(0);
      await expect(page.getByTestId(`home-recent-${activeProject}`)).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('browses independently, reports real data, and changes context only explicitly', async () => {
    const projectA = realpathSync(createGitFixture());
    const projectB = realpathSync(createGitFixture());
    writeFileSync(join(projectA, 'AGENTS.md'), '# Project A instructions\n');
    appendFileSync(join(projectA, 'README.md'), '\nLocal project change\n');

    // Register A, then launch with B as the actual working context.
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
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    try {
      await page.setViewportSize({ width: 1320, height: 820 });
      await page.getByTestId('rail-view-projects').click();
      await expect(page.getByTestId('rail-projects-panel')).toBeVisible();

      // Browsing A does not silently rebind the Files/editor/composer context.
      await page.getByTestId(`home-recent-${projectA}`).click();
      await expect(page.getByTestId('project-center')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('project-center-overview')).toBeVisible();
      await expect(page.locator('.pc-identity')).toContainText(projectA.split('/').pop()!);
      await expect(page.getByTestId(`home-recent-${projectB}`).locator('..')).toHaveClass(
        /current/,
      );
      await expect(page.getByTestId(`home-recent-${projectA}`).locator('..')).toHaveClass(
        /selected/,
      );

      // Files are inspected read-only while B remains current.
      await page.getByTestId('project-center-tab-files').click();
      await expect(page.getByTestId('project-center-files')).toBeVisible();
      await page.getByTestId('project-file-src').click();
      await page.getByTestId('project-file-src/index.ts').click();
      await expect(page.locator('.pc-file-preview pre')).toContainText('export function main');
      await expect(page.getByTestId(`home-recent-${projectB}`).locator('..')).toHaveClass(
        /current/,
      );

      // Changes and Setup are direct observations, not inferred dashboard numbers.
      await page.getByTestId('project-center-tab-changes').click();
      await expect(page.getByTestId('project-center-changes')).toContainText('README.md');
      await page.getByTestId('project-center-tab-setup').click();
      await expect(page.getByTestId('project-setup-agentsMd')).toContainText('Detected');
      await expect(page.getByTestId('project-setup-claudeMd')).toContainText('Not found');

      // Explicit action changes the working context but leaves the Project Center stable.
      await page.getByTestId('project-set-current').click();
      await expect(page.getByTestId(`home-recent-${projectA}`).locator('..')).toHaveClass(
        /current/,
        { timeout: 15_000 },
      );
      await expect(page.getByTestId('project-center')).toBeVisible();
      await expect(page.locator('.pc-badge.current')).toHaveText('Current');
      await page.getByTestId('project-center-tab-overview').click();
      await expect(page.getByTestId('project-center-overview')).toBeVisible();
      await page.screenshot({ path: join(tmpdir(), 'charter-project-center-desktop.png') });

      // Narrow layout remains usable without a document-level horizontal scroll.
      await page.setViewportSize({ width: 900, height: 900 });
      const closeRail = page.getByTestId('rail-compact-close');
      if (await closeRail.isVisible()) await closeRail.click();
      await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '0');
      await expect(page.getByTestId('project-center')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(tmpdir(), 'charter-project-center-narrow.png') });

      await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
