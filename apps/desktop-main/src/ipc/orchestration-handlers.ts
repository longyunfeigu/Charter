import type { Logger } from '@pi-ide/foundation';
import type { TerminalControlService } from '../services/terminal-control-service.js';
import type { MissionOrchestrationService } from '../services/mission-orchestration-service.js';
import type { TaskService } from '../services/task-service.js';
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

export function registerMissionHandlers(
  missions: MissionOrchestrationService,
  tasks: TaskService,
  logger: Logger,
): void {
  const userCaller = (missionId: string) => {
    const snapshot = missions.repository.snapshot(missionId);
    const assignmentId = snapshot.mission.leadAssignmentId ?? snapshot.assignments[0]?.id ?? null;
    return {
      principalId: 'user',
      runtimeSessionId: 'user:renderer',
      missionId,
      assignmentId,
      attemptId: null,
      origin: 'user' as const,
    };
  };
  registerHandlers(
    {
      'mission.forConversation': async ({ taskId }) => {
        const mission = missions.repository.getMissionForOriginTask(taskId);
        return { snapshot: mission ? missions.repository.snapshot(mission.id) : null };
      },
      'mission.listActive': async () => ({
        missions: missions.repository
          .listRecoverableMissions()
          .map((mission) => missions.repository.snapshot(mission.id)),
      }),
      'mission.list': async ({ limit }) => ({
        missions: missions.repository
          .listMissions(limit)
          // The rail needs lifecycle and recent activity, not every historical
          // runtime chunk. Detailed/live snapshots continue to use the normal
          // bounded snapshot size.
          .map((mission) => missions.repository.snapshot(mission.id, 50, 10)),
      }),
      'mission.listDeleted': async ({ limit }) => ({
        missions: missions.repository
          .listDeletedMissions(limit)
          .map((mission) => missions.repository.snapshot(mission.id, 50, 10)),
      }),
      'mission.trash': async ({ missionId }) => {
        missions.repository.trashMission(missionId);
        return missions.repository.snapshot(missionId, 50, 10);
      },
      'mission.restore': async ({ missionId }) => {
        missions.repository.restoreMission(missionId);
        return missions.repository.snapshot(missionId, 50, 10);
      },
      'mission.deletePermanently': async ({ missionId }) => {
        missions.repository.deleteMissionPermanently(missionId);
        return { deleted: true as const };
      },
      'mission.deleteSessionTree': async ({ missionId }) => {
        const snapshot = missions.repository.snapshot(missionId);
        const taskIds = new Set<string>();
        if (snapshot.mission.originConversationTaskId) {
          taskIds.add(snapshot.mission.originConversationTaskId);
        }
        for (const attempt of snapshot.attempts) {
          if (attempt.runtimeSessionId?.startsWith('managed-task:')) {
            taskIds.add(attempt.runtimeSessionId.slice('managed-task:'.length));
          }
          if (attempt.terminalId) {
            const tracked = tasks.externalTaskForTerminal(attempt.terminalId);
            if (tracked) taskIds.add(tracked.id);
          }
        }

        // Validate the whole aggregate before closing or deleting any part of
        // it. A child with unmerged isolated work blocks the parent deletion.
        const existingTaskIds: string[] = [];
        for (const taskId of taskIds) {
          try {
            tasks.getTask(taskId);
          } catch {
            // Stale runtimes can outlive an already-removed Task record.
            continue;
          }
          await tasks.assertTaskDeletionSafe(taskId, true);
          existingTaskIds.push(taskId);
        }

        await missions.deleteSessionTree(missionId);
        for (const taskId of existingTaskIds) await tasks.deleteTask(taskId, true);
        return {
          // Deleting an origin Task clears the Mission's SET NULL reference.
          // Return that final snapshot so Recently Deleted never claims the
          // original Session was preserved by this tree-level operation.
          mission: missions.repository.snapshot(missionId),
          removedSessions: Math.max(1, snapshot.assignments.length),
        };
      },
      'mission.pauseAssignment': async ({ missionId, assignmentId, paused }) => {
        missions.pause(userCaller(missionId), assignmentId, paused);
        return missions.repository.snapshot(missionId);
      },
      'mission.steerAssignment': async ({ missionId, assignmentId, text }) => {
        await missions.steer(userCaller(missionId), assignmentId, text);
        return missions.repository.snapshot(missionId);
      },
      'mission.replyMessage': async ({ missionId, messageId, body }) => {
        missions.reply(userCaller(missionId), { messageId, body });
        return missions.repository.snapshot(missionId);
      },
      'mission.resolveActionRequest': async ({
        missionId,
        requestId,
        outcome,
        body,
        payload,
        rationale,
        idempotencyKey,
      }) => {
        missions.resolveRequest(userCaller(missionId), {
          requestId,
          outcome,
          ...(body !== undefined ? { body } : {}),
          ...(payload !== undefined ? { payload } : {}),
          ...(rationale !== undefined ? { rationale } : {}),
          idempotencyKey,
        });
        return missions.repository.snapshot(missionId);
      },
      'mission.closeRuntime': async ({ missionId, assignmentId, reason }) => {
        await missions.closeRuntime(userCaller(missionId), assignmentId, reason);
        return missions.repository.snapshot(missionId);
      },
      'mission.promoteLead': async ({ missionId, assignmentId, reason }) =>
        missions.promoteLead(userCaller(missionId), assignmentId, reason),
      'mission.cancelAssignment': async ({ missionId, assignmentId, reason }) => {
        missions.cancel(userCaller(missionId), assignmentId, reason);
        return missions.repository.snapshot(missionId);
      },
      'mission.retryAssignment': async ({ missionId, assignmentId, requestedRuntime }) => {
        missions.retry(userCaller(missionId), assignmentId, requestedRuntime);
        return missions.repository.snapshot(missionId);
      },
      'mission.reassignAssignment': async ({
        missionId,
        assignmentId,
        assignee,
        requestedRuntime,
        requestedModel,
        reason,
      }) => {
        missions.reassign(userCaller(missionId), {
          assignmentId,
          assignee,
          ...(requestedRuntime ? { requestedRuntime } : {}),
          ...(requestedModel !== undefined ? { requestedModel } : {}),
          reason,
        });
        return missions.repository.snapshot(missionId);
      },
      'mission.finish': async ({ missionId, outcome, reason }) => {
        missions.finishMission(userCaller(missionId), missionId, outcome, reason);
        return missions.repository.snapshot(missionId);
      },
      'mission.requestRevision': async ({ missionId, feedback, idempotencyKey }) => {
        missions.requestRevision(userCaller(missionId), missionId, feedback, idempotencyKey);
        return missions.repository.snapshot(missionId);
      },
    },
    logger,
  );
}
