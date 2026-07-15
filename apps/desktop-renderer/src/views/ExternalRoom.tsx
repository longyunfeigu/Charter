import React, { useEffect, useRef } from 'react';
import type { TaskDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useExternalStore, type ExternalSessionFile } from '../store/externalStore.js';
import { useTerminalStore, mountTerminal } from './TerminalPanel.js';

/**
 * ADR-0017 — the center column of an external CLI session's Task Room: the
 * session's real terminal (same xterm instance as the dock, PTY uninterrupted)
 * in the place where the timeline + composer normally live. The conversation
 * with this agent happens in the terminal; the room adds the product's
 * accounting around it (rail, peek, review).
 */
export function ExternalTerminalColumn({ task }: { task: TaskDto }): React.JSX.Element {
  const external = task.external!;
  const session = useExternalStore((s) => s.sessions[task.id]);
  const termStore = useTerminalStore();
  const item = termStore.items.find((t) => t.id === external.terminalId) ?? null;
  const hostRef = useRef<HTMLDivElement>(null);
  const live = (session?.status ?? external.status) === 'active';
  const follow = useExternalStore((s) => s.follow[task.id] ?? true);
  const lastDelta = useExternalStore((s) => s.lastDelta);

  useEffect(() => {
    useExternalStore.getState().init();
    termStore.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live auto-follow (mock chapter ⑤ / direction B): while the peek is open,
  // it follows whatever the CLI is writing right now. Opt-out via the LIVE pill.
  useEffect(() => {
    if (!follow || !lastDelta || lastDelta.taskId !== task.id) return;
    const app = useAppStore.getState();
    if (app.peek === null || app.peek.taskId !== task.id) return;
    const path = lastDelta.paths[0];
    if (path) app.openPeek(task.id, path, 'diff');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastDelta?.seq]);

  // Mount the session's terminal into this room (same mount substrate as the
  // dock / side panel — ADR-0017 rev.2: xterm re-mounts move the live element).
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !item) return;
    mountTerminal(host, item);
    const observer = new ResizeObserver(() => {
      try {
        item.fit.fit();
      } catch {
        // fit races during teardown are harmless
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [item]);

  return (
    <div className="tr-extcol" data-testid="external-terminal-column">
      <div className="tr-exthead">
        <span className={`tr-extdot ${live ? 'live' : ''}`} />
        <span className="tr-extname">✳ {external.cli}</span>
        <span
          className="tr-extbadge"
          title="This session runs outside the Tool Gateway and the permission engine. An entry snapshot was taken; every change is tracked and reviewable."
        >
          EXT · unmanaged
        </span>
        {external.snapshotRef ? (
          <span
            className="tr-extsnap"
            title="Entry snapshot — rollback restores these bytes exactly"
          >
            snap {external.snapshotRef.slice(0, 7)}
          </span>
        ) : null}
        <span className="tr-sp" />
        {live ? (
          <button
            className={`tr-extlive ${follow ? '' : 'paused'}`}
            data-testid="external-live"
            title={
              follow
                ? 'The peek follows what the CLI is writing. Click to pin the current file.'
                : 'Auto-follow is pinned off. Click to follow live changes again.'
            }
            onClick={() => useExternalStore.getState().setFollow(task.id, !follow)}
          >
            {follow ? 'LIVE · following' : '⏸ pinned'}
          </button>
        ) : (
          <span className="tr-extended" data-testid="external-ended">
            session ended
          </span>
        )}
      </div>
      {item ? (
        <div ref={hostRef} className="tr-exthost" data-testid="external-terminal-host" />
      ) : (
        <div className="tr-extgone" data-testid="external-terminal-gone">
          <div className="tr-extgone-title">
            {live ? 'The session terminal lives in another surface.' : 'This session is over.'}
          </div>
          <div className="tr-extgone-body">
            {(session?.files.length ?? task.changedFiles ?? 0) > 0
              ? `${session?.files.length ?? task.changedFiles} file${(session?.files.length ?? task.changedFiles) === 1 ? '' : 's'} changed — use the rail to peek, or Review to close out.`
              : 'No tracked file changes.'}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Rail data for an external task: live session files when the session store
 * has them, else a one-shot hydrate from the recorded change set (restarts,
 * ended sessions).
 */
export function useExternalFiles(task: TaskDto): ExternalSessionFile[] {
  const session = useExternalStore((s) => s.sessions[task.id]);
  useEffect(() => {
    if (!task.external || session) return;
    let cancelled = false;
    void rpcResult('task.changeSet', { taskId: task.id }).then((res) => {
      if (cancelled || !res.ok) return;
      const files = res.data.changeSet.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
      useExternalStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          [task.id]: {
            terminalId: task.external!.terminalId,
            taskId: task.id,
            cli: task.external!.cli,
            snapshotRef: task.external!.snapshotRef,
            status: task.external!.status,
            files,
          },
        },
      }));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, session === undefined]);
  return session?.files ?? [];
}
