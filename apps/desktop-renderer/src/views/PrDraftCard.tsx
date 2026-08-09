import React, { useEffect } from 'react';
import { useTaskStore } from '../store/taskStore.js';
import { useAppStore } from '../store/appStore.js';
import '../styles/preview.css';

/**
 * Explicit PR draft review (ADR-0022): the evidence ledger, exported. The
 * card opens from the durable timeline entry and only copies text out — push
 * and `gh pr create` happen in the user's shell, under the user's credentials
 * (GIT-007). Dismissing is safe because the timeline entry remains.
 */
export function PrDraftCard(): React.JSX.Element | null {
  const entry = useTaskStore((s) => s.prDraft);
  const app = useAppStore.getState(); // actions only

  useEffect(() => {
    if (!entry) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useTaskStore.getState().dismissPrDraft();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entry]);

  if (!entry) return null;
  const { draft } = entry;

  const copy = async (label: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      app.pushToast('success', `${label} copied.`);
    } catch {
      app.pushToast('error', `Could not copy the ${label.toLowerCase()}.`);
    }
  };

  return (
    <div
      className="modal-backdrop"
      data-testid="pr-draft-card"
      onClick={(e) => {
        if (e.target === e.currentTarget) useTaskStore.getState().dismissPrDraft();
      }}
    >
      <div className="pr-card" role="dialog" aria-label="PR draft">
        <div className="pr-card-head">
          PR draft ready <span className="pr-card-src">body from the evidence ledger</span>
        </div>
        <div className="pr-card-sub">
          Branch <span className="mono">{draft.branch}</span> — title and body were generated from
          the task's goal, change list, verification matrix
          {draft.receiptSha256 ? ' and replay receipt' : ''}. Edit freely after pasting.
        </div>
        <pre className="pr-card-body mono" data-testid="pr-draft-body">
          {draft.body}
        </pre>
        <div className="pr-card-row">
          <span className="pr-card-gitnote">
            GIT-007: the agent tool layer has no push, and Charter never runs these commands — copy
            them into your shell when you're ready.
          </span>
          <button
            className="btn"
            data-testid="pr-draft-copy-body"
            onClick={() => void copy('PR body', draft.body)}
          >
            Copy body
          </button>
          <button
            className="btn primary"
            data-testid="pr-draft-copy-commands"
            onClick={() => void copy('Commands', draft.commands)}
          >
            Copy commands
          </button>
          <button
            className="btn"
            data-testid="pr-draft-dismiss"
            onClick={() => useTaskStore.getState().dismissPrDraft()}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
