import type { SessionEntry } from './rail-groups.js';

const LIVE_MISSION_ASSIGNMENT_STATES = new Set(['ACTIVE', 'WAITING', 'PAUSED']);
const RUNNING_TASK_STATES = new Set([
  'EXPLORING',
  'PLANNING',
  'IN_PROGRESS',
  'AWAITING_USER',
  'AWAITING_PERMISSION',
  'VERIFYING',
]);

export type RunningSessionTarget =
  | { key: string; kind: 'task'; taskId: string }
  | { key: string; kind: 'external'; taskId: string }
  | { key: string; kind: 'terminal'; terminalId: string }
  | { key: string; kind: 'mission'; missionId: string; assignmentId: string };

/** One authoritative stop target per live Sessions-rail row. */
export function runningSessionTargets(
  entries: readonly SessionEntry[],
  externalSessions: Readonly<Record<string, { status: 'active' | 'ended' }>>,
): RunningSessionTarget[] {
  const targets: RunningSessionTarget[] = [];
  const seen = new Set<string>();
  const add = (target: RunningSessionTarget): void => {
    if (seen.has(target.key)) return;
    seen.add(target.key);
    targets.push(target);
  };

  for (const entry of entries) {
    if (entry.mission && LIVE_MISSION_ASSIGNMENT_STATES.has(entry.mission.assignmentState)) {
      add({
        key: `mission:${entry.mission.missionId}:${entry.mission.assignmentId}`,
        kind: 'mission',
        missionId: entry.mission.missionId,
        assignmentId: entry.mission.assignmentId,
      });
      continue;
    }
    if (entry.kind === 'mission') continue;
    if (entry.kind === 'terminal') {
      if (!entry.exited) {
        add({
          key: `terminal:${entry.terminalId}`,
          kind: 'terminal',
          terminalId: entry.terminalId,
        });
      }
      continue;
    }
    if (entry.task.external) {
      // Main-process reattach and renderer hydration arrive on different
      // queues. Never let an older renderer `ended` snapshot hide a durable
      // task that the host still reports as active: Stop all must prefer the
      // union so an idempotent extra stop is possible, never a false negative.
      const rendererActive = externalSessions[entry.task.id]?.status === 'active';
      if (rendererActive || entry.task.external.status === 'active') {
        add({ key: `external:${entry.task.id}`, kind: 'external', taskId: entry.task.id });
      }
    } else if (RUNNING_TASK_STATES.has(entry.task.state)) {
      add({ key: `task:${entry.task.id}`, kind: 'task', taskId: entry.task.id });
    }
  }
  return targets;
}
