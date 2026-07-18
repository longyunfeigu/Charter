import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

test.describe('Project Files restructure — one canonical contextual tree', () => {
  test('projects navigate; Files/Search/Changes share one collapsible context', async () => {
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

      // Projects contains projects and actions only; selecting one routes to
      // the canonical contextual Explorer beside the editor.
      await page.getByTestId('rail-view-projects').click();
      await expect(page.getByTestId('rail-projects-panel')).toBeVisible();
      await expect(page.getByTestId('home-project-tree')).toHaveCount(0);
      await page.locator('[data-testid^="home-recent-"].active').click();
      await expect(page.getByTestId('project-tool-files')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('explorer')).toBeVisible();
      await expect(page.getByRole('tree', { name: 'Files' })).toHaveCount(1);

      await page.getByTestId('tree-item-src').click();
      await page.getByTestId('tree-item-src/index.ts').click();
      await expect(page.getByTestId('tab-src/index.ts')).toBeVisible();

      // Context collapse gives its width back to the editor. Selecting a tool
      // restores the context because the user's request makes it actionable.
      await page.getByTestId('project-context-toggle').click();
      await expect(page.locator('.project-tool-body')).toHaveClass(/context-collapsed/);
      await expect(page.getByTestId('project-tool-context')).toHaveAttribute('aria-hidden', 'true');
      await expect(page.getByTestId('project-tool-editor')).toBeVisible();
      await page.getByTestId('project-tool-search').click();
      await expect(page.locator('.project-tool-body')).not.toHaveClass(/context-collapsed/);
      await expect(page.getByTestId('search-view')).toBeVisible();
      await expect(page.getByTestId('search-input')).toBeFocused();
      await page.getByTestId('project-tool-changes').click();
      await expect(page.getByTestId('scm-view')).toBeVisible();
      await page.getByTestId('project-tool-files').click();
      await expect(page.getByTestId('explorer')).toBeVisible();

      await page.getByTestId('project-editor-split').click();
      await expect(page.getByTestId('monaco-pane-1')).toBeVisible();
      await page.getByTestId('project-editor-split').click();
      await expect(page.getByTestId('monaco-pane-1')).toHaveCount(0);

      const desktopOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(desktopOverflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: '/tmp/charter-project-files-production-1320.png' });

      // At narrow width the project list becomes an overlay controlled by the
      // same global Projects icon; the Files context remains in the workbench.
      await page.setViewportSize({ width: 900, height: 900 });
      await expect(page.locator('.sr-rail')).toHaveCSS('width', '44px');
      await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '0');
      await expect(page.getByTestId('explorer')).toBeVisible();
      await page.getByTestId('rail-view-projects').click();
      await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '1');
      await expect(page.locator('.sr-panel')).toHaveCSS('width', '290px');
      await expect(page.getByTestId('rail-projects-panel')).toBeVisible();
      await page.locator('[data-testid^="home-recent-"].active').click();
      await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '0');
      await expect(page.getByTestId('explorer')).toBeVisible();

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
