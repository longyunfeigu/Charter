import { expect, test, type Page } from '@playwright/test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';
import { terminalPtySnapshot, waitForTerminalOutput } from './helpers/terminal';

/**
 * ADR-0060 — reviewing what an external Agent changed in a plain (non-Git)
 * folder. The entry snapshot comes from a private shadow repository, so the
 * pre-existing files keep their real "before" bytes; Markdown is compared as
 * rendered prose and images as pixels; rollback restores the exact originals.
 */

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  const pixels = Buffer.concat(Array(height).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const GUIDE_BEFORE = [
  '# Release guide',
  '',
  'Ship from the main branch after the checks pass.',
  '',
  '## Steps',
  '',
  '- Bump the version',
  '- Tag the release',
  '',
].join('\n');

const GUIDE_AFTER = [
  '# Release guide',
  '',
  'Ship from a release branch once every check is green.',
  '',
  '## Steps',
  '',
  '- Bump the version',
  '- Tag the release',
  '',
  '## Rollback',
  '',
  'Revert the tag and redeploy the previous build.',
  '',
].join('\n');

function createFakeAgent(fixture: string, logoAfter: Buffer): string {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-richdiff-bin-'));
  const p = (rel: string): string => join(fixture, rel).replace(/\\/g, '/');
  writeFileSync(
    join(bin, 'fakeagent'),
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "console.log('✳ fake agent session started');",
      "process.stdin.setEncoding('utf8');",
      'let changed = false;',
      "process.stdin.on('data', (input) => {",
      "  if (changed || !input.includes('write-rich-change')) return;",
      '  changed = true;',
      `  fs.writeFileSync(${JSON.stringify(p('docs/guide.md'))}, ${JSON.stringify(GUIDE_AFTER)});`,
      `  fs.writeFileSync(${JSON.stringify(p('assets/logo.png'))}, Buffer.from(${JSON.stringify(logoAfter.toString('base64'))}, 'base64'));`,
      `  const util = ${JSON.stringify(p('src/util.ts'))};`,
      "  fs.writeFileSync(util, fs.readFileSync(util, 'utf8') + 'export const shadowTouch = 1;\\n');",
      "  console.log('rich-change-written');",
      '  setTimeout(() => process.exit(0), 2500);',
      '});',
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'fakeagent'), 0o755);
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  return bin;
}

async function useSoftwareTerminalRenderer(page: Page): Promise<void> {
  await page.getByTestId('home-settings').click();
  await page.getByTestId('settings-section-terminal').click();
  await page.getByTestId('settings-terminal-renderer').selectOption('software');
  await page.keyboard.press('Escape');
}

test('non-Git folder: shadow baseline, rendered Markdown, image compare, exact rollback', async () => {
  test.setTimeout(180_000);
  const fixture = createTsSmallFixture(); // deliberately NOT a git repository
  mkdirSync(join(fixture, 'docs'));
  mkdirSync(join(fixture, 'assets'));
  writeFileSync(join(fixture, 'docs/guide.md'), GUIDE_BEFORE);
  const logoBefore = solidPng(48, 32, [214, 72, 52]);
  const logoAfter = solidPng(48, 32, [40, 110, 220]);
  writeFileSync(join(fixture, 'assets/logo.png'), logoBefore);
  const utilBefore = readFileSync(join(fixture, 'src/util.ts'));
  const bin = createFakeAgent(fixture, logoAfter);

  const { app, page } = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'fakeagent',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: bin,
    },
  });
  try {
    await useSoftwareTerminalRenderer(page);
    await page.keyboard.press('Control+`');
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
    await page.locator('.xterm').click();
    await page.keyboard.type('echo ready-marker');
    await page.keyboard.press('Enter');
    await waitForTerminalOutput(page, 'ready-marker');
    const terminalId = (await terminalPtySnapshot(page)).items[0]!.id;
    await page.keyboard.type('fakeagent');
    await page.keyboard.press('Enter');
    await waitForTerminalOutput(page, 'fake agent session started', { terminalId });
    await expect(page.getByTestId('terminal-session-bar')).toContainText(/fakeagent/i, {
      timeout: 15000,
    });
    // The entry snapshot of the plain folder is a shadow snapshot.
    await page.locator('.xterm').click();
    await page.keyboard.type('write-rich-change');
    await page.keyboard.press('Enter');
    await waitForTerminalOutput(page, 'rich-change-written', { terminalId });
    await expect(page.getByTestId('session-bar-ended')).toContainText('3 files', {
      timeout: 30000,
    });

    await page.getByTestId('session-bar-review').click();
    await expect(page.getByTestId('task-room')).toBeVisible();
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
      timeout: 20000,
    });

    // A pre-existing file keeps its real "before": the appended line is a
    // one-line addition, not an empty first-seen diff.
    await page.getByTestId('task-room-file-src/util.ts').click();
    const inline = page.getByTestId('session-inline-diff');
    await expect(inline).toContainText('export const shadowTouch = 1;');
    await expect(inline).toContainText('return a - b;');

    // Markdown opens as a rendered reader view, aligned section by section.
    await page.getByTestId('session-diff-file-docs/guide.md').click();
    const markdown = inline.getByTestId('rich-diff-markdown');
    await expect(markdown).toBeVisible();
    await expect(page.getByTestId('diff-viewmode-rendered')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(markdown.getByTestId('md-row-changed')).toHaveCount(1);
    await expect(markdown.getByTestId('md-row-changed')).toContainText(
      'Ship from the main branch after the checks pass.',
    );
    await expect(markdown.getByTestId('md-row-changed')).toContainText(
      'Ship from a release branch once every check is green.',
    );
    await expect(markdown.getByTestId('md-row-added')).toHaveCount(2);
    await expect(markdown.locator('h2', { hasText: 'Rollback' })).toBeVisible();
    await expect(markdown.locator('.md-body code, .md-body pre')).toHaveCount(0);
    await page.screenshot({ path: join(tmpdir(), 'charter-rich-diff-markdown.png') });
    // Source stays one click away.
    await page.getByTestId('diff-viewmode-inline').click();
    await expect(inline.locator('.session-inline-diff-body')).toContainText('## Rollback');
    await page.getByTestId('diff-viewmode-rendered').click();
    await expect(markdown).toBeVisible();

    // Images compare as pixels: reveal slider by default, side by side on demand.
    await page.getByTestId('session-diff-file-assets/logo.png').click();
    const image = inline.getByTestId('rich-diff-image');
    await expect(image).toBeVisible();
    await expect(image).toContainText('48×32');
    const slider = image.getByTestId('image-compare-slider');
    await expect(slider).toBeVisible();
    await expect(slider.locator('img')).toHaveCount(2);
    await image.getByTestId('image-compare-range').fill('20');
    await expect(slider.locator('img.after')).toHaveAttribute('style', /inset\(0px 0px 0px 20%\)/);
    await page.screenshot({ path: join(tmpdir(), 'charter-rich-diff-image-slider.png') });
    await image.getByTestId('image-compare-mode-side').click();
    await expect(image.getByTestId('image-compare-before').locator('img')).toBeVisible();
    await expect(image.getByTestId('image-compare-after').locator('img')).toBeVisible();
    await page.screenshot({ path: join(tmpdir(), 'charter-rich-diff-image-side.png') });

    // The full Review overlay uses the same projections.
    await inline.getByRole('button', { name: 'Open advanced review' }).click();
    await expect(page.getByTestId('review-view')).toBeVisible();
    await page.getByTestId('review-file-docs/guide.md').click();
    await expect(
      page.getByTestId('review-rendered').getByTestId('rich-diff-markdown'),
    ).toBeVisible();
    await page.getByTestId('review-view-source').click();
    await expect(page.locator('[data-testid="review-diff"] .monaco-diff-editor')).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId('review-file-assets/logo.png').click();
    await expect(page.getByTestId('review-view').getByTestId('rich-diff-image')).toBeVisible();
    // The source editor underneath is hidden, not left painted over the image.
    await expect(page.locator('[data-testid="review-diff"] .monaco-diff-editor')).toBeHidden();
    await page.screenshot({ path: join(tmpdir(), 'charter-rich-diff-review.png') });
    // Back on a code file the same editor shows that file's diff.
    await page.getByTestId('review-file-src/util.ts').click();
    await expect(page.locator('[data-testid="review-diff"] .monaco-diff-editor')).toBeVisible();
    await expect(page.locator('[data-testid="review-diff"] .editor.modified')).toContainText(
      'shadowTouch',
    );

    // Rollback restores every pre-existing file byte for byte.
    await page.getByTestId('review-rollback').click();
    await page.getByTestId('review-rollback-confirm').click();
    await expect
      .poll(() => readFileSync(join(fixture, 'docs/guide.md'), 'utf8'), { timeout: 20000 })
      .toBe(GUIDE_BEFORE);
    expect(readFileSync(join(fixture, 'assets/logo.png')).equals(logoBefore)).toBe(true);
    expect(readFileSync(join(fixture, 'src/util.ts')).equals(utilBefore)).toBe(true);
  } finally {
    await app.close();
  }
});
