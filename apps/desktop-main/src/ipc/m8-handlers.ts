import type { Logger } from '@pi-ide/foundation';
import { registerHandlers } from './router.js';
import type { TaskService } from '../services/task-service.js';

/** M8: plan approval, review change set, per-file/hunk decisions, accept (§13.2, CHG-005/007/008). */
export function registerM8Handlers(tasks: TaskService, logger: Logger): void {
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
      'task.changeSet': async ({ taskId }) => ({
        changeSet: await tasks.changeSetForReview(taskId),
      }),
      'task.reviewFile': async ({ taskId, path }) => tasks.reviewFileContents(taskId, path),
      // ADR-0014: read-only in-room peek — current content via the task's mount.
      'task.peekFile': async ({ taskId, path }) => tasks.peekFile(taskId, path),
      'task.reviewDecision': async (payload) =>
        tasks.applyReviewDecision({
          taskId: payload.taskId,
          path: payload.path,
          scope: payload.scope,
          decision: payload.decision,
          ...(payload.hunkKey !== undefined ? { hunkKey: payload.hunkKey } : {}),
          ...(payload.expectedCurrentHash !== undefined
            ? { expectedCurrentHash: payload.expectedCurrentHash }
            : {}),
        }),
      'task.accept': async ({ taskId, confirmUnverified, confirmConflicts, runId }) => {
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
