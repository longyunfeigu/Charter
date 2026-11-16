import { promises as fsp } from 'node:fs';
import { basename, extname } from 'node:path';
import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { MAX_SCREENSHOT_BYTES, SCREENSHOT_ASSETS_DIR } from '@pi-ide/ipc-contracts';
import { resolveInsideRoot } from '@pi-ide/workspace-service';
import { registerHandlers } from './router.js';
import { imageMimeForPath } from './context-attachment-handlers.js';
import type { ScreenshotWatcher } from '../services/screenshot-watcher.js';
import type { WorkspaceHost } from '../services/workspace-host.js';

/**
 * ADR-0036 — screenshot quick card, request/response half. The renderer's
 * reach is deliberately narrow: reads and path-copies are only honored for
 * paths the watcher itself announced; writes land only inside the workspace's
 * assets/screenshots/ (never overwriting, atomic), or as annotated PNG bytes
 * that must carry the PNG magic (same guard as image.saveAnnotated).
 */

function mustBeSeen(watcher: ScreenshotWatcher, path: string): void {
  if (!watcher.seen(path)) {
    throw new ProductFailure(
      productError('SCREENSHOT_UNKNOWN', {
        userMessage: 'This screenshot is no longer offered — take a new one.',
      }),
    );
  }
}

/** "Screenshot 2026….png" → a free assets/screenshots/ name (-2, -3… suffix). */
async function pickAssetTarget(
  root: string,
  requestedName: string,
  forcedExtension: string | null,
): Promise<{ absPath: string; relPath: string; name: string }> {
  const cleaned = basename(requestedName)
    .replace(/[\\/:]/gu, '-')
    .trim();
  const extension = forcedExtension ?? extname(cleaned).toLowerCase();
  const stem = (extension ? cleaned.slice(0, -extname(cleaned).length || undefined) : cleaned)
    .replace(/\.+$/u, '')
    .trim();
  const safeStem = stem || 'screenshot';
  const dirAbs = await resolveInsideRoot(root, SCREENSHOT_ASSETS_DIR);
  await fsp.mkdir(dirAbs, { recursive: true });
  for (let n = 1; n < 1000; n += 1) {
    const name = n === 1 ? `${safeStem}${extension}` : `${safeStem}-${n}${extension}`;
    const relPath = `${SCREENSHOT_ASSETS_DIR}/${name}`;
    const absPath = await resolveInsideRoot(root, relPath);
    const exists = await fsp.access(absPath).then(
      () => true,
      () => false,
    );
    if (!exists) return { absPath, relPath, name };
  }
  throw new ProductFailure(
    productError('SCREENSHOT_ASSETS_FULL', {
      userMessage: 'Too many files with this name in assets/screenshots — rename some first.',
    }),
  );
}

async function writeAtomically(absPath: string, bytes: Buffer): Promise<void> {
  const tmp = `${absPath}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, bytes);
  await fsp.rename(tmp, absPath);
}

export async function readSeenScreenshot(
  watcher: ScreenshotWatcher,
  path: string,
): Promise<{ dataBase64: string; mime: string; sizeBytes: number }> {
  mustBeSeen(watcher, path);
  const mime = imageMimeForPath(path);
  if (!mime) {
    throw new ProductFailure(
      productError('SCREENSHOT_UNSUPPORTED', {
        userMessage: 'This is not a supported screenshot format.',
      }),
    );
  }
  const stat = await fsp.stat(path).catch(() => {
    throw new ProductFailure(
      productError('SCREENSHOT_MISSING', {
        userMessage: 'The screenshot file was moved or deleted.',
      }),
    );
  });
  if (stat.size > MAX_SCREENSHOT_BYTES) {
    throw new ProductFailure(
      productError('SCREENSHOT_TOO_LARGE', {
        userMessage: `The screenshot is too large to open (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit 20 MB).`,
      }),
    );
  }
  const bytes = await fsp.readFile(path);
  return { dataBase64: bytes.toString('base64'), mime, sizeBytes: stat.size };
}

export async function saveScreenshotToAssets(
  watcher: ScreenshotWatcher,
  workspaceRoot: string,
  source: { kind: 'path'; path: string } | { kind: 'bytes'; dataBase64: string; name: string },
): Promise<{ relPath: string; name: string }> {
  let bytes: Buffer;
  let target: { absPath: string; relPath: string; name: string };
  if (source.kind === 'path') {
    mustBeSeen(watcher, source.path);
    if (!imageMimeForPath(source.path)) {
      throw new ProductFailure(
        productError('SCREENSHOT_UNSUPPORTED', {
          userMessage: 'This is not a supported screenshot format.',
        }),
      );
    }
    bytes = await fsp.readFile(source.path).catch(() => {
      throw new ProductFailure(
        productError('SCREENSHOT_MISSING', {
          userMessage: 'The screenshot file was moved or deleted.',
        }),
      );
    });
    target = await pickAssetTarget(workspaceRoot, basename(source.path), null);
  } else {
    bytes = Buffer.from(source.dataBase64, 'base64');
    // PNG magic guard: bytes sources only ever carry what a canvas exported.
    if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) {
      throw new ProductFailure(
        productError('SCREENSHOT_BAD_PAYLOAD', {
          userMessage: 'The annotated payload is not a PNG.',
        }),
      );
    }
    target = await pickAssetTarget(workspaceRoot, source.name, '.png');
  }
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    throw new ProductFailure(
      productError('SCREENSHOT_TOO_LARGE', {
        userMessage: 'Screenshots saved to assets are limited to 20 MB.',
      }),
    );
  }
  await writeAtomically(target.absPath, bytes);
  return { relPath: target.relPath, name: target.name };
}

export function registerScreenshotHandlers(
  watcher: ScreenshotWatcher,
  workspace: WorkspaceHost,
  logger: Logger,
): void {
  registerHandlers(
    {
      'screenshot.recent': async () => ({ captures: watcher.recent() }),
      'screenshot.read': async ({ path }) => readSeenScreenshot(watcher, path),
      'screenshot.saveToAssets': async ({ source }) => {
        const ws = workspace.mustActive();
        const saved = await saveScreenshotToAssets(watcher, ws.canonicalPath, source);
        logger.info('screenshot saved to assets', { relPath: saved.relPath });
        return saved;
      },
    },
    logger,
  );
}
