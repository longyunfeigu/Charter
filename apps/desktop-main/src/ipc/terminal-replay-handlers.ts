import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { app, dialog, shell } from 'electron';
import type { Logger } from '@pi-ide/foundation';
import type { TerminalReplayService } from '../services/terminal-replay-service.js';
import { registerHandlers } from './router.js';

type ExportFormat = 'mp4' | 'gif' | 'webm';

function safeExportTitle(value: string): string {
  return (
    value
      .replace(/[/\\:]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Terminal Replay'
  );
}

function findFfmpeg(): string | null {
  for (const candidate of [
    process.env.CHARTER_FFMPEG,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function withExtension(path: string, extension: string): string {
  return extname(path) ? path.slice(0, -extname(path).length) + extension : path + extension;
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const extension = extname(path);
  const stem = extension ? path.slice(0, -extension.length) : path;
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${extension}`;
}

function runFfmpeg(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: 180_000 }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      reject(new Error((stderr || error.message).slice(0, 500)));
    });
  });
}

export function registerTerminalReplayHandlers(
  replay: TerminalReplayService,
  logger: Logger,
): void {
  registerHandlers(
    {
      'task.terminalReplaySession': async ({ taskId }) => replay.session(taskId),
      'task.terminalReplayEvents': async ({ taskId, segmentId, cursor, limit }) =>
        replay.events(taskId, { segmentId, cursor, limit }),
      'task.terminalReplayAnalysis': async ({ taskId }) => replay.analysis(taskId),
      'task.terminalReplayExport': async ({ taskId, title, format, bytes }) => {
        // The task lookup is the ownership boundary: arbitrary renderer bytes
        // cannot use this handler as a generic file writer.
        const session = replay.session(taskId).session;
        if (!session.available) {
          return { saved: false, path: null, format: null, fallback: null };
        }
        const ffmpeg = findFfmpeg();
        const effectiveFormat: ExportFormat = format === 'webm' || ffmpeg ? format : 'webm';
        const fallback = effectiveFormat === format ? null : 'ffmpeg was not found; saved WebM.';
        const extension = `.${effectiveFormat}`;
        const chosen = await dialog.showSaveDialog({
          title: 'Export Terminal Replay',
          defaultPath: join(
            app.getPath('downloads'),
            `${safeExportTitle(title)}-${new Date().toISOString().slice(0, 10)}${extension}`,
          ),
          filters: [
            {
              name:
                effectiveFormat === 'mp4'
                  ? 'MP4 video'
                  : effectiveFormat === 'gif'
                    ? 'Animated GIF'
                    : 'WebM video',
              extensions: [effectiveFormat],
            },
          ],
        });
        if (chosen.canceled || !chosen.filePath) {
          return { saved: false, path: null, format: null, fallback: null };
        }
        let destination = withExtension(chosen.filePath, extension);
        const webm = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (effectiveFormat === 'webm') {
          writeFileSync(destination, webm, { mode: 0o600 });
          shell.showItemInFolder(destination);
          return { saved: true, path: destination, format: 'webm' as const, fallback };
        }

        const tempDir = mkdtempSync(join(tmpdir(), 'charter-replay-export-'));
        const temporaryWebm = join(tempDir, `${randomBytes(5).toString('hex')}.webm`);
        writeFileSync(temporaryWebm, webm, { mode: 0o600 });
        try {
          if (effectiveFormat === 'mp4') {
            await runFfmpeg(ffmpeg!, [
              '-y',
              '-i',
              temporaryWebm,
              '-vf',
              'scale=trunc(iw/2)*2:trunc(ih/2)*2',
              '-c:v',
              'libx264',
              '-pix_fmt',
              'yuv420p',
              '-movflags',
              '+faststart',
              destination,
            ]);
          } else {
            const palette = join(tempDir, 'palette.png');
            await runFfmpeg(ffmpeg!, [
              '-y',
              '-i',
              temporaryWebm,
              '-vf',
              'fps=15,scale=900:-1:flags=lanczos,palettegen=stats_mode=diff',
              palette,
            ]);
            await runFfmpeg(ffmpeg!, [
              '-y',
              '-i',
              temporaryWebm,
              '-i',
              palette,
              '-lavfi',
              'fps=15,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3',
              destination,
            ]);
          }
          shell.showItemInFolder(destination);
          logger.info('terminal replay exported', {
            taskId,
            format: effectiveFormat,
            file: basename(destination),
          });
          return { saved: true, path: destination, format: effectiveFormat, fallback };
        } catch (error) {
          destination = uniquePath(withExtension(destination, '.webm'));
          writeFileSync(destination, webm, { mode: 0o600 });
          shell.showItemInFolder(destination);
          logger.warn('terminal replay conversion failed; saved webm', {
            taskId,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            saved: true,
            path: destination,
            format: 'webm' as const,
            fallback: 'Conversion failed; saved WebM.',
          };
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      },
    },
    logger,
  );
}
