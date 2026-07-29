import { shell } from 'electron';
import { constants as fsConstants } from 'node:fs';
import { copyFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { resolveInsideRoot } from '@pi-ide/workspace-service';
import { registerHandlers } from './router.js';
import type { M4Services } from './m4-handlers.js';
import type { WorkspaceHost } from '../services/workspace-host.js';
import {
  classifyTerminalPathToken,
  terminalOpenAction,
  verifyTokens,
} from '../services/terminal-file-open.js';
import { readTerminalExternalPreview } from '../services/terminal-external-preview.js';

function workspaceRelativePath(root: string, absolutePath: string): string | null {
  const rel = relative(root, absolutePath);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : null;
}

async function requireRegularFile(path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) {
      throw new ProductFailure(
        productError('TERMINAL_PATH_NOT_FILE', {
          userMessage: `${basename(path)} is a folder, not a file.`,
        }),
      );
    }
  } catch (error) {
    if (error instanceof ProductFailure) throw error;
    throw new ProductFailure(
      productError('TERMINAL_PATH_NOT_FOUND', {
        userMessage: `That file no longer exists: ${path}`,
      }),
    );
  }
  return canonical;
}

function copyName(name: string, attempt: number): string {
  if (attempt === 0) return name;
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem} (${attempt})${extension}`;
}

async function copyIntoWorkspace(source: string, root: string): Promise<string> {
  const name = basename(source);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const relativePath = copyName(name, attempt);
    const destination = join(root, relativePath);
    try {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      return relativePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new ProductFailure(
    productError('TERMINAL_EXTERNAL_COPY_CONFLICT', {
      userMessage: `Could not find an available name for ${name} in this project.`,
    }),
  );
}

/**
 * ADR-0033: ⌘+click file opening from terminal output. Lives outside
 * m4-handlers.ts so that module stays electron-free for its unit tests; the
 * pure resolve/classify halves live in services/terminal-file-open.ts.
 */
export function registerTerminalOpenHandlers(
  services: M4Services,
  host: WorkspaceHost,
  logger: Logger,
): void {
  registerHandlers(
    {
      'terminal.openPath': async ({ id, path: token }) => {
        const info = services.terminals.list().find((item) => item.id === id);
        if (!info) {
          throw new ProductFailure(
            productError('TERMINAL_NOT_FOUND', {
              userMessage: 'That terminal session is no longer available.',
            }),
          );
        }
        if (info.remote) {
          throw new ProductFailure(
            productError('TERMINAL_REMOTE_FILE_UNAVAILABLE', {
              userMessage: 'Remote terminal file preview is not available yet.',
            }),
          );
        }
        const candidate = classifyTerminalPathToken(info.cwd, token);
        if (candidate === null) {
          throw new ProductFailure(
            productError('TERMINAL_PATH_NOT_FOUND', {
              userMessage: 'That terminal link does not identify a file.',
            }),
          );
        }
        const resolved =
          candidate.kind === 'absolute'
            ? candidate.path
            : await resolveInsideRoot(info.cwd, candidate.path);
        const abs = await requireRegularFile(resolved);
        const ws = host.current;
        const workspacePath = ws ? workspaceRelativePath(ws.canonicalPath, abs) : null;

        if (workspacePath && terminalOpenAction(abs) === 'external') {
          if (!process.env.PI_IDE_E2E) await shell.openExternal(pathToFileURL(abs).toString());
          logger.info('terminal file opened externally', { id, path: abs });
          return { action: 'external' as const, path: abs, workspacePath: null };
        }
        if (workspacePath) {
          return { action: 'editor' as const, path: abs, workspacePath };
        }

        let preview: Awaited<ReturnType<typeof readTerminalExternalPreview>>;
        try {
          preview = await readTerminalExternalPreview(abs);
        } catch {
          throw new ProductFailure(
            productError('TERMINAL_EXTERNAL_PREVIEW_FAILED', {
              userMessage: `Charter could not read ${basename(abs)} for preview.`,
            }),
          );
        }
        logger.info('terminal external file previewed', { id, path: abs, kind: preview.kind });
        return {
          action: 'preview' as const,
          path: abs,
          workspacePath: null,
          projectName: ws?.displayName || info.projectName || 'project',
          canCopy: Boolean(ws),
          preview,
        };
      },
      'terminal.externalFileAction': async ({ id, path, action }) => {
        const info = services.terminals.list().find((item) => item.id === id);
        if (!info) {
          throw new ProductFailure(
            productError('TERMINAL_NOT_FOUND', {
              userMessage: 'That terminal session is no longer available.',
            }),
          );
        }
        if (info.remote || !isAbsolute(path)) {
          throw new ProductFailure(
            productError('TERMINAL_EXTERNAL_FILE_INVALID', {
              userMessage: 'That external file action is not available.',
            }),
          );
        }
        const canonical = await requireRegularFile(path);
        if (action === 'system') {
          if (!process.env.PI_IDE_E2E) {
            const failure = await shell.openPath(canonical);
            if (failure) {
              throw new ProductFailure(
                productError('TERMINAL_EXTERNAL_OPEN_FAILED', {
                  userMessage: failure,
                }),
              );
            }
          }
          logger.info('terminal external file opened with system', { id, path: canonical });
          return { completed: true, path: canonical, workspacePath: null };
        }

        const ws = host.current;
        if (!ws) {
          throw new ProductFailure(
            productError('WORKSPACE_NOT_OPEN', {
              userMessage: 'Open a project before copying this file.',
            }),
          );
        }
        let workspacePath: string;
        try {
          workspacePath = await copyIntoWorkspace(canonical, ws.canonicalPath);
        } catch (error) {
          if (error instanceof ProductFailure) throw error;
          throw new ProductFailure(
            productError('TERMINAL_EXTERNAL_COPY_FAILED', {
              userMessage: `Charter could not copy ${basename(canonical)} into this project.`,
            }),
          );
        }
        const copiedPath = join(ws.canonicalPath, workspacePath);
        logger.info('terminal external file copied into workspace', {
          id,
          source: canonical,
          path: copiedPath,
        });
        return { completed: true, path: copiedPath, workspacePath };
      },
      // ADR-0033 am.1: read-only existence probe for path-boundary candidates
      // (paths with spaces/CJK where the regex cannot see the edges). Same cwd
      // containment as openPath; a bad candidate is `false`, never an error.
      'terminal.statTokens': async ({ id, tokens }) => {
        const info = services.terminals.list().find((item) => item.id === id);
        if (!info) {
          throw new ProductFailure(
            productError('TERMINAL_NOT_FOUND', {
              userMessage: 'That terminal session is no longer available.',
            }),
          );
        }
        if (info.remote) return { existing: tokens.map(() => false) };
        const existing = await verifyTokens(info.cwd, tokens, async (cwd, candidate) => {
          const abs =
            candidate.kind === 'absolute'
              ? candidate.path
              : await resolveInsideRoot(cwd, candidate.path);
          return (await stat(abs)).isFile();
        });
        return { existing };
      },
    },
    logger,
  );
}
