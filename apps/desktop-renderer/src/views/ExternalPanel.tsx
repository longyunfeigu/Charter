import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore.js';
import { useExternalStore, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH } from '../store/externalStore.js';
import { useTerminalStore, mountTerminal } from './TerminalPanel.js';

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
  const surface = useAppStore((s) => s.surface);
  const items = useTerminalStore((s) => s.items);
  const hostRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef(0);

  const item = promoted ? (items.find((t) => t.id === promoted.terminalId) ?? null) : null;

  // Mount the promoted terminal (same mount substrate as the dock / the room).
  // The room takes the instance while it is open (Home surface) — only claim
  // it while the Editor surface is actually in front.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !item || surface !== 'workspace') return;
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
  }, [item, surface]);

  if (!promoted) return null;

  const live = (session?.status ?? 'active') === 'active';
  const files = session?.files ?? [];
  const openRoom = (path?: string): void => {
    const app = useAppStore.getState();
    app.openTaskRoom(promoted.taskId);
    if (path) app.openPeek(promoted.taskId, path, 'diff');
  };
  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault();
    dragStart.current = e.clientX + width;
    const onMove = (ev: MouseEvent): void => {
      useExternalStore.getState().setPanelWidth(dragStart.current - ev.clientX);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <aside
      className="external-panel"
      style={{ width }}
      data-testid="external-panel"
      aria-label="External session"
    >
      <div
        className="xp-resize"
        role="separator"
        aria-label="Resize session panel"
        title={`Drag to resize (${PANEL_MIN_WIDTH}–${PANEL_MAX_WIDTH}px)`}
        onMouseDown={startDrag}
      />
      <div className={`xp-head ${live ? '' : 'ended'}`}>
        <span className="xp-dot" />
        <span className="term-agent" data-testid={`terminal-agent-${promoted.terminalId}`}>
          ✳ {cli ?? session?.cli ?? 'agent'}{' '}
          <span
            className="term-agent-ext"
            title="External agent session — unmanaged (outside the Tool Gateway); tracked & reviewable"
          >
            EXT
          </span>
        </span>
        {!live ? (
          <span className="xp-ended" data-testid="external-panel-ended">
            ✻ ended
          </span>
        ) : null}
        <span className="xp-sp" />
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
          className="xp-btn"
          data-testid="external-return-dock"
          title="Return this terminal to the bottom dock"
          onClick={() => useExternalStore.getState().unpromote()}
        >
          ⇤ Return to dock
        </button>
      </div>
      <div ref={hostRef} className="xp-term" data-testid="external-panel-terminal" />
      <div className="xp-strip" data-testid="external-strip">
        <div className="xp-strip-h">
          Session changes
          <span className="xp-cnt">{files.length}</span>
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
  );
}
