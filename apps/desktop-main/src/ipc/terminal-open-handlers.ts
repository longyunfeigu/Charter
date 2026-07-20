import { shell } from 'electron';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { resolveInsideRoot } from '@pi-ide/workspace-service';
import { registerHandlers } from './router.js';
import type { M4Services } from './m4-handlers.js';
import type { WorkspaceHost } from '../services/workspace-host.js';
import {
  cwdRelativeToken,
  terminalOpenAction,
  verifyTokens,
} from '../services/terminal-file-open.js';

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
        const rel = cwdRelativeToken(info.cwd, token);
        if (rel === null) {
          throw new ProductFailure(
            productError('TERMINAL_PATH_OUTSIDE', {
              userMessage: `That file is outside this terminal's project (${info.projectName}).`,
            }),
          );
        }
        // Same lexical + symlink containment as workspace paths (WS-010).
        const abs = await resolveInsideRoot(info.cwd, rel);
        let isFile = false;
        try {
          isFile = (await stat(abs)).isFile();
        } catch {
          throw new ProductFailure(
            productError('TERMINAL_PATH_NOT_FOUND', {
              userMessage: `No file named ${rel} in this terminal's project.`,
            }),
          );
        }
        if (!isFile) {
          throw new ProductFailure(
            productError('TERMINAL_PATH_NOT_FILE', {
              userMessage: `${rel} is a folder, not a file.`,
            }),
          );
        }
        if (terminalOpenAction(abs) === 'external') {
          if (!process.env.PI_IDE_E2E) await shell.openExternal(pathToFileURL(abs).toString());
          logger.info('terminal file opened externally', { id, path: abs });
          return { action: 'external' as const, path: abs, workspacePath: null };
        }
        const ws = host.current;
        let workspacePath: string | null = null;
        if (ws) {
          const wsRel = relative(ws.canonicalPath, abs);
          if (wsRel !== '' && !wsRel.startsWith('..') && !isAbsolute(wsRel)) {
            workspacePath = wsRel;
          }
        }
        return { action: 'editor' as const, path: abs, workspacePath };
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
        const existing = await verifyTokens(info.cwd, tokens, async (cwd, rel) => {
          const abs = await resolveInsideRoot(cwd, rel);
          return (await stat(abs)).isFile();
        });
        return { existing };
      },
    },
    logger,
  );
}
