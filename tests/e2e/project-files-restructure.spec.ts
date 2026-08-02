import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

/**
 * ADR-0029: one project tree. The rail's Files pane is the canonical tree
 * (browsing + management + context feeding); the Editor surface keeps only
 * Search/Changes as its contextual column and collapses to the plain editor.
 */
test.describe('Project Files — one canonical tree in the rail', () => {
  test('projects route to the rail tree; Search/Changes toggle beside the editor', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    const rendererErrors: string[] = [];
    page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`);
    });

    try {
      await page.setViewportSize({ width: 1320, height: 760 });
      await page.evaluate(() => {
        document.documentElement.dataset.skin = 'archive';
        document.documentElement.dataset.theme = 'light';
      });
      await expect(page.getByTestId('project-tool-view')).toBeVisible({ timeout: 15_000 });

      // The Editor surface offers no Files tool — the tree is not duplicated.
      await expect(page.getByTestId('project-tool-files')).toHaveCount(0);
      await expect(page.getByTestId('project-tool-context')).toHaveAttribute('aria-hidden', 'true');
      await expect(page.locator('.project-tool-body')).toHaveClass(/context-collapsed/);

      // Selecting a project opens its stable Center without entering the
      // editor. Files can be inspected there, then opened explicitly.
      await page.getByTestId('rail-view-projects').click();
      await expect(page.getByTestId('rail-projects-panel')).toBeVisible();
      await expect(page.getByTestId('home-project-tree')).toHaveCount(0);
      await page.locator('[data-testid^="home-recent-"]').first().click();
      await expect(page.getByTestId('project-center')).toBeVisible();
      await page.getByTestId('project-center-tab-files').click();
      await page.getByTestId('project-file-src').click();
      await page.getByTestId('project-file-src/index.ts').click();
      await page.getByRole('button', { name: 'Open in editor' }).click();
      await expect(page.getByTestId('rail-tab-files')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('explorer')).toBeVisible();
      await expect(page.getByRole('tree', { name: 'Files' })).toHaveCount(1);
      await expect(page.getByTestId('tab-src/index.ts')).toBeVisible();

      // The tree carries the management surface (merged from the old Files
      // tool): the pane's New File action creates through the normal fs path.
      await page.getByTestId('explorer-new-file').click();
      await page.getByTestId('explorer-inline-input').fill('notes-e2e.md');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('tab-notes-e2e.md')).toBeVisible({ timeout: 10_000 });

      // Search/Changes share one collapsible context; selecting the active
      // tool again gives its width back to the editor.
      await page.getByTestId('project-tool-search').click();
      await expect(page.locator('.project-tool-body')).not.toHaveClass(/context-collapsed/);
      await expect(page.getByTestId('search-view')).toBeVisible();
      await expect(page.getByTestId('search-input')).toBeFocused();
      await page.getByTestId('project-tool-changes').click();
      await expect(page.getByTestId('scm-view')).toBeVisible();
      await page.getByTestId('project-tool-changes').click();
      await expect(page.locator('.project-tool-body')).toHaveClass(/context-collapsed/);
      await expect(page.getByTestId('project-tool-context')).toHaveAttribute('aria-hidden', 'true');
      await expect(page.getByTestId('project-tool-editor')).toBeVisible();

      await page.getByTestId('project-editor-split').click();
      await expect(page.getByTestId('monaco-pane-1')).toBeVisible();
      await page.getByTestId('project-editor-split').click();
      await expect(page.getByTestId('monaco-pane-1')).toHaveCount(0);

      const desktopOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(desktopOverflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: '/tmp/charter-project-files-production-1320.png' });

      // At narrow width every rail panel becomes an overlay controlled by the
      // stable labeled navigation strip.
      await page.setViewportSize({ width: 900, height: 900 });
      await expect(page.locator('.sr-rail')).toHaveCSS('width', '78px');
      await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '0');
      await page.getByTestId('rail-view-projects').click();
      await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '1');
      await expect(page.getByTestId('rail-projects-panel')).toBeVisible();
      await page.locator('[data-testid^="home-recent-"]').first().click();
      await expect(page.locator('.sr-rail')).toHaveCSS('width', '78px');
      await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '0');
      await expect(page.getByTestId('project-center')).toBeVisible();
      await page.screenshot({ path: '/tmp/charter-project-files-drawer-900.png' });

      const narrowOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(narrowOverflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: '/tmp/charter-project-files-production-900.png' });

      await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
