import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

/**
 * Identifiers are data, not copy: with the UI in Simplified Chinese, branch,
 * file and project names must render verbatim (a branch called "main" must
 * never become "主要") while the surrounding chrome translates.
 */
test.describe('zh-CN chrome vs identifiers', () => {
  test('branch and file names stay verbatim under a translated chrome', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      await page.getByTestId('home-settings').click();
      await page.getByTestId('settings-section-general').click();
      await page.getByTestId('settings-locale').selectOption('zh-CN');
      await page.keyboard.press('Escape');
      // Locale switching is live: App remounts the Workbench on locale change
      // (key={locale}), which re-renders t() call sites and re-arms the
      // chrome auto-translation layer — no reload involved.
      await expect(page.getByTestId('home-view')).toBeVisible({ timeout: 15000 });

      await page.getByTestId('rail-view-projects').click();
      await page.locator('[data-testid^="home-recent-"]').first().click();
      await expect(page.getByTestId('project-center')).toBeVisible();

      // Chrome is Chinese…
      await expect(page.getByTestId('project-center-tab-files')).toContainText('文件');
      // …while the branch identifier stays verbatim: the fixture repo is
      // `git init -b main`, and "main" must not localize to "主要".
      await expect(page.locator('.pc-header-git')).toContainText('main');
      await expect(page.locator('.pc-header-git')).not.toContainText('主要');

      // File names in the tree render verbatim too ("index" is a catalog key).
      await page.getByTestId('project-center-tab-files').click();
      await page.getByTestId('project-file-src').click();
      await expect(page.getByTestId('project-file-src/index.ts')).toContainText('index.ts');
      await expect(page.getByTestId('project-center-files')).not.toContainText('索引');
    } finally {
      await app.close();
    }
  });

  test('the work capture page translates its section chrome', async () => {
    const { app, page } = await launchApp({ env: { PI_IDE_FORCE_MOCK: '1' }, home: 'keep' });
    try {
      await page.getByTestId('home-settings').click();
      await page.getByTestId('settings-section-general').click();
      await page.getByTestId('settings-locale').selectOption('zh-CN');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('home-view')).toBeVisible({ timeout: 15000 });

      await page.getByTestId('rail-view-work').click();
      await page.getByTestId('work-new-item').click();
      const workPage = page.getByTestId('work-item-page');
      await expect(workPage).toBeVisible();

      // Reported leftovers: the outcome/background sections stayed English
      // while their neighbours translated. Headings and placeholders must
      // localize through the chrome layer.
      await expect(workPage).toContainText('结果 / 请求');
      await expect(workPage).toContainText('背景与上下文');
      await expect(workPage).not.toContainText('Outcome / request');
      await expect(workPage).not.toContainText('Background and context');
      await expect(page.getByTestId('work-description')).toHaveAttribute(
        'placeholder',
        '这件事完成时，什么应当成立？',
      );
      await expect(page.getByTestId('work-background')).toHaveAttribute(
        'placeholder',
        '为什么是现在、相关历史、约束、链接和已做出的决定',
      );
      await expect(workPage).toContainText('附件与链接');
    } finally {
      await app.close();
    }
  });
});
