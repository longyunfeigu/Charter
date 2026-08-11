import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { Ic } from '../home-icons.js';

export function MissionDeleteDialog({
  snapshot,
  permanent = false,
  busy = false,
  onClose,
  onConfirm,
}: {
  snapshot: MissionSnapshotDto;
  permanent?: boolean;
  busy?: boolean;
  onClose(): void;
  onConfirm(): void;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const runtimeCount = snapshot.runtimeSessions?.length ?? snapshot.attempts.length;
  const evidenceCount = snapshot.artifacts.length;
  const messageCount = snapshot.messages.length;

  return createPortal(
    <div
      className="modal-backdrop mission-delete-backdrop"
      data-testid="mission-delete-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="modal small mission-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mission-delete-title"
      >
        <header className="modal-header">
          <span id="mission-delete-title">
            {permanent ? 'Delete Mission permanently?' : 'Move Mission to Recently Deleted?'}
          </span>
          <button className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
            <Ic name="x" size={14} />
          </button>
        </header>
        <div className="modal-body mission-delete-body">
          <span className="mission-delete-mark">
            <Ic name={permanent ? 'trash' : 'clock'} size={20} />
          </span>
          <div>
            <h2>{snapshot.mission.title}</h2>
            <p>
              {permanent
                ? 'This removes the complete Mission record and cannot be undone.'
                : 'The Mission will disappear from History and can be restored for 30 days.'}
            </p>
          </div>
          <dl className="mission-delete-impact">
            <div>
              <dt>{snapshot.assignments.length}</dt>
              <dd>Assignments</dd>
            </div>
            <div>
              <dt>{runtimeCount}</dt>
              <dd>Runs</dd>
            </div>
            <div>
              <dt>{messageCount}</dt>
              <dd>Messages</dd>
            </div>
            <div>
              <dt>{evidenceCount}</dt>
              <dd>Evidence</dd>
            </div>
          </dl>
          <div className="mission-delete-preserves">
            <Ic name="shield" size={15} />
            <span>
              <strong>Kept safe</strong>
              {snapshot.mission.originConversationTaskId
                ? 'The original Session and every project file remain untouched.'
                : 'Every project file remains untouched. This Mission no longer has a parent Session.'}
            </span>
          </div>
        </div>
        <footer className="mission-delete-actions">
          <button className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn danger"
            data-testid={permanent ? 'mission-delete-permanent-confirm' : 'mission-trash-confirm'}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Working…' : permanent ? 'Delete permanently' : 'Move to Recently Deleted'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
