import type { Logger } from '@pi-ide/foundation';
import { registerHandlers } from './router.js';
import type { ExternalSessionService } from '../services/external-session-service.js';
import type { ArtifactService } from '../services/artifact-service.js';

/** ADR-0017: external CLI agent session channels. */
export function registerExternalHandlers(
  sessions: ExternalSessionService,
  logger: Logger,
  artifacts?: ArtifactService,
): void {
  registerHandlers(
    {
      'external.listSessions': async () => ({ sessions: sessions.list() }),
      'external.endSession': async ({ taskId }) => sessions.end(taskId),
      'external.resumeSession': async ({ taskId, terminalId }) =>
        sessions.resume(taskId, terminalId),
      'external.injectContext': async ({ taskId, ref }) => {
        if (ref.kind !== 'artifact' || !artifacts) return sessions.injectContext(taskId, ref);
        const [artifact] = await artifacts.validateFeedbackRefs([ref.artifact]);
        return sessions.injectContext(taskId, { kind: 'artifact', artifact: artifact! });
      },
    },
    logger,
  );
}
