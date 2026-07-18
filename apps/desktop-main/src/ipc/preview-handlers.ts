import { nativeImage, shell, webContents, type WebContents, type WebFrameMain } from 'electron';
import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { PreviewAttachmentDto } from '@pi-ide/ipc-contracts';
import { registerHandlers } from './router.js';
import { broadcast } from '../broadcast.js';
import type { PreviewFeedbackMeta, TaskService } from '../services/task-service.js';
import { devCommandForRoot, isWebishRoot, PreviewService } from '../services/preview-service.js';
import { PICKER_CANCEL_JS, PICKER_JS, isLoopbackPreviewUrl } from '../services/preview-picker.js';

const THUMB_WIDTH = 320;
const PNG_MAGIC = 0x89504e47;

/** Loopback preview frame lookup: the ONLY frames the picker may enter. */
function loopbackFrame(wc: WebContents, port: number): WebFrameMain | null {
  for (const frame of wc.mainFrame.framesInSubtree) {
    if (isLoopbackPreviewUrl(frame.url, port)) return frame;
  }
  return null;
}

/** The cross-origin preview iframe becomes an out-of-process frame that may not
 * be committed the instant the renderer sets src — poll briefly before giving
 * up (the renderer then falls back to the zero-injection marquee). */
async function waitForLoopbackFrame(
  wc: WebContents,
  port: number,
  attempts = 8,
): Promise<WebFrameMain | null> {
  for (let i = 0; i < attempts; i += 1) {
    const frame = loopbackFrame(wc, port);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

/** Loopback console relay (ADR-0022 am.2): zero-injection — the window's own
 * console-message event covers every frame; we filter by source origin and
 * broadcast. The renderer's policy decides what (if anything) reaches the
 * agent. Attached once per webContents, lazily on first previewPorts call. */
const consoleRelayAttached = new Set<number>();
function attachConsoleRelay(wc: WebContents, logger: Logger): void {
  if (consoleRelayAttached.has(wc.id)) return;
  consoleRelayAttached.add(wc.id);
  wc.on('destroyed', () => consoleRelayAttached.delete(wc.id));
  const LEVELS = ['debug', 'info', 'warning', 'error'] as const;
  wc.on(
    'console-message',
    (
      event: { level?: unknown; message?: unknown; lineNumber?: unknown; sourceId?: unknown },
      legacyLevel?: number,
      legacyMessage?: string,
      legacyLine?: number,
      legacySourceId?: string,
    ) => {
      // Electron ships both shapes across versions — read whichever is present.
      const level =
        typeof legacyLevel === 'number'
          ? (LEVELS[legacyLevel] ?? 'info')
          : typeof event.level === 'string' && (LEVELS as readonly string[]).includes(event.level)
            ? (event.level as (typeof LEVELS)[number])
            : 'info';
      const message =
        typeof legacyMessage === 'string' ? legacyMessage : String(event.message ?? '');
      const line =
        typeof legacyLine === 'number'
          ? legacyLine
          : typeof event.lineNumber === 'number'
            ? event.lineNumber
            : null;
      const sourceId =
        typeof legacySourceId === 'string' ? legacySourceId : String(event.sourceId ?? '');
      try {
        const url = new URL(sourceId);
        if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return;
        const port = Number(url.port);
        if (!Number.isInteger(port) || port < 1) return;
        broadcast('preview.console', {
          port,
          level,
          message: message.slice(0, 2000),
          sourceId: sourceId.slice(0, 2000),
          line,
        });
      } catch {
        // non-URL sources (app's own logs) are not preview traffic
      }
    },
  );
  logger.info('preview console relay attached', { webContentsId: wc.id });
}

/**
 * Preview gate (ADR-0022): port detection scoped to the task's own tree, a
 * compositor screenshot channel for marquee feedback, loopback-only "open in
 * browser", and the stored PR draft. Detection is read-only; nothing here ever
 * starts a server or runs a git command.
 */

/** Decode + validate a marquee-feedback attachment, persist the PNG under the
 * task's attachment dir, and build the timeline meta (with an inline thumbnail
 * so the Room renders it without a new read channel). */
export async function processPreviewAttachment(
  tasks: TaskService,
  taskId: string,
  preview: PreviewAttachmentDto,
): Promise<{ meta: PreviewFeedbackMeta; imageData: string }> {
  const bytes = Buffer.from(preview.dataBase64, 'base64');
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== PNG_MAGIC) {
    throw new ProductFailure(
      productError('PREVIEW_BAD_PAYLOAD', {
        userMessage: 'The preview screenshot payload is not a PNG.',
      }),
    );
  }
  const pngPath = await tasks.savePreviewShot(taskId, bytes);
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  const thumb = size.width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH }) : image;
  return {
    meta: {
      pngPath,
      pageUrl: preview.pageUrl,
      rect: preview.rect,
      thumbDataUrl: thumb.toDataURL(),
      ...(preview.selector ? { selector: preview.selector } : {}),
      ...(preview.note ? { note: preview.note } : {}),
    },
    imageData: preview.dataBase64,
  };
}

export function registerPreviewHandlers(
  tasks: TaskService,
  preview: PreviewService,
  logger: Logger,
): void {
  registerHandlers(
    {
      'task.previewPorts': async ({ taskId }, meta) => {
        const task = tasks.getTask(taskId);
        // am.2: any surface polling ports wants console events too — attach the
        // relay to the calling window once.
        const sender = webContents.fromId(meta.senderId);
        if (sender) attachConsoleRelay(sender, logger);
        const root = task.worktree?.path ?? task.projectPath;
        const [ports, webish, devCommand] = await Promise.all([
          preview.detectPorts(root),
          isWebishRoot(root),
          devCommandForRoot(root),
        ]);
        return {
          root,
          webish,
          devCommand,
          ports: ports.map((p) => ({ ...p, url: `http://localhost:${p.port}/` })),
        };
      },
      'task.previewPick': async ({ taskId, port, action }, meta) => {
        tasks.getTask(taskId); // existence check
        const sender = webContents.fromId(meta.senderId);
        if (!sender) return { injected: false };
        // Cancel can use a plain lookup; start waits for the frame to commit.
        const frame =
          action === 'start'
            ? await waitForLoopbackFrame(sender, port)
            : loopbackFrame(sender, port);
        if (!frame) return { injected: false };
        try {
          await frame.executeJavaScript(action === 'start' ? PICKER_JS : PICKER_CANCEL_JS, true);
          return { injected: true };
        } catch (e) {
          logger.warn('preview picker injection failed', {
            taskId,
            port,
            error: errorMessage(e),
          });
          return { injected: false };
        }
      },
      'task.capturePreview': async ({ taskId, rect }, meta) => {
        tasks.getTask(taskId); // existence check — capture is task-scoped UI
        const contents = webContents.fromId(meta.senderId);
        if (!contents) {
          throw new ProductFailure(
            productError('PREVIEW_NO_SENDER', {
              userMessage: 'The requesting window no longer exists.',
            }),
          );
        }
        const image = await contents.capturePage({
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.min(8000, Math.max(1, Math.round(rect.width))),
          height: Math.min(8000, Math.max(1, Math.round(rect.height))),
        });
        const size = image.getSize();
        if (size.width === 0 || size.height === 0) {
          throw new ProductFailure(
            productError('PREVIEW_CAPTURE_EMPTY', {
              userMessage: 'Could not capture the preview region.',
              retryable: true,
            }),
          );
        }
        return {
          dataBase64: image.toPNG().toString('base64'),
          width: size.width,
          height: size.height,
        };
      },
      'task.previewOpenExternal': async ({ taskId, port, path }) => {
        const task = tasks.getTask(taskId);
        const root = task.worktree?.path ?? task.projectPath;
        // Loopback-only, and only a port currently attributed to this task's
        // tree — the general https allowlist (§12.3) is deliberately untouched.
        const ports = await preview.detectPorts(root);
        if (!ports.some((p) => p.port === port)) {
          throw new ProductFailure(
            productError('PREVIEW_PORT_UNKNOWN', {
              userMessage:
                'That port is not currently served from this task’s tree — refresh the preview and retry.',
              retryable: true,
            }),
          );
        }
        const cleanPath = path.startsWith('/') ? path : `/${path}`;
        if (cleanPath.includes('..') || /[\s\\]/.test(cleanPath) || cleanPath.startsWith('//')) {
          throw new ProductFailure(
            productError('PREVIEW_BAD_PATH', { userMessage: 'That preview path is not valid.' }),
          );
        }
        const url = `http://localhost:${port}${cleanPath}`;
        logger.info('preview open external', { taskId, url });
        await shell.openExternal(url);
        return { opened: true };
      },
      'task.prDraft': async ({ taskId }) => ({ draft: tasks.prDraftFor(taskId) }),
    },
    logger,
  );
}
