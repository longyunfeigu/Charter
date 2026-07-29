import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readTerminalExternalPreview,
  TERMINAL_EXTERNAL_BINARY_PREVIEW_LIMIT,
  TERMINAL_EXTERNAL_TEXT_PREVIEW_LIMIT,
} from './terminal-external-preview.js';

async function fixture(name: string, data: string | Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'terminal-preview-'));
  const path = join(root, name);
  await writeFile(path, data);
  return path;
}

describe('readTerminalExternalPreview', () => {
  it('returns raster images as a bounded base64 snapshot', async () => {
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
    const preview = await readTerminalExternalPreview(await fixture('orbit.png', bytes));
    expect(preview).toMatchObject({
      kind: 'image',
      mime: 'image/png',
      sizeBytes: bytes.length,
      text: null,
      truncated: false,
      reason: null,
    });
    expect(preview.dataBase64).toBe(bytes.toString('base64'));
  });

  it('returns HTML and scripts as source text, never executable markup', async () => {
    const source = '<script>globalThis.pwned = true</script>\n';
    const preview = await readTerminalExternalPreview(await fixture('report.html', source));
    expect(preview).toMatchObject({
      kind: 'text',
      mime: 'text/html',
      text: source,
      dataBase64: null,
      truncated: false,
    });
  });

  it('returns PDFs as a bounded base64 snapshot', async () => {
    const bytes = Buffer.from('%PDF-1.4\n%%EOF\n');
    const preview = await readTerminalExternalPreview(await fixture('report.pdf', bytes));
    expect(preview).toMatchObject({
      kind: 'pdf',
      mime: 'application/pdf',
      sizeBytes: bytes.length,
      text: null,
      truncated: false,
      reason: null,
    });
    expect(preview.dataBase64).toBe(bytes.toString('base64'));
  });

  it('returns metadata only for binary content', async () => {
    const preview = await readTerminalExternalPreview(
      await fixture('archive.bin', Uint8Array.from([0x41, 0, 0x42])),
    );
    expect(preview).toMatchObject({
      kind: 'binary',
      mime: 'application/octet-stream',
      dataBase64: null,
      text: null,
      truncated: false,
    });
  });

  it('truncates large UTF-8 text without breaking a trailing code point', async () => {
    const source = `${'a'.repeat(TERMINAL_EXTERNAL_TEXT_PREVIEW_LIMIT - 1)}\u4f60\n`;
    const preview = await readTerminalExternalPreview(await fixture('large.txt', source));
    expect(preview.kind).toBe('text');
    expect(preview.truncated).toBe(true);
    expect(preview.text?.endsWith('\ufffd')).toBe(false);
    expect(preview.text?.length).toBe(TERMINAL_EXTERNAL_TEXT_PREVIEW_LIMIT - 1);
  });

  it('does not load an oversized image into the response', async () => {
    const bytes = new Uint8Array(TERMINAL_EXTERNAL_BINARY_PREVIEW_LIMIT + 1);
    const preview = await readTerminalExternalPreview(await fixture('huge.png', bytes));
    expect(preview).toMatchObject({
      kind: 'binary',
      mime: 'image/png',
      dataBase64: null,
      text: null,
    });
    expect(preview.reason).toContain('20 MB');
  });
});
