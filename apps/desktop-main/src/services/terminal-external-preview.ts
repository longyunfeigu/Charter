import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FileHandle } from 'node:fs/promises';

export const TERMINAL_EXTERNAL_BINARY_PREVIEW_LIMIT = 20 * 1024 * 1024;
export const TERMINAL_EXTERNAL_TEXT_PREVIEW_LIMIT = 1024 * 1024;

interface TerminalExternalPreviewBase {
  mime: string;
  sizeBytes: number;
  truncated: boolean;
  reason: string | null;
}

export type TerminalExternalPreview =
  | (TerminalExternalPreviewBase & {
      kind: 'image' | 'pdf';
      dataBase64: string;
      text: null;
    })
  | (TerminalExternalPreviewBase & {
      kind: 'text';
      dataBase64: null;
      text: string;
    })
  | (TerminalExternalPreviewBase & {
      kind: 'binary';
      dataBase64: null;
      text: null;
      truncated: false;
      reason: string;
    });

interface BinaryPreview extends TerminalExternalPreviewBase {
  kind: 'binary';
  dataBase64: null;
  text: null;
  truncated: false;
  reason: string;
}

const IMAGE_MIME = new Map<string, string>([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

const TEXT_MIME = new Map<string, string>([
  ['.css', 'text/css'],
  ['.csv', 'text/csv'],
  ['.htm', 'text/html'],
  ['.html', 'text/html'],
  ['.js', 'text/javascript'],
  ['.json', 'application/json'],
  ['.jsx', 'text/jsx'],
  ['.md', 'text/markdown'],
  ['.mjs', 'text/javascript'],
  ['.py', 'text/x-python'],
  ['.sh', 'text/x-shellscript'],
  ['.svg', 'image/svg+xml'],
  ['.toml', 'application/toml'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/tsx'],
  ['.txt', 'text/plain'],
  ['.xml', 'application/xml'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
]);

async function readBytes(handle: FileHandle, length: number): Promise<Buffer> {
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(output, offset, length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === length ? output : output.subarray(0, offset);
}

function containsBinaryControls(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      return true;
    }
  }
  return false;
}

function binaryPreview(mime: string, sizeBytes: number, reason: string): BinaryPreview {
  return {
    kind: 'binary',
    mime,
    sizeBytes,
    dataBase64: null,
    text: null,
    truncated: false,
    reason,
  };
}

/** Read one immutable, bounded file-descriptor snapshot for the renderer. */
export async function readTerminalExternalPreview(path: string): Promise<TerminalExternalPreview> {
  const handle = await open(path, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('The selected path is not a regular file.');
    const sizeBytes = stats.size;
    const extension = extname(path).toLowerCase();
    const imageMime = IMAGE_MIME.get(extension);

    if (imageMime) {
      if (sizeBytes > TERMINAL_EXTERNAL_BINARY_PREVIEW_LIMIT) {
        return binaryPreview(
          imageMime,
          sizeBytes,
          'This image is larger than the 20 MB preview limit.',
        );
      }
      const bytes = await readBytes(handle, sizeBytes);
      return {
        kind: 'image',
        mime: imageMime,
        sizeBytes,
        dataBase64: bytes.toString('base64'),
        text: null,
        truncated: false,
        reason: null,
      };
    }

    if (extension === '.pdf') {
      if (sizeBytes > TERMINAL_EXTERNAL_BINARY_PREVIEW_LIMIT) {
        return binaryPreview(
          'application/pdf',
          sizeBytes,
          'This PDF is larger than the 20 MB preview limit.',
        );
      }
      const bytes = await readBytes(handle, sizeBytes);
      return {
        kind: 'pdf',
        mime: 'application/pdf',
        sizeBytes,
        dataBase64: bytes.toString('base64'),
        text: null,
        truncated: false,
        reason: null,
      };
    }

    const readLength = Math.min(sizeBytes, TERMINAL_EXTERNAL_TEXT_PREVIEW_LIMIT);
    const bytes = await readBytes(handle, readLength);
    const mime = TEXT_MIME.get(extension) ?? 'text/plain';
    if (containsBinaryControls(bytes)) {
      return binaryPreview(
        'application/octet-stream',
        sizeBytes,
        'No safe text preview is available.',
      );
    }
    try {
      const truncated = sizeBytes > bytes.byteLength;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
      return {
        kind: 'text',
        mime,
        sizeBytes,
        dataBase64: null,
        text,
        truncated,
        reason: truncated ? 'Showing the first 1 MB of this file.' : null,
      };
    } catch {
      return binaryPreview(
        'application/octet-stream',
        sizeBytes,
        'This file is not valid UTF-8 text.',
      );
    }
  } finally {
    await handle.close();
  }
}
