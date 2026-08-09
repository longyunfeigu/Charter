import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import type { ChannelResponse } from '@pi-ide/ipc-contracts';
import { onEvent, rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { t } from '../i18n.js';
import { Ic } from './home-icons.js';

type GitStatusDto = ChannelResponse<'git.status'>;

let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;

interface GitStore {
  status: GitStatusDto | null;
  refreshing: boolean;
  message: string;
  committing: boolean;
  discardConfirm: string[] | null;
  branchPickerOpen: boolean;
  initialized: boolean;

  init(): void;
  refresh(): Promise<void>;
  setMessage(message: string): void;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  requestDiscard(paths: string[]): void;
  confirmDiscard(confirmed: boolean): Promise<void>;
  commit(): Promise<void>;
  setBranchPickerOpen(open: boolean): void;
}

export const useGitStore = create<GitStore>((set, get) => ({
  status: null,
  refreshing: false,
  message: '',
  committing: false,
  discardConfirm: null,
  branchPickerOpen: false,
  initialized: false,

  init() {
    if (get().initialized) return;
    set({ initialized: true });
    onEvent('git.changed', () => void get().refresh());
    onEvent('workspace.changed', ({ workspace }) => {
      set({ status: null, message: '' });
      if (workspace) void get().refresh();
    });
    const ws = useWorkspaceStore.getState().workspace;
    if (ws) void get().refresh();
  },

  async refresh() {
    if (refreshInFlight) {
      refreshQueued = true;
      await refreshInFlight;
      return;
    }
    set({ refreshing: true });
    refreshInFlight = (async () => {
      do {
        refreshQueued = false;
        const res = await rpcResult('git.status', {});
        set({ status: res.ok ? res.data : null });
      } while (refreshQueued);
    })();
    try {
      await refreshInFlight;
    } finally {
      refreshInFlight = null;
      set({ refreshing: false });
    }
  },

  setMessage(message) {
    set({ message });
  },

  async stage(paths) {
    const res = await rpcResult('git.stage', { paths });
    if (!res.ok) useAppStore.getState().pushToast('error', res.error.userMessage);
  },
  async unstage(paths) {
    const res = await rpcResult('git.unstage', { paths });
    if (!res.ok) useAppStore.getState().pushToast('error', res.error.userMessage);
  },
  requestDiscard(paths) {
    set({ discardConfirm: paths });
  },
  async confirmDiscard(confirmed) {
    const paths = get().discardConfirm;
    set({ discardConfirm: null });
    if (!confirmed || !paths) return;
    const res = await rpcResult('git.discard', { paths, includeUntracked: true });
    if (!res.ok) useAppStore.getState().pushToast('error', res.error.userMessage);
  },
  async commit() {
    const message = get().message.trim();
    if (!message) {
      useAppStore.getState().pushToast('warning', 'Enter a commit message first.');
      return;
    }
    set({ committing: true });
    const res = await rpcResult('git.commit', { message });
    set({ committing: false });
    if (res.ok) {
      set({ message: '' });
      useAppStore.getState().pushToast('success', 'Committed.');
    } else {
      useAppStore.getState().pushToast('error', `${res.error.userMessage}`);
    }
  },
  setBranchPickerOpen(open) {
    set({ branchPickerOpen: open });
  },
}));

const GROUPS: Array<{ id: 'conflict' | 'staged' | 'changes' | 'untracked'; label: string }> = [
  { id: 'conflict', label: 'Merge Conflicts' },
  { id: 'staged', label: 'Staged Changes' },
  { id: 'changes', label: 'Changes' },
  { id: 'untracked', label: 'Untracked' },
];

export function ScmView({
  onDidOpenTarget,
}: {
  /**
   * Fired after a click opened a diff/file in the editor — hosts whose editor
   * is not beside the change list (Terminal Session tools) flip to it here.
   */
  onDidOpenTarget?: () => void;
} = {}): React.JSX.Element {
  const store = useGitStore();
  const workspace = useWorkspaceStore((s) => s.workspace);

  useEffect(() => {
    store.init();
    if (workspace && !store.status) void store.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  // ADR-0057: changes open as diff TABS in the adjacent editor, never a modal.
  // Untracked and conflicted files have nothing meaningful to diff against —
  // open the file itself (conflict markers are content).
  const openEntry = (path: string, group: string): void => {
    // git-service enumerates untracked files individually (-uall), so a
    // directory row should never appear — but a "dir/" path is not a document
    // and must never reach doc.open.
    if (path.endsWith('/')) return;
    const editor = useEditorStore.getState();
    if (group === 'untracked' || group === 'conflict') {
      void editor.openFile(path);
    } else {
      void editor.openDiff(path, { staged: group === 'staged' });
    }
    onDidOpenTarget?.();
  };

  if (!workspace) return <div className="empty-state">Open a workspace to use source control.</div>;

  if (store.status && !store.status.gitAvailable) {
    return (
      <div className="empty-state">
        <div className="es-title">Git not found</div>
        <div>Install git and reopen the workspace.</div>
      </div>
    );
  }

  if (store.status && !store.status.isRepo) {
    return (
      <div className="empty-state" data-testid="scm-no-repo">
        <div className="es-title">Not a git repository</div>
        <div>The editor and agent work fine without git.</div>
        <button
          className="btn primary"
          onClick={() =>
            void rpcResult('git.init', {}).then((res) => {
              if (res.ok) void useGitStore.getState().refresh();
            })
          }
        >
          Initialize repository
        </button>
      </div>
    );
  }

  const status = store.status;
  const entriesFor = (group: string) => status?.entries.filter((e) => e.group === group) ?? [];

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      data-testid="scm-view"
    >
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea
          data-testid="commit-message"
          placeholder={`${t('Commit message')} (${status?.branch ?? t('no branch')})`}
          value={store.message}
          rows={2}
          style={{
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '6px 8px',
            resize: 'vertical',
            fontFamily: 'inherit',
          }}
          onChange={(e) => store.setMessage(e.target.value)}
        />
        <button
          className="btn primary"
          data-testid="commit-btn"
          disabled={store.committing || entriesFor('staged').length === 0}
          title={
            entriesFor('staged').length === 0 ? 'Stage changes first' : 'Commit staged changes'
          }
          onClick={() => void store.commit()}
        >
          {store.committing ? 'Committing…' : `Commit (${entriesFor('staged').length})`}
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto', fontSize: 12.5 }}>
        {status === null ? (
          <div className="text-muted" style={{ padding: 8 }}>
            Loading status…
          </div>
        ) : null}
        {status && status.entries.length === 0 ? (
          <div className="empty-state" data-testid="scm-clean">
            No changes — working tree clean.
          </div>
        ) : null}
        {GROUPS.map((group) => {
          const entries = entriesFor(group.id);
          if (entries.length === 0) return null;
          return (
            <div key={group.id} data-testid={`scm-group-${group.id}`}>
              <div
                style={{
                  padding: '4px 8px',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
                className="text-muted"
              >
                {group.label} ({entries.length})
              </div>
              {entries.map((entry) => (
                <div
                  key={`${group.id}-${entry.path}`}
                  className="scm-entry"
                  data-testid={`scm-entry-${entry.path}`}
                >
                  <button
                    className="quickpick-item"
                    style={{ flex: 1, padding: '3px 6px', minWidth: 0 }}
                    // The row text truncates, so the tooltip's job is the FULL
                    // path (2026-08-09 acceptance feedback), not the action.
                    title={entry.path}
                    onClick={() => openEntry(entry.path, group.id)}
                  >
                    <span
                      className="mono"
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {entry.path}
                    </span>
                    <span className="qp-detail" data-i18n-ignore>
                      {group.id === 'staged' ? entry.indexState : entry.workState}
                    </span>
                  </button>
                  {group.id === 'staged' ? (
                    <button
                      className="scm-act"
                      title={t('Unstage file')}
                      aria-label={`Unstage ${entry.path}`}
                      data-testid={`unstage-${entry.path}`}
                      onClick={() => void store.unstage([entry.path])}
                    >
                      <Ic name="minus" size={13} />
                    </button>
                  ) : (
                    <>
                      <button
                        className="scm-act danger"
                        title={
                          group.id === 'untracked'
                            ? t('Discard (deletes the untracked file)')
                            : t('Discard changes')
                        }
                        aria-label={`Discard ${entry.path}`}
                        onClick={() => store.requestDiscard([entry.path])}
                      >
                        <Ic name="undo" size={13} />
                      </button>
                      <button
                        className="scm-act"
                        title={t('Stage file')}
                        aria-label={`Stage ${entry.path}`}
                        data-testid={`stage-${entry.path}`}
                        onClick={() => void store.stage([entry.path])}
                      >
                        <Ic name="plus" size={13} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {store.discardConfirm ? <DiscardConfirm paths={store.discardConfirm} /> : null}
    </div>
  );
}

function DiscardConfirm({ paths }: { paths: string[] }): React.JSX.Element {
  const confirmDiscard = useGitStore((s) => s.confirmDiscard);
  // Portaled to <body>: inside .hm-root the Session rail would paint over it.
  return createPortal(
    <div className="modal-backdrop">
      <div
        className="modal small"
        role="dialog"
        aria-label="Discard changes"
        data-testid="discard-confirm"
      >
        <div className="modal-header">Discard changes?</div>
        <div style={{ padding: 16 }}>
          <p>
            This permanently discards local changes in {paths.length} file(s). Untracked files will
            be deleted.
          </p>
          <ul className="mono" style={{ fontSize: 12, maxHeight: 140, overflow: 'auto' }}>
            {paths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => void confirmDiscard(false)}>
              Cancel
            </button>
            <button
              className="btn danger"
              data-testid="discard-yes"
              onClick={() => void confirmDiscard(true)}
            >
              Discard
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function BranchStatusItem(): React.JSX.Element | null {
  const status = useGitStore((s) => s.status);
  const setBranchPickerOpen = useGitStore((s) => s.setBranchPickerOpen);
  const workspace = useWorkspaceStore((s) => s.workspace);
  if (!workspace || !status?.isRepo) return null;
  return (
    <button
      className="sb-item"
      data-testid="status-branch"
      title="Switch branch"
      onClick={() => setBranchPickerOpen(true)}
    >
      ⎇ {status.branch ?? `detached@${status.head?.slice(0, 7) ?? '?'}`}
      {status.ahead > 0 ? ` ↑${status.ahead}` : ''}
      {status.behind > 0 ? ` ↓${status.behind}` : ''}
    </button>
  );
}

export function BranchPicker(): React.JSX.Element | null {
  const open = useGitStore((s) => s.branchPickerOpen);
  const setOpen = useGitStore((s) => s.setBranchPickerOpen);
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean }>>([]);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    if (open) {
      void rpcResult('git.branches', {}).then((res) => {
        if (res.ok) setBranches(res.data.items);
      });
      setNewName('');
    }
  }, [open]);

  if (!open) return null;

  const checkout = async (name: string) => {
    setOpen(false);
    const res = await rpcResult('git.checkout', { name });
    if (!res.ok) useAppStore.getState().pushToast('error', res.error.userMessage);
  };

  return (
    <>
      <div className="overlay-backdrop" onClick={() => setOpen(false)} />
      <div
        className="quickpick"
        role="dialog"
        aria-label="Switch branch"
        data-testid="branch-picker"
      >
        <input
          autoFocus
          placeholder="Create new branch… (type name and press Enter)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newName.trim()) {
              setOpen(false);
              void rpcResult('git.createBranch', { name: newName.trim() }).then((res) => {
                if (!res.ok) useAppStore.getState().pushToast('error', res.error.userMessage);
              });
            }
            if (e.key === 'Escape') setOpen(false);
          }}
        />
        <div className="quickpick-list">
          {branches.map((branch) => (
            <button
              key={branch.name}
              className="quickpick-item"
              data-testid={`branch-${branch.name}`}
              onClick={() => void checkout(branch.name)}
            >
              <span data-i18n-ignore>
                {branch.current ? '● ' : ''}
                {branch.name}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
