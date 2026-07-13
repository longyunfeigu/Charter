import React, { useEffect, useState } from 'react';
import type { ChangeSetDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useActivityStore } from '../store/activityStore.js';
import { Ic } from './home-icons.js';

/**
 * Diff-so-far lens (PIVOT-025): read-only view of one file's net diff while the
 * task runs. Reuses the recorded change set — never touches the working tree.
 */
export function FileLens(props: {
  taskId: string;
  path: string;
  onClose: () => void;
}): React.JSX.Element {
  const [changeSet, setChangeSet] = useState<ChangeSetDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  // A write pulse can precede the committed change record; follow the stream.
  const pulseVersion = useActivityStore(
    (s) => s.pulses.filter((p) => p.taskId === props.taskId && p.paths.includes(props.path)).length,
  );

  useEffect(() => {
    let alive = true;
    void rpcResult('task.changeSet', { taskId: props.taskId }).then((res) => {
      if (!alive) return;
      setLoading(false);
      if (res.ok) {
        setChangeSet(res.data.changeSet);
        // The record may land moments after the pulse — retry briefly.
        const found = res.data.changeSet.files.some((f) => f.path === props.path);
        if (!found && attempt < 6) {
          setTimeout(() => alive && setAttempt((n) => n + 1), 350);
        }
      }
    });
    return () => {
      alive = false;
    };
  }, [props.taskId, props.path, pulseVersion, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const file = changeSet?.files.find((f) => f.path === props.path) ?? null;

  return (
    <div
      className="fl-backdrop"
      data-testid="file-lens"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="fl-card" role="dialog" aria-label={`Diff so far — ${props.path}`}>
        <div className="fl-head">
          <Ic name="file" size={13} />
          <span className="fl-path">{props.path}</span>
          <span className="fl-tag">diff so far · read-only</span>
          {file ? (
            <span className="fl-d">
              <span className="plus">+{file.additions}</span>{' '}
              <span className="minus">−{file.deletions}</span>
            </span>
          ) : null}
          <button
            className="fl-close"
            data-testid="file-lens-close"
            aria-label="Close"
            onClick={props.onClose}
          >
            <Ic name="x" size={13} />
          </button>
        </div>
        <div className="fl-body">
          {loading ? (
            <div className="text-muted" style={{ padding: 14 }}>
              Computing the diff…
            </div>
          ) : !file ? (
            <div className="text-muted" style={{ padding: 14 }}>
              No net diff recorded for this file yet.
            </div>
          ) : file.binary ? (
            <div className="text-muted" style={{ padding: 14 }}>
              Binary file — no text diff available.
            </div>
          ) : (
            file.hunks.map((hunk) => (
              <div key={hunk.key} className="fl-hunk">
                <div className="fl-hunk-head mono">{hunk.header}</div>
                {hunk.lines.map((line, i) => (
                  <div
                    key={i}
                    className={`mono fl-line ${
                      line.startsWith('+') ? 'plus' : line.startsWith('-') ? 'minus' : ''
                    }`}
                  >
                    {line || ' '}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
