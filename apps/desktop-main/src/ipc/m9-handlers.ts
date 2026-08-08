import type { Logger } from '@pi-ide/foundation';
import type { VerificationRunDto } from '@pi-ide/ipc-contracts';
import { registerHandlers } from './router.js';
import type { TaskService } from '../services/task-service.js';
import type { RemoteWorkerService } from '../services/remote-worker-service.js';

/** M9: verification runs, rollback and unverified-accept confirmation (VER, CHG-009/010). */
export function registerM9Handlers(
  tasks: TaskService,
  logger: Logger,
  remoteWorker: RemoteWorkerService | null = null,
): void {
  registerHandlers(
    {
      'task.rollback': async ({ taskId, force }) => {
        await remoteWorker?.syncTask(taskId);
        const managedRemote = Boolean(tasks.getTask(taskId).external?.remote);
        const result = await tasks.rollbackTask(taskId, {
          force,
          ...(managedRemote ? { deferSettlement: true } : {}),
        });
        if (result.status === 'conflicts') {
          return { status: 'conflicts' as const, task: result.task, conflicts: result.conflicts };
        }
        if (managedRemote) {
          try {
            await remoteWorker!.pushMirrorPaths(taskId, result.restored);
          } catch (error) {
            await remoteWorker!.syncTask(taskId).catch(() => undefined);
            throw error;
          }
          const task = await tasks.commitRemoteRollback(
            taskId,
            result.restored,
            result.conflictsOverridden,
          );
          return { status: 'ok' as const, task, restored: result.restored };
        }
        return { status: 'ok' as const, task: result.task, restored: result.restored };
      },
      // ADR-0032 (P2): unwind exactly one turn, newest settled first.
      'task.rollbackTurn': async ({ taskId, runId, force }) => {
        await remoteWorker?.syncTask(taskId);
        const managedRemote = Boolean(tasks.getTask(taskId).external?.remote);
        const result = await tasks.rollbackTurn(taskId, runId, {
          force,
          ...(managedRemote ? { deferSettlement: true } : {}),
        });
        if (result.status === 'conflicts') {
          return { status: 'conflicts' as const, task: result.task, conflicts: result.conflicts };
        }
        if (managedRemote) {
          if (result.restored.length > 0) {
            try {
              await remoteWorker!.pushMirrorPaths(taskId, result.restored);
            } catch (error) {
              await remoteWorker!.syncTask(taskId).catch(() => undefined);
              throw error;
            }
          }
          const task = await tasks.commitRemoteRollback(
            taskId,
            result.restored,
            result.conflictsOverridden,
            runId,
          );
          return { status: 'ok' as const, task, restored: result.restored };
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
