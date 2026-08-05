import type { MissionSnapshotDto, TaskDto } from '@pi-ide/ipc-contracts';
import { TERMINAL_MISSION_STATES } from './mission/mission-view-model.js';

/**
 * Terminal Missions own their child runtime Sessions. Those children remain
 * resident for follow-up until explicitly closed, but they are no longer
 * top-level user Sessions and must not inflate Project/Session counts.
 *
 * Keep the originating conversation: it existed before Mission promotion and
 * remains an independently managed Session after the Mission settles.
 */
export function terminalMissionOwnedTaskIds(
  snapshots: readonly MissionSnapshotDto[],
  tasks: readonly TaskDto[],
): ReadonlySet<string> {
  const taskIdByTerminal = new Map<string, string>();
  for (const task of tasks) {
    const terminalId = task.external?.terminalId;
    if (terminalId) taskIdByTerminal.set(terminalId, task.id);
  }

  const owned = new Set<string>();
  for (const snapshot of snapshots) {
    if (!snapshot.mission.deletedAt && !TERMINAL_MISSION_STATES.has(snapshot.mission.state)) {
      continue;
    }
    const originTaskId = snapshot.mission.originConversationTaskId;
    for (const assignment of snapshot.assignments) {
      if (assignment.id === snapshot.mission.leadAssignmentId && originTaskId) continue;
      const attempt = snapshot.attempts.find(
        (candidate) => candidate.id === assignment.activeAttemptId,
      );
      const runtimeSessionId = attempt?.runtimeSessionId ?? null;
      if (runtimeSessionId?.startsWith('managed-task:')) {
        owned.add(runtimeSessionId.slice('managed-task:'.length));
        continue;
      }
      const terminalId =
        attempt?.terminalId ??
        (runtimeSessionId?.startsWith('terminal:')
          ? runtimeSessionId.slice('terminal:'.length)
          : null);
      const taskId = terminalId ? taskIdByTerminal.get(terminalId) : null;
      if (taskId) owned.add(taskId);
    }
  }
  return owned;
}

export function visibleProjectSessionTasks(
  tasks: readonly TaskDto[],
  snapshots: readonly MissionSnapshotDto[],
): TaskDto[] {
  const missionOwned = terminalMissionOwnedTaskIds(snapshots, tasks);
  return tasks.filter((task) => !missionOwned.has(task.id));
}
