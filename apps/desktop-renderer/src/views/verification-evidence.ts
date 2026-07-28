import { useEffect, useMemo, useState } from 'react';
import type { TimelineEventDto, VerificationRunDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';

export function isCurrentVerificationPass(run: {
  state: string;
  stale: boolean;
  superseded: boolean;
}): boolean {
  return run.state === 'passed' && !run.stale && !run.superseded;
}

export function currentVerificationRuns(runs: VerificationRunDto[]): VerificationRunDto[] {
  const byLabel = new Map<string, VerificationRunDto>();
  for (const run of runs) {
    if (!run.superseded) byLabel.set(run.label, run);
  }
  return [...byLabel.values()];
}

export function latestFinalReport(timeline: TimelineEventDto[]): Record<string, unknown> | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index]!;
    if (event.type === 'report.final') return event.payload as Record<string, unknown>;
  }
  return null;
}

export function reportExecutionFailed(report: Record<string, unknown> | null): boolean {
  return report?.outcome === 'failed';
}

/** Current verification truth comes from the durable store, not old timeline payloads. */
export function useVerificationEvidence(
  taskId: string | null,
  taskUpdatedAt: string | null,
  timeline: TimelineEventDto[],
): VerificationRunDto[] {
  const refreshKey = useMemo(
    () =>
      timeline
        .filter((event) =>
          [
            'verification.completed',
            'task.rolledBack',
            'turn.rolledBack',
            'run.completed',
          ].includes(event.type),
        )
        .map((event) => event.id)
        .join('|'),
    [timeline],
  );
  const [runs, setRuns] = useState<VerificationRunDto[]>([]);

  useEffect(() => {
    let cancelled = false;
    setRuns([]);
    if (!taskId) return () => undefined;
    void rpcResult('task.verificationRuns', { taskId }).then((result) => {
      if (!cancelled && result.ok) setRuns(currentVerificationRuns(result.data.runs));
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, taskUpdatedAt, refreshKey]);

  return runs;
}
