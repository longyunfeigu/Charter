import { expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { launchApp } from './helpers/launch.js';

const MOCK_PATH = new URL(
  '../../docs/design/project-files-restructure-mock/index.html',
  import.meta.url,
);
const SOURCE_PATH = '/var/folders/23/z96fd00x791_2j0k757hsnjw0000gn/T/codex-clipboard-L9LGiE.png';

test('Project Files restructure mock keeps one canonical file tree', async () => {
  const { app, page } = await launchApp({ home: 'keep' });
  const rendererErrors: string[] = [];
  page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`);
  });

  try {
    // The provided Retina capture is 2640×1520, corresponding to a 1320×760
    // logical desktop viewport. Compare at the logical size so UI density is honest.
    await page.setViewportSize({ width: 1320, height: 760 });
    await page.goto(pathToFileURL(MOCK_PATH.pathname).href);
    await expect(page.getByRole('main')).toBeVisible();

    // Global Projects owns projects only. Files live in the one contextual tree.
    await expect(page.locator('.projects-panel .tree-row')).toHaveCount(0);
    await expect(page.locator('.context-pane .tree-row').first()).toBeVisible();
    await expect(page.locator('.context-pane')).toContainText('OPUS.md');

    // The context rail changes identity instead of adding another sidebar.
    await page.getByRole('tab', { name: /Search/ }).click();
    await expect(page.locator('[data-panel="search"]')).toBeVisible();
    await page.getByRole('tab', { name: /Changes/ }).click();
    await expect(page.locator('[data-panel="changes"]')).toBeVisible();
    await page.getByRole('tab', { name: /Files/ }).click();

    // Context can collapse; Split affects the editor canvas only.
    await page.locator('#context-toggle').click();
    await expect(page.locator('.app')).toHaveClass(/context-collapsed/);
    await page.locator('#context-toggle').click();
    await page.locator('#split-editor').click();
    await expect(page.locator('.editor-stage')).toHaveClass(/split/);
    await page.locator('#split-editor').click();

    await page.screenshot({ path: '/tmp/charter-project-files-mock-1320.png' });

    await page.setViewportSize({ width: 900, height: 900 });
    await expect(page.locator('.app')).not.toHaveClass(/projects-open/);
    await expect(page.locator('.context-pane .tree-row').first()).toBeVisible();
    await page.waitForTimeout(200);
    await page.screenshot({ path: '/tmp/charter-project-files-mock-900.png' });

    await page.locator('#projects-toggle').click();
    await expect(page.locator('.app')).toHaveClass(/projects-open/);
    await expect(page.locator('.projects-panel')).toBeVisible();
    await page.locator('.project-card[data-project="charter"]').click();
    await expect(page.locator('#project-title')).toHaveText('charter');

    expect(rendererErrors).toEqual([]);

    const sourceUrl = pathToFileURL(SOURCE_PATH).href;
    const implementationUrl = pathToFileURL('/tmp/charter-project-files-mock-1320.png').href;
    await page.setViewportSize({ width: 2640, height: 800 });
    await page.setContent(`
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; background: #211711; color: #fff8e9; font: 14px system-ui; }
        main { display: grid; grid-template-columns: 1320px 1320px; }
        figure { margin: 0; background: #211711; }
        figcaption { height: 40px; display: flex; align-items: center; padding: 0 14px; }
        img { display: block; width: 1320px; height: 760px; object-fit: contain; background: #fbf2df; }
      </style>
      <main>
        <figure><figcaption>Source · current duplicated file trees</figcaption><img src="${sourceUrl}"></figure>
        <figure><figcaption>Mock · one canonical context tree</figcaption><img src="${implementationUrl}"></figure>
      </main>
    `);
    await expect(page.locator('img').first()).toBeVisible();
    await page.screenshot({ path: '/tmp/charter-project-files-comparison.png' });

    await page.setViewportSize({ width: 1280, height: 760 });
    await page.setContent(`
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; background: #211711; color: #fff8e9; font: 13px system-ui; }
        main { display: grid; grid-template-columns: 640px 640px; }
        figure { position: relative; height: 760px; margin: 0; overflow: hidden; background: #fbf2df; }
        figcaption { position: absolute; z-index: 2; top: 0; left: 0; padding: 7px 10px; background: #211711; }
        img { position: absolute; top: 0; left: 0; width: 1320px; height: 760px; }
      </style>
      <main>
        <figure><figcaption>Source · global tree + explorer</figcaption><img src="${sourceUrl}"></figure>
        <figure><figcaption>Mock · projects + one explorer</figcaption><img src="${implementationUrl}"></figure>
      </main>
    `);
    await expect(page.locator('img').first()).toBeVisible();
    await page.screenshot({ path: '/tmp/charter-project-files-comparison-focused.png' });
  } finally {
    await app.close();
  }
});
