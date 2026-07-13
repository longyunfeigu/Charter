import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** 5×5 red-dot PNG. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==';

test.describe('P3 — light editing (PIVOT-019/020, ADR-0007)', () => {
  test('PIVOT-019: rich markdown edits save through the normal document path', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await page.getByTestId('tree-item-README.md').click();
      await expect(page.getByTestId('tab-README.md')).toBeVisible();

      // Source is the default (existing behavior unchanged); one click to rich.
      await expect(page.getByTestId('md-mode-toggle')).toBeVisible();
      await expect(page.locator('.monaco-editor').first()).toBeVisible();
      await page.getByTestId('md-mode-rich').click();
      await expect(page.getByTestId('md-rich-editor')).toBeVisible();

      // Type in the rich surface; the shared model turns dirty; ⌘S persists.
      await page.locator('.md-rich-content').click();
      await page.keyboard.type('Hello rich world. ');
      await expect(page.getByTestId('status-dirty')).toBeVisible();
      await page.keyboard.press(`${mod}+s`);
      await expect
        .poll(() => readFileSync(join(fixture, 'README.md'), 'utf8'))
        .toContain('Hello rich world.');
      await expect(page.getByTestId('status-dirty')).toHaveCount(0);

      // Back to source: Monaco shows exactly what was saved.
      await page.getByTestId('md-mode-source').click();
      await expect(page.getByTestId('md-rich-editor')).toHaveCount(0);
      await expect(page.locator('.monaco-editor').first()).toContainText('Hello rich world.');
    } finally {
      await app.close();
    }
  });

  test('PIVOT-020: annotate an image, save a copy, attach it to a new charter', async () => {
    const fixture = createTsSmallFixture();
    mkdirSync(join(fixture, 'assets'), { recursive: true });
    writeFileSync(join(fixture, 'assets/screen.png'), Buffer.from(TINY_PNG, 'base64'));
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('tree-item-assets').click();
      await page.getByTestId('tree-item-assets/screen.png').click();
      await expect(page.getByTestId('image-view')).toBeVisible();

      await page.getByTestId('annotate-open').click();
      await expect(page.getByTestId('annotator')).toBeVisible();

      // Draw a box on the canvas.
      await page.getByTestId('annot-tool-rect').click();
      const box = (await page.getByTestId('annot-canvas').boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7);
      await page.mouse.up();
      await page.getByTestId('annot-undo').isEnabled(); // a shape was recorded

      // Save & attach: a copy lands next to the original, never overwriting it,
      // and Home opens with the annotated file pre-referenced.
      await page.getByTestId('annot-attach').click();
      await expect(page.getByTestId('home-view')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('home-ref-assets/screen.annotated.png')).toBeVisible();
      expect(existsSync(join(fixture, 'assets/screen.annotated.png'))).toBe(true);
      expect(readFileSync(join(fixture, 'assets/screen.png')).toString('base64')).toBe(TINY_PNG);
    } finally {
      await app.close();
    }
  });
});
