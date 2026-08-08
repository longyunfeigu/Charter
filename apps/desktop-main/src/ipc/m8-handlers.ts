import type { Logger } from '@pi-ide/foundation';
import { registerHandlers } from './router.js';
import type { TaskService } from '../services/task-service.js';
import type { RemoteWorkerService } from '../services/remote-worker-service.js';

/** M8: plan approval, review change set, per-file/hunk decisions, accept (§13.2, CHG-005/007/008). */
export function registerM8Handlers(
  tasks: TaskService,
  logger: Logger,
  remoteWorker: RemoteWorkerService | null = null,
): void {
  registerHandlers(
    {
      'task.planDecision': async (payload) => ({
        task: tasks.decidePlan({
          taskId: payload.taskId,
          decision: payload.decision,
          ...(payload.editedPlan !== undefined ? { editedPlan: payload.editedPlan } : {}),
          ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
          codeRefs: payload.codeRefs,
          confirmRemovedDone: payload.confirmRemovedDone,
        }),
      }),
      'task.changeSet': async ({ taskId }) => {
        await remoteWorker?.syncTask(taskId);
        return { changeSet: await tasks.changeSetForReview(taskId) };
      },
      'task.reviewFile': async ({ taskId, path }) => {
        await remoteWorker?.syncTask(taskId);
        return tasks.reviewFileContents(taskId, path);
      },
      // ADR-0014: read-only in-room peek — current content via the task's mount.
      'task.peekFile': async ({ taskId, path }) => {
        await remoteWorker?.syncTask(taskId);
        return tasks.peekFile(taskId, path);
      },
      'task.reviewDecision': async (payload) => {
        await remoteWorker?.syncTask(payload.taskId);
        const managedRemote = Boolean(tasks.getTask(payload.taskId).external?.remote);
        const deferredRemoteReject = managedRemote && payload.decision === 'reject';
        const result = await tasks.applyReviewDecision({
          taskId: payload.taskId,
          path: payload.path,
          scope: payload.scope,
          decision: payload.decision,
          ...(payload.hunkKey !== undefined ? { hunkKey: payload.hunkKey } : {}),
          ...(payload.expectedCurrentHash !== undefined
            ? { expectedCurrentHash: payload.expectedCurrentHash }
            : {}),
          ...(deferredRemoteReject ? { deferRecord: true } : {}),
        });
        if (deferredRemoteReject && result.status === 'applied') {
          try {
            await remoteWorker!.pushMirrorPaths(payload.taskId, [payload.path]);
          } catch (error) {
            // The local mirror mutation is provisional. Restore authoritative
            // remote bytes and leave the decision pending when a remote race
            // defeats the Worker's expected-hash guard.
            await remoteWorker!.syncTask(payload.taskId).catch(() => undefined);
            throw error;
          }
          tasks.commitReviewDecision(payload);
          return {
            status: 'applied' as const,
            changeSet: await tasks.changeSetForReview(payload.taskId),
          };
        }
        return result;
      },
      'task.accept': async ({ taskId, confirmUnverified, confirmConflicts, runId }) => {
        await remoteWorker?.syncTask(taskId);
        const result = await tasks.acceptTask(taskId, {
          confirmUnverified,
          confirmConflicts,
          // ADR-0032: settle only this turn when the rail turn list asks to.
          ...(runId ? { runId } : {}),
        });
        return {
          task: result.task,
          status: result.status,
          ...(result.conflicts ? { conflicts: result.conflicts } : {}),
          // ADR-0022: evidence-ledger PR draft (null: non-git or answer-only).
          prDraft: result.prDraft ?? null,
        };
      },
    },
    logger,
  );
}
