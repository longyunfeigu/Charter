import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SftpEntry } from '@pi-ide/ipc-contracts';
import '../styles/remote-files.css';
import { pathForDroppedFile, rpcResult } from '../bridge.js';
import { remoteJoin, remoteParent, useSftpStore } from '../store/sftpStore.js';
import { Ic } from './home-icons.js';
import { formatBytes } from './SftpPanel.js';
import { compactTerminalPath, useTerminalStore, type TermInstance } from './TerminalPanel.js';

/**
 * ADR-0059 — remote file transfer where the session already is.
 *
 * Two entries replace the old Remote Explorer → host → Files walk:
 * - Drop files anywhere on a remote session: they upload straight to the
 *   shell's live cwd (OSC 7). ⌥ pastes the local paths instead; ⇧ opens the
 *   Files drawer to pick the target directory first.
 * - A Files drawer on the session header: a single remote pane that follows
 *   the terminal's cwd (pinnable), for browsing, downloading and uploading
 *   without leaving the session.
 *
 * All bytes stream through the existing SFTP pipeline in the main process;
 * this file is entry-point UI only. Transfers surface both here (session
 * toast, only the ones this session started) and in the global Transfer
 * Center (everything).
 */

/** The directory a drop should land in: live shell cwd, else the host-set
 * context directory (managed root / remote workdir / `~`). */
export function resolveRemoteCwd(item: Pick<TermInstance, 'liveCwd' | 'cwd'>): string {
  return item.liveCwd ?? item.cwd;
}

/** `~` and `~/…` are renderer conveniences — the SFTP server treats them as
 * literal names, so expand against the server-resolved home before any op. */
async function resolveRemoteDir(hostId: string, dir: string): Promise<string> {
  if (dir !== '~' && !dir.startsWith('~/')) return dir;
  const home = await rpcResult('ssh.sftpHome', { hostId });
  if (!home.ok) throw new Error(home.error.userMessage);
  return dir === '~' ? home.data.path : remoteJoin(home.data.path, dir.slice(2));
}

/** Quote a path for pasting into a shell command line (never sends Enter). */
function shellQuotePath(path: string): string {
  return /^[A-Za-z0-9_\-./~:@]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

function dragHasFiles(e: React.DragEvent): boolean {
  return [...e.dataTransfer.types].includes('Files');
}

interface DropToast {
  transferIds: string[];
  /** Server-side directory the files were sent to (already ~-expanded). */
  remoteDir: string;
  hostId: string;
  dismissed: boolean;
}

interface DrawerState {
  open: boolean;
  /** Follow the terminal's live cwd; pinning keeps the browsed directory. */
  follow: boolean;
  path: string | null;
  entries: SftpEntry[];
  loading: boolean;
  error: string | null;
  /** The terminal cd'ed elsewhere while pinned — offer a one-click catch-up. */
  drift: boolean;
  /** ⇧-drop parks the files here until the user picks a directory. */
  pendingUpload: string[] | null;
}

const DRAWER_CLOSED: DrawerState = {
  open: false,
  follow: true,
  path: null,
  entries: [],
  loading: false,
  error: null,
  drift: false,
  pendingUpload: null,
};

export interface RemoteFilesLayer {
  /** Spread onto the session root so the whole surface accepts OS drops. */
  dragProps: {
    onDragEnter: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  /** Render inside the session root (needs a positioned ancestor). */
  layer: React.JSX.Element | null;
  openDrawer: () => void;
  drawerOpen: boolean;
}

/**
 * Wires drop-to-upload + the Files drawer for one remote session surface.
 * `item` is the terminal the transfers target — in a host-scoped manager view
 * the caller resolves it to the active dock terminal.
 */
export function useRemoteFilesLayer(item: TermInstance | null): RemoteFilesLayer {
  const remote = item?.remote ?? null;
  const hostId = remote?.hostId ?? null;
  const terminalId = item?.id ?? null;
  const liveCwd = item?.liveCwd ?? null;
  const targetCwd = item ? resolveRemoteCwd(item) : '~';

  const [dragDepth, setDragDepth] = useState(0);
  const [toast, setToast] = useState<DropToast | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(DRAWER_CLOSED);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const transfers = useSftpStore((s) => s.transfers);
  const rates = useSftpStore((s) => s.rates);
  // The list epoch guards against a stale directory listing landing after the
  // user navigated on (same pattern as sftpStore.epoch).
  const listEpoch = useRef(0);

  const dragging = dragDepth > 0;

  const paste = useCallback(
    (text: string, note: string) => {
      if (!terminalId) return;
      const target = useTerminalStore.getState().items.find((t) => t.id === terminalId);
      target?.term.paste(text);
      setActionNote(note);
      window.setTimeout(() => setActionNote(null), 4000);
    },
    [terminalId],
  );

  const startUpload = useCallback(
    async (localPaths: string[], remoteDir: string): Promise<void> => {
      if (!hostId || localPaths.length === 0) return;
      try {
        const resolved = await resolveRemoteDir(hostId, remoteDir);
        const ids = await useSftpStore.getState().uploadTo(hostId, resolved, localPaths);
        setToast({ transferIds: ids, remoteDir: resolved, hostId, dismissed: false });
      } catch (err) {
        setToast(null);
        setActionNote(err instanceof Error ? err.message : String(err));
        window.setTimeout(() => setActionNote(null), 6000);
      }
    },
    [hostId],
  );

  // ---------------------------------------------------------------------
  // Drawer data

  const navigate = useCallback(
    async (path: string): Promise<void> => {
      if (!hostId) return;
      const epoch = ++listEpoch.current;
      setDrawer((d) => ({ ...d, loading: true, error: null, drift: false }));
      try {
        const resolved = await resolveRemoteDir(hostId, path);
        const res = await rpcResult('ssh.sftpList', { hostId, path: resolved });
        if (epoch !== listEpoch.current) return;
        if (res.ok) {
          setDrawer((d) => ({
            ...d,
            path: res.data.path,
            entries: res.data.entries,
            loading: false,
          }));
        } else {
          setDrawer((d) => ({ ...d, loading: false, error: res.error.userMessage }));
        }
      } catch (err) {
        if (epoch !== listEpoch.current) return;
        setDrawer((d) => ({
          ...d,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [hostId],
  );

  const openDrawer = useCallback(() => {
    setDrawer((d) => ({ ...DRAWER_CLOSED, follow: d.follow, open: true, loading: true }));
    void navigate(targetCwd);
  }, [navigate, targetCwd]);

  const closeDrawer = useCallback(() => {
    setDrawer((d) => ({ ...DRAWER_CLOSED, follow: d.follow }));
    listEpoch.current += 1;
    // Let the SFTP channel idle out unless something else is using it.
    if (hostId) void rpcResult('ssh.sftpClose', { hostId });
  }, [hostId]);

  // Follow the terminal: a cd (new OSC 7 report) re-targets the open drawer,
  // or surfaces a catch-up chip when pinned.
  useEffect(() => {
    if (!drawer.open || !liveCwd) return;
    if (drawer.follow) {
      if (drawer.path !== liveCwd && !drawer.loading) void navigate(liveCwd);
    } else if (drawer.path !== null && drawer.path !== liveCwd) {
      setDrawer((d) => (d.drift ? d : { ...d, drift: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCwd, drawer.open, drawer.follow]);

  // Refresh the drawer when an upload into the directory it shows finishes.
  const doneInDrawer = transfers.some(
    (t) =>
      t.status === 'done' &&
      t.direction === 'upload' &&
      t.hostId === hostId &&
      drawer.open &&
      toast?.transferIds.includes(t.transferId) &&
      toast.remoteDir === drawer.path,
  );
  useEffect(() => {
    if (doneInDrawer && drawer.path) void navigate(drawer.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneInDrawer]);

  // Sessions change under the layer (dock switch, exit) — drop stale UI.
  useEffect(() => {
    setToast(null);
    setDrawer((d) => (d.open ? { ...DRAWER_CLOSED, follow: d.follow } : d));
    setDragDepth(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  // ---------------------------------------------------------------------
  // Drop handling

  const acceptDrops = Boolean(remote && item && !item.exited);

  const dragProps = useMemo(
    () => ({
      onDragEnter: (e: React.DragEvent) => {
        if (!acceptDrops || !dragHasFiles(e)) return;
        e.preventDefault();
        setDragDepth((n) => n + 1);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!acceptDrops || !dragHasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!acceptDrops || !dragHasFiles(e)) return;
        setDragDepth((n) => Math.max(0, n - 1));
      },
      onDrop: (e: React.DragEvent) => {
        if (!acceptDrops || !dragHasFiles(e)) return;
        e.preventDefault();
        setDragDepth(0);
        const paths = [...e.dataTransfer.files]
          .map((f) => pathForDroppedFile(f))
          .filter((p): p is string => Boolean(p));
        if (paths.length === 0) return;
        if (e.altKey) {
          paste(
            paths.map(shellQuotePath).join(' '),
            'Local path pasted into the terminal — nothing was uploaded.',
          );
          return;
        }
        if (e.shiftKey) {
          setDrawer((d) => ({
            ...DRAWER_CLOSED,
            follow: d.follow,
            open: true,
            loading: true,
            pendingUpload: paths,
          }));
          void navigate(targetCwd);
          return;
        }
        void startUpload(paths, targetCwd);
      },
    }),
    [acceptDrops, targetCwd, paste, startUpload, navigate],
  );

  // ---------------------------------------------------------------------

  if (!remote || !item) {
    return { dragProps, layer: null, openDrawer, drawerOpen: false };
  }

  const toastTransfers = toast
    ? transfers.filter((t) => toast.transferIds.includes(t.transferId))
    : [];

  const layer = (
    <>
      {dragging && acceptDrops ? (
        <div className="rfl-veil" data-testid="remote-drop-veil">
          <div className="rfl-veil-card">
            <span className="rfl-veil-icon">
              <Ic name="arrowUp" size={22} />
            </span>
            <strong>
              Upload to <em data-i18n-ignore>{remote.hostLabel}</em>
            </strong>
            <span className="rfl-veil-target">
              <span>Target directory</span>
              <b data-i18n-ignore>{compactTerminalPath(targetCwd)}</b>
              {item.liveCwd ? <i className="rfl-live">LIVE</i> : null}
            </span>
            <span className="rfl-veil-hints">
              <span>Release to upload</span>
              <span>
                <kbd>⌥</kbd> paste local path
              </span>
              <span>
                <kbd>⇧</kbd> choose directory
              </span>
            </span>
          </div>
        </div>
      ) : null}

      {toast && !toast.dismissed && toastTransfers.length > 0 ? (
        <UploadToast
          transfers={toastTransfers}
          rates={rates}
          remoteDir={toast.remoteDir}
          onDismiss={() => setToast((t) => (t ? { ...t, dismissed: true } : t))}
          onInsertPath={() => {
            const done = toastTransfers.filter((t) => t.status === 'done');
            if (done.length === 0) return;
            paste(
              done.map((t) => shellQuotePath(remoteJoin(toast.remoteDir, t.name))).join(' '),
              'Remote path pasted into the terminal — Enter was not pressed.',
            );
            setToast((t) => (t ? { ...t, dismissed: true } : t));
          }}
          onOpenDrawer={() => {
            setToast((t) => (t ? { ...t, dismissed: true } : t));
            setDrawer((d) => ({ ...DRAWER_CLOSED, follow: false, open: true, loading: true }));
            void navigate(toast.remoteDir);
          }}
        />
      ) : null}

      {actionNote ? (
        <div className="rfl-note" role="status">
          {actionNote}
        </div>
      ) : null}

      {drawer.open ? (
        <RemoteFilesDrawer
          hostId={remote.hostId}
          hostLabel={remote.hostLabel}
          state={drawer}
          liveCwd={item.liveCwd}
          onNavigate={(p) => void navigate(p)}
          onClose={closeDrawer}
          onToggleFollow={() => {
            setDrawer((d) => {
              const follow = !d.follow;
              if (follow && liveCwd && d.path !== liveCwd) void navigate(liveCwd);
              return { ...d, follow, drift: follow ? false : d.drift };
            });
          }}
          onCatchUp={() => {
            if (liveCwd) void navigate(liveCwd);
          }}
          onUploadHere={(paths) => {
            if (!drawer.path) return;
            setDrawer((d) => ({ ...d, pendingUpload: null }));
            void startUpload(paths, drawer.path);
          }}
          onCancelPending={() => setDrawer((d) => ({ ...d, pendingUpload: null }))}
          onPickFiles={(paths) => {
            if (drawer.path && paths.length > 0) void startUpload(paths, drawer.path);
          }}
          onDownload={(entry) => {
            if (!drawer.path) return;
            void rpcResult('ssh.sftpDownload', {
              hostId: remote.hostId,
              remotePath: remoteJoin(drawer.path, entry.name),
              name: entry.name,
            }).then((res) => {
              if (res.ok && res.data.transferId) {
                setToast({
                  transferIds: [res.data.transferId],
                  remoteDir: drawer.path!,
                  hostId: remote.hostId,
                  dismissed: false,
                });
              }
            });
          }}
        />
      ) : null}
    </>
  );

  return { dragProps, layer, openDrawer, drawerOpen: drawer.open };
}

// ---------------------------------------------------------------------------

function UploadToast(props: {
  transfers: ReturnType<typeof useSftpStore.getState>['transfers'];
  rates: ReturnType<typeof useSftpStore.getState>['rates'];
  remoteDir: string;
  onDismiss: () => void;
  onInsertPath: () => void;
  onOpenDrawer: () => void;
}): React.JSX.Element {
  const { transfers, rates, remoteDir, onDismiss, onInsertPath, onOpenDrawer } = props;
  const running = transfers.filter((t) => t.status === 'running');
  const failed = transfers.filter((t) => t.status === 'error');
  const done = transfers.filter((t) => t.status === 'done');
  const allSettled = running.length === 0;
  const uploads = transfers.some((t) => t.direction === 'upload');

  // Linger briefly once everything settled, then get out of the way.
  useEffect(() => {
    if (!allSettled || failed.length > 0) return;
    const timer = window.setTimeout(onDismiss, 8000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSettled, failed.length]);

  const totals = running.filter((t) => t.totalBytes && t.totalBytes > 0);
  const pct =
    totals.length > 0
      ? Math.min(
          100,
          Math.round(
            (totals.reduce((n, t) => n + t.doneBytes, 0) /
              totals.reduce((n, t) => n + (t.totalBytes ?? 0), 0)) *
              100,
          ),
        )
      : null;
  const rate = running.reduce((n, t) => n + (rates[t.transferId]?.bytesPerSec ?? 0), 0);

  return (
    <div className="rfl-toast" data-testid="remote-upload-toast">
      <div className="rfl-toast-head">
        {allSettled ? (
          <span className={`rfl-toast-state ${failed.length > 0 ? 'failed' : 'done'}`}>
            {failed.length > 0 ? '!' : '✓'}
          </span>
        ) : (
          <span className="rfl-toast-state running">
            {transfers[0]?.direction === 'download' ? '↓' : '↑'}
          </span>
        )}
        {transfers.length === 1 ? (
          <strong data-i18n-ignore>{transfers[0]!.name}</strong>
        ) : (
          <strong>{`${transfers.length} files`}</strong>
        )}
        <button className="rfl-x" aria-label="Dismiss" onClick={onDismiss}>
          ✕
        </button>
      </div>
      <div className="rfl-toast-meta">
        <span data-i18n-ignore>→ {compactTerminalPath(remoteDir)}</span>
        <span data-i18n-ignore>
          {allSettled
            ? failed.length > 0
              ? (failed[0]!.error ?? 'failed')
              : ''
            : `${pct !== null ? `${pct}%` : ''}${rate > 0 ? ` · ${formatBytes(rate)}/s` : ''}`}
        </span>
      </div>
      {!allSettled ? (
        <div className="rfl-bar">
          <i
            className={pct === null ? 'indeterminate' : ''}
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </div>
      ) : null}
      {allSettled ? (
        <div className="rfl-toast-actions">
          {done.length > 0 && uploads ? (
            <button data-testid="toast-insert-path" onClick={onInsertPath}>
              Paste remote path
            </button>
          ) : null}
          <button data-testid="toast-open-drawer" onClick={onOpenDrawer}>
            Open in Files
          </button>
        </div>
      ) : (
        <div className="rfl-toast-actions">
          <button
            onClick={() => {
              for (const t of running) useSftpStore.getState().cancel(t.transferId);
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RemoteFilesDrawer(props: {
  hostId: string;
  hostLabel: string;
  state: DrawerState;
  liveCwd: string | null;
  onNavigate: (path: string) => void;
  onClose: () => void;
  onToggleFollow: () => void;
  onCatchUp: () => void;
  onUploadHere: (paths: string[]) => void;
  onCancelPending: () => void;
  onPickFiles: (paths: string[]) => void;
  onDownload: (entry: SftpEntry) => void;
}): React.JSX.Element {
  const {
    hostLabel,
    state,
    liveCwd,
    onNavigate,
    onClose,
    onToggleFollow,
    onCatchUp,
    onUploadHere,
    onCancelPending,
    onPickFiles,
    onDownload,
  } = props;
  const fileInput = useRef<HTMLInputElement>(null);

  const entries = useMemo(
    () =>
      [...state.entries].sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      ),
    [state.entries],
  );
  const atRoot = state.path === '/' || state.path === null;

  return (
    <aside className="rfl-drawer" data-testid="remote-files-drawer" aria-label="Remote files">
      <header>
        <div className="rfl-drawer-title">
          <Ic name="folder-open" size={14} />
          <strong>
            <span>Files</span>
            {' · '}
            <em data-i18n-ignore>{hostLabel}</em>
          </strong>
          <span className="rfl-drawer-proto">SFTP</span>
          <button className="rfl-x" aria-label="Close files drawer" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="rfl-drawer-pathrow">
          <span className="rfl-drawer-path mono" title={state.path ?? ''}>
            {state.path ? compactTerminalPath(state.path) : '…'}
          </span>
          {state.drift && liveCwd ? (
            <button
              className="rfl-drift"
              data-testid="drawer-catch-up"
              title={`Terminal moved to ${liveCwd}`}
              onClick={onCatchUp}
            >
              Terminal cd → follow
            </button>
          ) : null}
          <button
            className={`rfl-follow ${state.follow ? 'on' : ''}`}
            data-testid="drawer-follow-toggle"
            title={
              state.follow
                ? 'Following the terminal directory — click to pin'
                : 'Pinned — click to follow the terminal directory'
            }
            onClick={onToggleFollow}
          >
            <Ic name="pin" size={11} /> {state.follow ? 'Follow terminal' : 'Pinned'}
          </button>
        </div>
      </header>

      {state.pendingUpload ? (
        <div className="rfl-pending" data-testid="drawer-pending-upload">
          <span>
            {state.pendingUpload.length === 1
              ? 'Upload 1 file to this directory?'
              : `Upload ${state.pendingUpload.length} files to this directory?`}
          </span>
          <button className="primary" onClick={() => onUploadHere(state.pendingUpload!)}>
            Upload here
          </button>
          <button onClick={onCancelPending}>Cancel</button>
        </div>
      ) : null}

      {state.error ? <div className="rfl-error">{state.error}</div> : null}

      <div className="rfl-list" role="list">
        {!atRoot && state.path ? (
          <button
            className="rfl-row up"
            role="listitem"
            onClick={() => onNavigate(remoteParent(state.path!))}
          >
            <span className="rfl-row-icon">↩</span>
            <span className="rfl-row-name mono">..</span>
          </button>
        ) : null}
        {state.loading && entries.length === 0 ? (
          <div className="rfl-empty">Loading…</div>
        ) : entries.length === 0 && !state.error ? (
          <div className="rfl-empty">Empty directory</div>
        ) : (
          entries.map((entry) => (
            <div className="rfl-row" role="listitem" key={entry.name}>
              <span className="rfl-row-icon">
                {entry.type === 'dir' ? <Ic name="folder" size={13} /> : null}
              </span>
              {entry.type === 'dir' ? (
                <button
                  className="rfl-row-name mono"
                  onClick={() => state.path && onNavigate(remoteJoin(state.path, entry.name))}
                >
                  {entry.name}/
                </button>
              ) : (
                <span className="rfl-row-name mono">{entry.name}</span>
              )}
              <span className="rfl-row-size mono">
                {entry.type === 'dir' ? '' : formatBytes(entry.size)}
              </span>
              {entry.type !== 'dir' ? (
                <span className="rfl-row-actions">
                  <button
                    data-testid={`drawer-download-${entry.name}`}
                    title={`Download ${entry.name}`}
                    onClick={() => onDownload(entry)}
                  >
                    Download
                  </button>
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>

      <footer>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const paths = [...(e.target.files ?? [])]
              .map((f) => pathForDroppedFile(f))
              .filter((p): p is string => Boolean(p));
            e.target.value = '';
            onPickFiles(paths);
          }}
        />
        <button
          className="rfl-upload"
          data-testid="drawer-upload"
          disabled={!state.path}
          onClick={() => fileInput.current?.click()}
        >
          <Ic name="arrowUp" size={12} /> Upload files…
        </button>
        <span className="rfl-foot-hint">Drops on the terminal land here too</span>
      </footer>
    </aside>
  );
}
