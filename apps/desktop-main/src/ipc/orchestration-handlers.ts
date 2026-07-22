import type { Logger } from '@pi-ide/foundation';
import type { TerminalControlService } from '../services/terminal-control-service.js';
import { registerHandlers } from './router.js';

export function registerOrchestrationHandlers(
  control: TerminalControlService,
  logger: Logger,
): void {
  registerHandlers(
    {
      'orchestration.getState': async () => control.snapshot(),
      'orchestration.pauseWorker': async ({ terminalId, paused }) =>
        control.pauseWorker(terminalId, paused),
      'orchestration.pauseFleet': async ({ taskId, paused }) => control.pauseFleet(taskId, paused),
      'orchestration.handBack': async ({ terminalId }) => control.handBack(terminalId),
      'orchestration.directorCut': async ({ taskId, terminalId, reason }) =>
        control.directorCut(taskId, terminalId, reason),
    },
    logger,
  );
}
