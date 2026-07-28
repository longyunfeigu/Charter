import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { TaskDto, VerificationRunDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useTaskStore } from '../store/taskStore.js';
import { Ic } from './home-icons.js';

/**
 * Checks tab (ADR-0022): the existing verification records, gathered in the
 * gate. Presentation only — superseded runs stay visible (VER-005), stale runs
 * are marked (VER-008), and "nothing ran" is loud (VER-007).
 */

function stateIcon(run: VerificationRunDto): { glyph: string; cls: string } {
  if (run.stale || run.superseded) return { glyph: '!', cls: 'muted' };
  if (run.state === 'passed') return { glyph: '✓', cls: 'ok' };
  if (run.state === 'running') return { glyph: '…', cls: 'run' };
  if (run.state === 'cancelled') return { glyph: '∅', cls: 'muted' };
  return { glyph: '✗', cls: 'bad' };
}

function durationOf(run: VerificationRunDto): string {
  if (!run.startedAt || !run.endedAt) return '';
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function ReviewChecks({ task }: { task: TaskDto }): React.JSX.Element {
  const store = useTaskStore();
  const [runs, setRuns] = useState<VerificationRunDto[] | null>(null);
  const [running, setRunning] = useState(false);

  const refresh = useCallback(async () => {
    const res = await rpcResult('task.verificationRuns', { taskId: task.id });
    if (res.ok) setRuns(res.data.runs);
  }, [task.id]);

  useEffect(() => {
    void refresh();
  }, [refresh, task.updatedAt]);

  const grouped = useMemo(() => {
    const byLabel = new Map<string, VerificationRunDto[]>();
    for (const run of runs ?? []) {
      const list = byLabel.get(run.label) ?? [];
      list.push(run);
      byLabel.set(run.label, list);
    }
    return [...byLabel.entries()];
  }, [runs]);

  const runAll = async (): Promise<void> => {
    setRunning(true);
    try {
      await store.runVerification();
      await refresh();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="ck-pane" data-testid="checks-pane">
      <div className="ck-toolbar">
        <span className="ck-hint">
          Records keep their history: a re-run marks the old run <i>superseded</i>, code changes
          mark runs <i>stale</i> — nothing is overwritten.
        </span>
        <span className="pv-sp" />
        {task.verification.length > 0 ? (
          <button
            className="btn"
            data-testid="checks-run"
            disabled={running}
            onClick={() => void runAll()}
          >
            <Ic name="play" size={12} /> {running ? 'Running…' : 'Run verification'}
          </button>
        ) : null}
      </div>
      {runs === null ? (
        <div className="pv-note">Loading verification records…</div>
      ) : grouped.length === 0 ? (
        <div className="ck-unverified" data-testid="checks-unverified">
          <div className="ck-unverified-title">
            <Ic name="alert" size={14} /> Unverified
          </div>
          <div>
            No verification has run for this task.
            {task.verification.length === 0
              ? ' No commands are configured — add them when creating the task, or verify by hand before accepting.'
              : ' Run the configured commands before accepting, or accept with the explicit unverified confirmation.'}
          </div>
        </div>
      ) : (
        <div className="ck-groups">
          {grouped.map(([label, list]) => (
            <div className="ck-group" key={label}>
              <div className="ck-group-head mono">{label}</div>
              {list.map((run) => {
                const icon = stateIcon(run);
                return (
                  <div
                    key={run.id}
                    className={`ck-row ${run.superseded ? 'superseded' : ''}`}
                    data-testid={`check-row-${run.id}`}
                    data-state={run.state}
                  >
                    <span className={`ck-ic ${icon.cls}`}>{icon.glyph}</span>
                    <span className="ck-cmd mono">
                      {run.state}
                      {run.exitCode !== null && run.state !== 'passed'
                        ? ` (exit ${run.exitCode})`
                        : ''}
                    </span>
                    {run.superseded ? (
                      <span className="ck-chip" data-testid={`check-superseded-${run.id}`}>
                        superseded
                      </span>
                    ) : null}
                    {run.stale ? (
                      <span className="ck-chip warn" data-testid={`check-stale-${run.id}`}>
                        stale
                      </span>
                    ) : null}
                    {run.outputExcerpt ? (
                      <details className="ck-out">
                        <summary>output</summary>
                        <pre className="mono">{run.outputExcerpt.slice(0, 2000)}</pre>
                      </details>
                    ) : null}
                    <span className="ck-dur mono">{durationOf(run)}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
