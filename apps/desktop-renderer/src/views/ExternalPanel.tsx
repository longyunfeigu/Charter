import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore.js';
import { useExternalStore, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH } from '../store/externalStore.js';
import { useTaskStore } from '../store/taskStore.js';
import {
  compactTerminalPath,
  useTerminalStore,
  mountTerminal,
  observeTerminalFit,
} from './TerminalPanel.js';

/**
 * ADR-0017 rev.2 —「意图升格」. The side panel exists only after the user
 * clicked "Move to side panel" on a session bar (or opted into auto-promote).
 * Same xterm instance, PTY uninterrupted; 600px default so the TUI keeps
 * ≥80 columns; resizable; the session ending does NOT move the pane — the
 * user returns it with ⇤ (or closes the terminal).
 */
export function ExternalPanel(): React.JSX.Element | null {
  const promoted = useExternalStore((s) => s.promoted);
  const cli = useExternalStore((s) =>
    promoted ? (s.agentByTerminal[promoted.terminalId] ?? null) : null,
  );
  const session = useExternalStore((s) => (promoted ? s.sessions[promoted.taskId] : undefined));
  const width = useExternalStore((s) => s.panelWidth);
  const items = useTerminalStore((s) => s.items);
  const task = useTaskStore((s) =>
    promoted ? (s.tasks.find((entry) => entry.id === promoted.taskId) ?? null) : null,
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ pointerId: number; clientX: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);

  const item = promoted ? (items.find((t) => t.id === promoted.terminalId) ?? null) : null;

  // This panel is mounted only inside the Terminal Session manager, so it can
  // claim the promoted xterm without relying on the removed workspace surface.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !item) return;
    mountTerminal(host, item);
    return observeTerminalFit(host, item);
  }, [item]);

  // Keep the resize cursor and suppress accidental editor/terminal selection
  // while pointer capture carries the drag across Monaco and xterm.
  useEffect(() => {
    if (!resizing) return;
    document.documentElement.classList.add('xp-resizing');
    return () => document.documentElement.classList.remove('xp-resizing');
  }, [resizing]);

  // A saved 600–900px rail must not crush the editor/dock after the window is
  // restored at laptop width. Temporarily close the primary sidebar and put it
  // back when the focus slot returns to the dock.
  useEffect(() => {
    const ensureSpace = (): void => useExternalStore.getState().ensureSidePanelSpace();
    ensureSpace();
    window.addEventListener('resize', ensureSpace);
    return () => window.removeEventListener('resize', ensureSpace);
  }, [promoted?.terminalId, width]);

  if (!promoted) return null;

  const live = (session?.status ?? 'active') === 'active';
  const files = session?.files ?? [];
  const openRoom = (path?: string): void => {
    const app = useAppStore.getState();
    app.openTaskRoom(promoted.taskId);
    if (path) app.openPeek(promoted.taskId, path, 'diff');
  };
  const startDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { pointerId: e.pointerId, clientX: e.clientX, width };
    setResizing(true);
  };
  const continueDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    if (!start || start.pointerId !== e.pointerId) return;
    useExternalStore.getState().setPanelWidth(start.width + start.clientX - e.clientX);
  };
  const finishDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    if (!start || start.pointerId !== e.pointerId) return;
    dragStart.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setResizing(false);
  };

  return (
    <>
      <div
        className={`xp-resize ${resizing ? 'is-resizing' : ''}`}
        role="separator"
        aria-label="Resize session panel"
        aria-orientation="vertical"
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        title={`Drag to resize (${PANEL_MIN_WIDTH}–${PANEL_MAX_WIDTH}px)`}
        onPointerDown={startDrag}
        onPointerMove={continueDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={() => {
          dragStart.current = null;
          setResizing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') {
            useExternalStore.getState().setPanelWidth(width + 16);
            e.preventDefault();
          } else if (e.key === 'ArrowRight') {
            useExternalStore.getState().setPanelWidth(width - 16);
            e.preventDefault();
          } else if (e.key === 'Home') {
            useExternalStore.getState().setPanelWidth(PANEL_MIN_WIDTH);
            e.preventDefault();
          } else if (e.key === 'End') {
            useExternalStore.getState().setPanelWidth(PANEL_MAX_WIDTH);
            e.preventDefault();
          }
        }}
      />
      <aside
        className={`external-panel ${resizing ? 'is-resizing' : ''}`}
        style={{ width }}
        data-testid="external-panel"
        aria-label="External session"
      >
        <div className={`xp-head ${live ? '' : 'ended'}`}>
          <span className="xp-dot" />
          <div className="xp-identity">
            <div className="xp-title" data-testid={`terminal-agent-${promoted.terminalId}`}>
              <span className="term-agent">✳ {cli ?? session?.cli ?? 'agent'}</span>
              <span
                className="term-agent-ext"
                title={
                  task?.external?.remote
                    ? 'Remote Agent over SSH — Charter Worker protects Diff, Review and rollback'
                    : 'External agent session — unmanaged (outside the Tool Gateway); tracked & reviewable'
                }
              >
                {task?.external?.remote ? 'REMOTE · Worker tracked' : 'EXT · unmanaged'}
              </span>
              {!live ? (
                <span className="xp-ended" data-testid="external-panel-ended">
                  ended
                </span>
              ) : null}
            </div>
            <div className="xp-context" title={item?.cwd}>
              {item
                ? `${item.projectName} · ${compactTerminalPath(item.cwd)}`
                : 'Terminal context unavailable'}
            </div>
          </div>
          <div className="xp-actions">
            {!live ? (
              <button
                className="xp-btn"
                data-testid="external-panel-resume"
                disabled={!task?.external}
                title="Resume in the same recorded working context"
                onClick={() => task && void useExternalStore.getState().resumeTask(task)}
              >
                Resume
              </button>
            ) : null}
            {!live ? (
              <button
                className="xp-btn review"
                data-testid="external-panel-review"
                title="Review this session's changes (accept or roll back byte-exactly)"
                onClick={() => openRoom()}
              >
                Review
              </button>
            ) : null}
            <button
              className="xp-btn"
              data-testid={`terminal-open-room-${promoted.terminalId}`}
              title="Open this session's Task Room — live changes, peek and review around this terminal"
              onClick={() => openRoom()}
            >
              ⤢ Room
            </button>
            <button
              className="xp-btn primary"
              data-testid="external-return-dock"
              title="Return this terminal to the bottom dock"
              onClick={() => useExternalStore.getState().unpromote()}
            >
              ⇤ Return to dock
            </button>
          </div>
          <div className="xp-context-row">
            <span>{task?.title ?? item?.contextLabel ?? 'External terminal session'}</span>
            {session?.snapshotRef ? <span>snapshot {session.snapshotRef.slice(0, 7)}</span> : null}
            <span>{files.length} files changed</span>
          </div>
        </div>
        <div
          ref={hostRef}
          className="xp-term"
          data-testid="external-panel-terminal"
          data-terminal-id={promoted.terminalId}
        />
        <div className="xp-strip" data-testid="external-strip">
          <div className="xp-strip-h">
            <span>Session changes</span>
            <span className="xp-cnt">{files.length}</span>
            <span className="xp-strip-note">Open in Peek · Editor focus stays unchanged</span>
          </div>
          <div className="xp-strip-body">
            {files.length === 0 ? (
              <div className="xp-empty">No file changes yet.</div>
            ) : (
              files.map((f) => (
                <button
                  key={f.path}
                  className="xp-chg"
                  data-testid={`external-strip-file-${f.path}`}
                  title={`${f.path} — open the diff in the session room`}
                  onClick={() => openRoom(f.path)}
                >
                  <span className="xp-nm">{f.path.split('/').pop()}</span>
                  <span className="xp-pm">
                    <span className="xp-p">+{f.additions}</span>{' '}
                    <span className="xp-m">−{f.deletions}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
