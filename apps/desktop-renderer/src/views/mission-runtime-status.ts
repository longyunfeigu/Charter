import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';

export type MissionRuntimeStatus = 'active' | 'succeeded' | 'failed' | 'stopped';

const FAILED_ATTEMPTS = new Set(['FAILED', 'TIMED_OUT']);
const STOPPED_ATTEMPTS = new Set(['CANCELLED', 'STALE']);

function runtimeStatus(
  snapshot: MissionSnapshotDto,
  assignment: MissionSnapshotDto['assignments'][number],
): { terminalId: string; status: MissionRuntimeStatus } | null {
  const attempt = snapshot.attempts.find((item) => item.id === assignment.activeAttemptId);
  if (!attempt?.terminalId) return null;
  if (attempt.state === 'SUCCEEDED' || assignment.state === 'COMPLETED') {
    return { terminalId: attempt.terminalId, status: 'succeeded' };
  }
  if (FAILED_ATTEMPTS.has(attempt.state) || assignment.state === 'FAILED') {
    return { terminalId: attempt.terminalId, status: 'failed' };
  }
  if (
    STOPPED_ATTEMPTS.has(attempt.state) ||
    assignment.state === 'CANCELLED' ||
    assignment.state === 'ORPHANED'
  ) {
    return { terminalId: attempt.terminalId, status: 'stopped' };
  }
  return { terminalId: attempt.terminalId, status: 'active' };
}

/**
 * Mission lifecycle is the authoritative work state for Mission-owned PTYs.
 * A completed Assignment may intentionally keep its CLI process resident for
 * follow-up, so terminal presence/busy heuristics must not keep animating it.
 */
export function missionRuntimeStatusByTerminal(
  snapshots: Iterable<MissionSnapshotDto>,
): ReadonlyMap<string, MissionRuntimeStatus> {
  const statuses = new Map<string, MissionRuntimeStatus>();
  const ordered = [...snapshots].sort((left, right) =>
    left.mission.updatedAt.localeCompare(right.mission.updatedAt),
  );
  for (const snapshot of ordered) {
    for (const assignment of snapshot.assignments) {
      const projected = runtimeStatus(snapshot, assignment);
      if (projected) statuses.set(projected.terminalId, projected.status);
    }
  }
  return statuses;
}

export function missionAwareWorking(
  presenceWorking: boolean,
  missionRuntimeStatus: MissionRuntimeStatus | null,
): boolean {
  return presenceWorking && (missionRuntimeStatus === null || missionRuntimeStatus === 'active');
}
