import { create } from 'zustand';
import type { SftpEntry, SftpTransferState } from '@pi-ide/ipc-contracts';
import { onEvent, rpcResult } from '../bridge.js';

/** POSIX join for remote paths (SFTP is always forward-slash). */
export function remoteJoin(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export function remoteParent(path: string): string {
  if (path === '/' || !path.includes('/')) return path;
  const parent = path.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  return parent || '/';
}

/** Local paths keep the platform separator the main process handed us. */
function localSep(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

export function localJoin(dir: string, name: string): string {
  const sep = localSep(dir);
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function localParent(path: string): string {
  const sep = localSep(path);
  const trimmed = path.replace(new RegExp(`\\${sep}+$`), '');
  const idx = trimmed.lastIndexOf(sep);
  if (idx < 0) return path;
  const parent = trimmed.slice(0, idx);
  if (!parent) return sep === '/' ? '/' : trimmed.slice(0, idx + 1); // "/" root
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent; // "C:\" root
}

/** Smoothed transfer speed, computed renderer-side from progress deltas. */
export interface TransferRate {
  ts: number;
  bytes: number;
  bytesPerSec: number;
}

interface SftpStore {
  /** Host whose Files panel is open; null = closed. */
  hostId: string | null;
  path: string;
  /** Server-resolved home of the open host — lets the path bar expand ~. */
  remoteHome: string;
  entries: SftpEntry[];
  loading: boolean;
  error: string | null;
  /** Local pane (This Mac) of the dual-pane panel. */
  localPath: string;
  localEntries: SftpEntry[];
  localLoading: boolean;
  localError: string | null;
  /** Newest-first, cross-host; rows linger until dismissed / cleared. */
  transfers: SftpTransferState[];
  rates: Record<string, TransferRate>;
  initialized: boolean;
  /** Bumped on every open()/close(); a stale async result (e.g. a StrictMode
   * double-mount's first, torn-down open) must not clobber the live panel. */
  epoch: number;

  open(hostId: string): Promise<void>;
  close(): void;
  navigate(path: string): Promise<void>;
  refresh(): Promise<void>;
  navigateLocal(path: string): Promise<void>;
  refreshLocal(): Promise<void>;
  mkdir(name: string): Promise<string | null>;
  rename(from: string, toName: string): Promise<string | null>;
  remove(entry: SftpEntry): Promise<string | null>;
  upload(localPaths: string[]): Promise<void>;
  /** ADR-0059: upload to an explicit host + directory without opening the
   * panel (terminal drop, Files drawer). Returns the transferIds so the
   * caller can follow just its own transfers; progress still streams through
   * ssh.sftpProgress into `transfers` (and the Transfer Center). */
  uploadTo(hostId: string, remoteDir: string, localPaths: string[]): Promise<string[]>;
  /** Dual-pane download: lands in the local pane's current directory. */
  download(entries: SftpEntry[]): Promise<void>;
  cancel(transferId: string): void;
  retry(transferId: string): Promise<void>;
  dismissTransfer(transferId: string): void;
  clearFinished(): void;
}

const MAX_TRANSFER_ROWS = 50;

export const useSftpStore = create<SftpStore>((set, get) => {
  function ensureInit(): void {
    if (get().initialized) return;
    set({ initialized: true });
    onEvent('ssh.sftpProgress', (state) => {
      set((s) => {
        const idx = s.transfers.findIndex((t) => t.transferId === state.transferId);
        const transfers =
          idx >= 0
            ? s.transfers.map((t) => (t.transferId === state.transferId ? state : t))
            : [state, ...s.transfers].slice(0, MAX_TRANSFER_ROWS);
        // Exponentially-smoothed rate from progress deltas (running only).
        const rates = { ...s.rates };
        if (state.status === 'running') {
          const prev = rates[state.transferId];
          const now = Date.now();
          if (prev && now > prev.ts && state.doneBytes >= prev.bytes) {
            const instant = ((state.doneBytes - prev.bytes) / (now - prev.ts)) * 1000;
            rates[state.transferId] = {
              ts: now,
              bytes: state.doneBytes,
              bytesPerSec: prev.bytesPerSec > 0 ? prev.bytesPerSec * 0.6 + instant * 0.4 : instant,
            };
          } else if (!prev) {
            rates[state.transferId] = { ts: now, bytes: state.doneBytes, bytesPerSec: 0 };
          }
        } else {
          delete rates[state.transferId];
        }
        return { transfers, rates };
      });
      // A finished transfer should show up in the pane it landed in.
      if (state.status === 'done' && state.hostId === get().hostId) {
        if (state.direction === 'upload') void get().refresh();
        else void get().refreshLocal();
      }
    });
  }

  /** Still the current open? (same host, no newer open()/close() since). */
  function current(hostId: string, epoch: number): boolean {
    const s = get();
    return s.hostId === hostId && s.epoch === epoch;
  }

  async function list(hostId: string, path: string, epoch: number): Promise<void> {
    set({ loading: true, error: null });
    const res = await rpcResult('ssh.sftpList', { hostId, path });
    if (!current(hostId, epoch)) return; // panel moved on / was superseded
    if (res.ok) {
      set({ path: res.data.path, entries: res.data.entries, loading: false });
    } else {
      set({ loading: false, error: res.error.userMessage });
    }
  }

  async function listLocal(path: string, epoch: number): Promise<void> {
    set({ localLoading: true, localError: null });
    const res = await rpcResult('ssh.localList', { path });
    if (get().epoch !== epoch) return;
    if (res.ok) {
      set({ localPath: res.data.path, localEntries: res.data.entries, localLoading: false });
    } else {
      set({ localLoading: false, localError: res.error.userMessage });
    }
  }

  return {
    hostId: null,
    path: '/',
    remoteHome: '',
    entries: [],
    loading: false,
    error: null,
    localPath: '',
    localEntries: [],
    localLoading: false,
    localError: null,
    transfers: [],
    rates: {},
    initialized: false,
    epoch: 0,

    async open(hostId) {
      ensureInit();
      const epoch = get().epoch + 1;
      set({ epoch, hostId, entries: [], loading: true, error: null });
      // Local pane resolves independently — keep the last browsed directory
      // across panel opens; fall back to the OS home.
      const localStart = get().localPath;
      void (async () => {
        if (localStart) return listLocal(localStart, epoch);
        const home = await rpcResult('ssh.localHome', {});
        if (get().epoch !== epoch) return;
        if (home.ok) await listLocal(home.data.path, epoch);
        else set({ localError: home.error.userMessage });
      })();
      const home = await rpcResult('ssh.sftpHome', { hostId });
      if (!current(hostId, epoch)) return;
      if (!home.ok) {
        set({ loading: false, error: home.error.userMessage });
        return;
      }
      set({ remoteHome: home.data.path });
      await list(hostId, home.data.path, epoch);
    },

    close() {
      const hostId = get().hostId;
      set((s) => ({ epoch: s.epoch + 1, hostId: null, entries: [], error: null, loading: false }));
      // Release the SFTP channel so the connection can idle out.
      if (hostId) void rpcResult('ssh.sftpClose', { hostId });
    },

    async navigate(path) {
      const { hostId, epoch } = get();
      if (hostId) await list(hostId, path, epoch);
    },

    async refresh() {
      const { hostId, path, epoch } = get();
      if (hostId) await list(hostId, path, epoch);
    },

    async navigateLocal(path) {
      await listLocal(path, get().epoch);
    },

    async refreshLocal() {
      const { localPath, epoch } = get();
      if (localPath) await listLocal(localPath, epoch);
    },

    async mkdir(name) {
      const { hostId, path } = get();
      if (!hostId) return 'No host open';
      const res = await rpcResult('ssh.sftpMkdir', { hostId, path: remoteJoin(path, name) });
      if (!res.ok) return res.error.userMessage;
      await get().refresh();
      return null;
    },

    async rename(from, toName) {
      const { hostId, path } = get();
      if (!hostId) return 'No host open';
      const res = await rpcResult('ssh.sftpRename', {
        hostId,
        from,
        to: remoteJoin(path, toName),
      });
      if (!res.ok) return res.error.userMessage;
      await get().refresh();
      return null;
    },

    async remove(entry) {
      const { hostId, path } = get();
      if (!hostId) return 'No host open';
      const res = await rpcResult('ssh.sftpDelete', {
        hostId,
        path: remoteJoin(path, entry.name),
        type: entry.type === 'dir' && !entry.symlink ? 'dir' : 'file',
      });
      if (!res.ok) return res.error.userMessage;
      await get().refresh();
      return null;
    },

    async upload(localPaths) {
      const { hostId, path } = get();
      if (!hostId || localPaths.length === 0) return;
      await rpcResult('ssh.sftpUpload', { hostId, remoteDir: path, localPaths });
      // Progress (including per-file errors) streams via ssh.sftpProgress.
    },

    async uploadTo(hostId, remoteDir, localPaths) {
      if (localPaths.length === 0) return [];
      ensureInit(); // drop-initiated uploads must land in `transfers` too
      const res = await rpcResult('ssh.sftpUpload', { hostId, remoteDir, localPaths });
      if (!res.ok) throw new Error(res.error.userMessage);
      return res.data.transferIds;
    },

    async download(entries) {
      const { hostId, path, localPath } = get();
      if (!hostId || !localPath) return;
      for (const entry of entries) {
        if (entry.type === 'dir') continue; // folders stay a shell job
        await rpcResult('ssh.sftpDownload', {
          hostId,
          remotePath: remoteJoin(path, entry.name),
          name: entry.name,
          localDir: localPath,
        });
      }
    },

    cancel(transferId) {
      void rpcResult('ssh.sftpCancel', { transferId });
    },

    async retry(transferId) {
      const res = await rpcResult('ssh.sftpRetry', { transferId });
      // The fresh transfer streams in via ssh.sftpProgress; drop the old row.
      if (res.ok && res.data.transferId) get().dismissTransfer(transferId);
    },

    dismissTransfer(transferId) {
      set((s) => ({ transfers: s.transfers.filter((t) => t.transferId !== transferId) }));
    },

    clearFinished() {
      set((s) => ({ transfers: s.transfers.filter((t) => t.status === 'running') }));
    },
  };
});
