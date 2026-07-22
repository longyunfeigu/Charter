import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('rich Markdown authoring', () => {
  test('insertion tools and fenced-code language preserve the Monaco-backed document path', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      await page.getByTestId('rail-tab-files').click();
      await page.getByTestId('tree-item-README.md').click();
      await page.getByTestId('md-mode-rich').click();
      await expect(page.getByTestId('md-rich-editor')).toBeVisible();

      await expect(page.getByRole('radio', { name: 'Inline code format' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Insert Table' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Insert thematic break' })).toBeVisible();

      const paragraph = page.locator('.md-rich-content p').first();
      await paragraph.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });
      await expect(page.getByTestId('md-selection-toolbar')).toBeVisible();

      await paragraph.click();
      await page.keyboard.press('End');
      await page.keyboard.press('/');
      await expect(page.getByTestId('md-slash-menu')).toBeVisible();
      await expect(page.getByRole('option', { name: /Heading 2/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('md-slash-menu')).toHaveCount(0);

      await page.locator('.md-rich-content').click();
      await page.getByRole('button', { name: 'Insert Code Block' }).click();
      const codeBlock = page.locator('.md-plain-code').last();
      await expect(codeBlock).toBeVisible();
      await codeBlock
        .getByRole('combobox', { name: 'Code block language' })
        .selectOption('typescript');
      await codeBlock.locator('textarea').fill('const answer: number = 42;');
      await expect(page.getByTestId('status-dirty')).toBeVisible();
      await page.keyboard.press(`${mod}+s`);

      await expect
        .poll(() => readFileSync(join(fixture, 'README.md'), 'utf8'))
        .toContain('```typescript\nconst answer: number = 42;\n```');

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 900, height: 900 });
      });
      await expect(page.getByTestId('md-rich-editor')).toBeVisible();
      await expect(codeBlock.getByRole('combobox', { name: 'Code block language' })).toBeVisible();
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(pageErrors).toEqual([]);

      if (process.env.PI_IDE_QA_SCREENSHOT) {
        await paragraph.click();
        await page.keyboard.press('End');
        await page.keyboard.press('/');
        await expect(page.getByTestId('md-slash-menu')).toBeVisible();
        await page.screenshot({ path: '/tmp/markdown-rich-toolbar-900x900.png' });
        await page.keyboard.press('Escape');
      }
    } finally {
      await app.close();
    }
  });
});
