import type { Logger } from '@pi-ide/foundation';
import type { VerificationRunDto } from '@pi-ide/ipc-contracts';
import { registerHandlers } from './router.js';
import type { TaskService } from '../services/task-service.js';

/** M9: verification runs, rollback and unverified-accept confirmation (VER, CHG-009/010). */
export function registerM9Handlers(tasks: TaskService, logger: Logger): void {
  registerHandlers(
    {
      'task.rollback': async ({ taskId, force }) => {
        const result = await tasks.rollbackTask(taskId, { force });
        if (result.status === 'conflicts') {
          return { status: 'conflicts' as const, task: result.task, conflicts: result.conflicts };
        }
        return { status: 'ok' as const, task: result.task, restored: result.restored };
      },
      // ADR-0032 (P2): unwind exactly one turn, newest settled first.
      'task.rollbackTurn': async ({ taskId, runId, force }) => {
        const result = await tasks.rollbackTurn(taskId, runId, { force });
        if (result.status === 'conflicts') {
          return { status: 'conflicts' as const, task: result.task, conflicts: result.conflicts };
        }
        return { status: 'ok' as const, task: result.task, restored: result.restored };
      },
      'task.runVerification': async ({ taskId, label }) => {
        const runs = await tasks.runVerifications(taskId, {
          ...(label !== undefined ? { label } : {}),
          initiator: 'user',
        });
        return {
          configured: runs !== null,
          runs: (runs === null ? [] : tasks.verificationRuns(taskId)) as VerificationRunDto[],
        };
      },
      'task.verificationRuns': async ({ taskId }) => ({
        runs: tasks.verificationRuns(taskId) as VerificationRunDto[],
      }),
      'task.suggestVerifications': async () => ({
        suggestions: await tasks.suggestVerifications(),
      }),
      'task.suggestWorktreeSetup': async () => ({
        command: await tasks.suggestWorktreeSetup(),
      }),
      'task.agentFileMarks': async () => ({ marks: tasks.agentFileMarks() }),
    },
    logger,
  );
}
