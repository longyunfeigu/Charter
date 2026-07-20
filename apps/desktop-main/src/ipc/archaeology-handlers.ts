import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { MAX_DISCOVERED_SESSIONS } from '@pi-ide/ipc-contracts';
import { registerHandlers } from './router.js';
import type { SessionArchaeologyService } from '../services/session-archaeology.js';
import type { ExternalSessionService } from '../services/external-session-service.js';

/**
 * ADR-0038: session archaeology. `scan` is a read-only sweep over the CLI
 * agents' own transcript stores; `adopt` turns one discovered conversation
 * into a regular external task. Everything the renderer names is re-resolved
 * host-side from the discovery cache — no raw paths cross the bridge.
 */
export function registerArchaeologyHandlers(
  archaeology: SessionArchaeologyService,
  sessions: ExternalSessionService,
  logger: Logger,
): void {
  registerHandlers(
    {
      'archaeology.scan': async () => ({
        sessions: (await archaeology.scan()).slice(0, MAX_DISCOVERED_SESSIONS),
        scannedAt: new Date().toISOString(),
        enabled: archaeology.enabled,
      }),
      'archaeology.adopt': async ({ cli, sessionId, terminalId }) => {
        const found = await archaeology.lookup(cli, sessionId);
        if (!found) {
          throw new ProductFailure(
            productError('ARCHAEOLOGY_SESSION_UNKNOWN', {
              userMessage: 'That discovered session is no longer on disk. Rescan and try again.',
            }),
          );
        }
        if (found.trackedTaskId) {
          throw new ProductFailure(
            productError('ARCHAEOLOGY_SESSION_TRACKED', {
              userMessage: 'Charter already tracks this conversation — open its Session instead.',
            }),
          );
        }
        // Adopting an unattributed directory registers it as a project (the
        // task service creates the workspace row on first sight).
        return sessions.adopt(
          {
            cli: found.cli,
            sessionId: found.sessionId,
            cwd: found.cwd,
            projectPath: found.projectPath ?? found.cwd,
            title: found.title,
          },
          terminalId,
        );
      },
    },
    logger,
  );
}
