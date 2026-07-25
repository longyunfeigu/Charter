import type { TaskDto } from '@pi-ide/ipc-contracts';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTaskStore } from '../store/taskStore.js';
import { sessionDisplayTitle } from '../store/sessionAttention.js';
import { Ic } from './home-icons.js';

export function SessionRenameDialog({
  task,
  open,
  onClose,
}: {
  task: TaskDto;
  open: boolean;
  onClose(): void;
}): React.JSX.Element | null {
  const [title, setTitle] = useState(() => sessionDisplayTitle(task));
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(sessionDisplayTitle(task));
    setSaving(false);
    window.setTimeout(() => inputRef.current?.select(), 0);
  }, [open, task]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open, saving]);

  if (!open) return null;
  const cleaned = title.trim();

  const save = async (): Promise<void> => {
    if (!cleaned || saving) return;
    setSaving(true);
    const saved = await useTaskStore.getState().renameTask(task.id, cleaned);
    if (saved) onClose();
    else setSaving(false);
  };

  return createPortal(
    <div
      className="modal-backdrop session-rename-backdrop"
      data-testid="session-rename-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        className="modal small session-rename-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-rename-title"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="modal-header">
          <span id="session-rename-title">Rename Session</span>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            disabled={saving}
            onClick={onClose}
          >
            <Ic name="x" size={14} />
          </button>
        </div>
        <div className="modal-body session-rename-body">
          <label htmlFor="session-rename-input">Session name</label>
          <input
            ref={inputRef}
            id="session-rename-input"
            data-testid="session-rename-input"
            value={title}
            maxLength={300}
            disabled={saving}
            autoComplete="off"
            onChange={(event) => setTitle(event.target.value)}
          />
          <small>Use a short name that makes this Session easy to find later.</small>
        </div>
        <div className="session-rename-actions">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            data-testid="session-rename-save"
            disabled={!cleaned || saving}
          >
            {saving ? 'Saving...' : 'Save name'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
