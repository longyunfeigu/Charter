import type { Logger } from '@pi-ide/foundation';
import { registerHandlers } from './router.js';
import type { AgentPresenceService } from '../services/agent-presence-service.js';

export function registerAgentPresenceHandlers(
  presence: AgentPresenceService,
  logger: Logger,
): void {
  registerHandlers(
    {
      'agentPresence.list': async () => ({ presences: presence.list() }),
      'agentPresence.get': async ({ terminalId }) => ({
        presence: presence.get(terminalId),
      }),
      'agentPresence.explain': async ({ terminalId }) => ({
        explain: await presence.explain(terminalId),
      }),
      'agentPresence.markSeen': async ({ terminalId, surface }) => ({
        presence: presence.markSeen(terminalId, surface),
      }),
    },
    logger,
  );
}
