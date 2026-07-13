import { promises as fs } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { resolveInsideRoot } from '@pi-ide/workspace-service';
import { registerHandlers } from './router.js';
import type { WorkspaceHost } from '../services/workspace-host.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** Image preview + annotation persistence (PIVOT-020). Workspace-bounded. */
export function registerImageHandlers(workspace: WorkspaceHost, logger: Logger): void {
  registerHandlers(
    {
      'fs.readImage': async ({ path }) => {
        const ws = workspace.mustActive();
        const abs = await resolveInsideRoot(ws.canonicalPath, path);
        const mime = MIME[extname(path).toLowerCase()];
        if (!mime) {
          throw new ProductFailure(
            productError('IMG_UNSUPPORTED', { userMessage: 'This is not a supported image file.' }),
          );
        }
        const stat = await fs.stat(abs);
        if (stat.size > MAX_IMAGE_BYTES) {
          throw new ProductFailure(
            productError('IMG_TOO_LARGE', {
              userMessage: `The image is too large to preview (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit 20 MB).`,
            }),
          );
        }
        const bytes = await fs.readFile(abs);
        return { dataBase64: bytes.toString('base64'), mime, sizeBytes: stat.size };
      },
      'image.saveAnnotated': async ({ sourcePath, dataBase64 }) => {
        const ws = workspace.mustActive();
        await resolveInsideRoot(ws.canonicalPath, sourcePath); // source must be in-tree
        const dir = dirname(sourcePath);
        const stem = basename(sourcePath, extname(sourcePath));
        // Never overwrite anything: pick the first free .annotated[-n].png name.
        let candidate = join(dir, `${stem}.annotated.png`);
        for (let n = 2; n < 1000; n += 1) {
          const abs = await resolveInsideRoot(ws.canonicalPath, candidate);
          const exists = await fs.access(abs).then(
            () => true,
            () => false,
          );
          if (!exists) break;
          candidate = join(dir, `${stem}.annotated-${n}.png`);
        }
        const absTarget = await resolveInsideRoot(ws.canonicalPath, candidate);
        const bytes = Buffer.from(dataBase64, 'base64');
        // PNG magic guard: we only ever write what a canvas exported.
        if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) {
          throw new ProductFailure(
            productError('IMG_BAD_PAYLOAD', {
              userMessage: 'The annotation payload is not a PNG.',
            }),
          );
        }
        const tmp = `${absTarget}.tmp-${process.pid}`;
        await fs.writeFile(tmp, bytes);
        await fs.rename(tmp, absTarget);
        logger.info('annotated image saved', { path: candidate, bytes: bytes.length });
        return { path: candidate };
      },
    },
    logger,
  );
}
