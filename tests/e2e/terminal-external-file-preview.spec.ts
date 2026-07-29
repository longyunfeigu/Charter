import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';
import { waitForTerminalOutput } from './helpers/terminal';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

function collisionName(name: string): string {
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem} (1)${extension}`;
}

function pdfFixture(): string {
  const stream = 'BT\n/F1 20 Tf\n72 720 Td\n(External PDF preview) Tj\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  return `${source}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
}

test.describe('terminal external file preview', () => {
  test('previews safely, exposes explicit actions, and copies without overwrite', async () => {
    const fixture = createTsSmallFixture();
    const nonce = `${process.pid}-${Date.now()}`;
    const imagePath = `/tmp/charter-external-orbit-${nonce}.png`;
    const htmlPath = `/tmp/charter-external-source-${nonce}.html`;
    const pdfPath = `/tmp/charter-external-document-${nonce}.pdf`;
    const png = readFileSync(join(process.cwd(), 'docs/assets/readme/live-preview.png'));
    writeFileSync(imagePath, png);
    writeFileSync(
      htmlPath,
      '<script>document.body.dataset.executed = "yes"</script>\n<h1>Source only</h1>\n',
    );
    writeFileSync(pdfPath, pdfFixture());
    writeFileSync(join(fixture, basename(imagePath)), Buffer.from('existing project file'));

    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
      await page.getByTestId('home-settings').click();
      await page.getByTestId('settings-section-terminal').click();
      await page.getByTestId('settings-terminal-renderer').selectOption('software');
      await page.keyboard.press('Escape');

      await page.keyboard.press('Control+`');
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });

      await page.locator('.xterm').click();
      await page.keyboard.type(`echo ${imagePath}`);
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, imagePath);
      const imageRow = page
        .locator('.xterm-rows > div')
        .filter({ hasText: imagePath })
        .filter({ hasNotText: 'echo' })
        .first();
      await expect(imageRow).toBeVisible();
      await imageRow.click({ position: { x: 120, y: 8 }, modifiers: [mod], force: true });

      const dialog = page.getByTestId('external-file-preview');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('External file');
      await expect(dialog).toContainText('Read-only');
      await expect(page.getByTestId('external-file-image')).toBeVisible();
      await expect(page.locator('.toast', { hasText: 'outside' })).toHaveCount(0);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);

      await page.getByTestId('external-file-system').click();
      await expect(dialog).toBeVisible();
      await page.getByTestId('external-file-reveal').click();
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(250);
      await page.screenshot({ path: '/tmp/charter-external-preview-desktop.png' });

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 760, height: 820 });
      });
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId('external-file-copy')).toBeVisible();
      await page.waitForTimeout(250);
      await page.screenshot({ path: '/tmp/charter-external-preview-narrow.png' });

      await page.getByTestId('external-file-close').click();
      await expect(dialog).toBeHidden();
      await page.locator('.xterm').click();
      await page.keyboard.type(`echo ${htmlPath}`);
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, htmlPath);
      const htmlRow = page
        .locator('.xterm-rows > div')
        .filter({ hasText: htmlPath })
        .filter({ hasNotText: 'echo' })
        .first();
      await htmlRow.click({ position: { x: 120, y: 8 }, modifiers: [mod], force: true });
      await expect(page.getByTestId('external-file-text')).toContainText('<script>');
      await expect(page.getByTestId('external-file-text')).toContainText('Source only');
      await expect(dialog.locator('iframe')).toHaveCount(0);
      await expect(page.locator('body')).not.toHaveAttribute('data-executed', 'yes');
      await page.waitForTimeout(250);
      await page.screenshot({ path: '/tmp/charter-external-html-source.png' });
      await page.getByTestId('external-file-close').click();

      await page.locator('.xterm').click();
      await page.keyboard.type(`echo ${pdfPath}`);
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, pdfPath);
      const pdfRow = page
        .locator('.xterm-rows > div')
        .filter({ hasText: pdfPath })
        .filter({ hasNotText: 'echo' })
        .first();
      await pdfRow.click({ position: { x: 120, y: 8 }, modifiers: [mod], force: true });
      const pdfViewer = page.getByTestId('artifact-pdf-view');
      await expect(pdfViewer).toBeVisible();
      await expect
        .poll(() =>
          pdfViewer.locator('canvas').evaluate((canvas) => (canvas as HTMLCanvasElement).height),
        )
        .toBeGreaterThan(200);
      await expect(page.getByTestId('artifact-pdf-error')).not.toBeAttached();
      await expect(pdfViewer.getByRole('button', { name: 'Mark region' })).not.toBeAttached();
      await page.getByTestId('external-file-close').click();

      await imageRow.click({ position: { x: 120, y: 8 }, modifiers: [mod], force: true });
      await expect(page.getByTestId('external-file-image')).toBeVisible();
      await page.getByTestId('external-file-copy').click();
      const copiedName = collisionName(basename(imagePath));
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId(`tab-${copiedName}`)).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('image-view')).toBeVisible();
      expect(existsSync(join(fixture, copiedName))).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await app.close();
      rmSync(imagePath, { force: true });
      rmSync(htmlPath, { force: true });
      rmSync(pdfPath, { force: true });
    }
  });
});
