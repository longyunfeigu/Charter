import { basename, extname, join } from 'node:path';
import { stat as fsStat } from 'node:fs/promises';
import { newId, type Logger } from '@pi-ide/foundation';
import { sftpJoin, type SftpSession } from '@pi-ide/ssh-service';
import type { SftpEntry, SftpTransferState } from '@pi-ide/ipc-contracts';

/** Progress ticks per transfer are throttled to this cadence; terminal states
 * (done / error / canceled) always emit immediately. */
const PROGRESS_TICK_MS = 150;
/** Idle SFTP channels are closed so the connection can idle out even if the
 * renderer never sends sftpClose (crash, hard reload). */
const SESSION_IDLE_MS = 120_000;
/** A panel close defers teardown this long so a StrictMode remount / quick
 * reopen reuses the live channel instead of racing a close against a fresh
 * open (which would surface as a spurious "No response from server"). */
const CLOSE_GRACE_MS = 400;
/** Recursive delete refuses beyond these bounds — a remote rm -rf is a shell
 * job, not a file-panel click. */
const MAX_DELETE_ENTRIES = 2000;
const MAX_DELETE_DEPTH = 16;
/** Terminal transfers stay retryable this long (endpoints live only here —
 * the renderer's Transfer Center sends back just the transferId). */
const RETRY_RETENTION_MS = 10 * 60_000;

export interface SshSftpServiceDeps {
  /** Opens (and connects if needed) an SFTP channel for the host. */
  openSession(hostId: string): Promise<SftpSession>;
  /** Pick a local destination; null = user dismissed the dialog. */
  chooseSavePath(suggestedName: string): Promise<string | null>;
  /** ssh.sftpProgress broadcast. */
  emit(state: SftpTransferState): void;
  logger: Logger;
  sessionIdleMs?: number;
  /** Teardown grace after a panel close (tests shorten it). */
  closeGraceMs?: number;
}

interface Transfer {
  controller: AbortController;
  state: SftpTransferState;
  lastTick: number;
  /** Original endpoints, kept main-side for ssh.sftpRetry. */
  params:
    | { direction: 'upload'; localPath: string; remotePath: string }
    | { direction: 'download'; remotePath: string; localPath: string };
}

/**
 * SFTP orchestration for the Files panel (PR2, ADR-0047). One cached SFTP
 * channel per host; every file byte streams fs↔sftp inside this process — the
 * renderer only ever sees listings, names and progress numbers.
 */
export class SshSftpService {
  private readonly sessions = new Map<string, Promise<SftpSession>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly closeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly transfers = new Map<string, Transfer>();
  private readonly sessionIdleMs: number;
  private readonly closeGraceMs: number;

  constructor(private readonly deps: SshSftpServiceDeps) {
    this.sessionIdleMs = deps.sessionIdleMs ?? SESSION_IDLE_MS;
    this.closeGraceMs = deps.closeGraceMs ?? CLOSE_GRACE_MS;
  }

  // -------------------------------------------------------------------------
  // Directory operations

  async home(hostId: string): Promise<string> {
    return (await this.session(hostId)).realpath('.');
  }

  async list(hostId: string, path: string): Promise<{ path: string; entries: SftpEntry[] }> {
    const session = await this.session(hostId);
    const resolved = await session.realpath(path);
    const entries = await session.list(resolved);
    return {
      path: resolved,
      entries: entries.map((e) => ({
        name: e.name,
        type: e.type,
        symlink: e.symlink,
        size: e.size,
        mtimeMs: e.mtimeMs,
      })),
    };
  }

  async mkdir(hostId: string, path: string): Promise<void> {
    await (await this.session(hostId)).mkdir(path);
  }

  async rename(hostId: string, from: string, to: string): Promise<void> {
    await (await this.session(hostId)).rename(from, to);
  }

  async delete(hostId: string, path: string, type: 'file' | 'dir'): Promise<void> {
    const session = await this.session(hostId);
    if (type === 'file') {
      await session.delete(path);
      return;
    }
    const budget = { entries: 0 };
    await this.deleteDir(session, path, budget, 0);
  }

  private async deleteDir(
    session: SftpSession,
    path: string,
    budget: { entries: number },
    depth: number,
  ): Promise<void> {
    if (depth > MAX_DELETE_DEPTH) throw new Error('Directory tree is too deep to delete here');
    const entries = await session.list(path);
    for (const entry of entries) {
      budget.entries += 1;
      if (budget.entries > MAX_DELETE_ENTRIES) {
        throw new Error(
          `Refusing to delete more than ${MAX_DELETE_ENTRIES} entries — use a shell for bulk removal`,
        );
      }
      const child = sftpJoin(path, entry.name);
      // A symlink to a directory is unlinked, never followed — deleting through
      // links from a file panel is how people lose /home.
      if (entry.type === 'dir' && !entry.symlink)
        await this.deleteDir(session, child, budget, depth + 1);
      else await session.delete(child);
    }
    await session.rmdir(path);
  }

  // -------------------------------------------------------------------------
  // Transfers

  async upload(hostId: string, remoteDir: string, localPaths: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const localPath of localPaths) {
      const name = basename(localPath) || localPath;
      const transfer = this.begin(hostId, 'upload', name, {
        direction: 'upload',
        localPath,
        remotePath: sftpJoin(remoteDir, name),
      });
      ids.push(transfer.state.transferId);
      void this.runUpload(transfer, localPath, transfer.params.remotePath);
    }
    return ids;
  }

  private async runUpload(
    transfer: Transfer,
    localPath: string,
    remotePath: string,
  ): Promise<void> {
    try {
      const info = await fsStat(localPath);
      if (info.isDirectory()) {
        throw new Error('Folders cannot be uploaded yet — drop files instead');
      }
      transfer.state.totalBytes = info.size;
      const session = await this.session(transfer.state.hostId);
      await session.upload(localPath, remotePath, {
        signal: transfer.controller.signal,
        onProgress: (done, total) => {
          transfer.state.doneBytes = done;
          transfer.state.totalBytes = total;
          this.emit(transfer, { force: false });
        },
      });
      this.finish(transfer, 'done', null);
    } catch (err) {
      this.finish(
        transfer,
        transfer.controller.signal.aborted ? 'canceled' : 'error',
        transfer.controller.signal.aborted ? null : errorMessage(err),
      );
    }
  }

  /** localDir set = dual-pane target (collisions uniquified, no dialog);
   * otherwise the OS save dialog picks. null transferId = user dismissed. */
  async download(
    hostId: string,
    remotePath: string,
    name: string,
    localDir?: string,
  ): Promise<string | null> {
    const localPath = localDir
      ? await this.uniqueLocalPath(localDir, name)
      : await this.deps.chooseSavePath(name);
    if (!localPath) return null;
    const transfer = this.begin(hostId, 'download', basename(localPath), {
      direction: 'download',
      remotePath,
      localPath,
    });
    void this.runDownload(transfer, remotePath, localPath);
    return transfer.state.transferId;
  }

  private async runDownload(
    transfer: Transfer,
    remotePath: string,
    localPath: string,
  ): Promise<void> {
    try {
      const session = await this.session(transfer.state.hostId);
      await session.download(remotePath, localPath, {
        signal: transfer.controller.signal,
        onProgress: (done, total) => {
          transfer.state.doneBytes = done;
          transfer.state.totalBytes = total;
          this.emit(transfer, { force: false });
        },
      });
      this.finish(transfer, 'done', null);
    } catch (err) {
      this.finish(
        transfer,
        transfer.controller.signal.aborted ? 'canceled' : 'error',
        transfer.controller.signal.aborted ? null : errorMessage(err),
      );
    }
  }

  cancel(transferId: string): boolean {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.state.status !== 'running') return false;
    transfer.controller.abort();
    return true;
  }

  /** Re-run a finished/failed transfer with its retained endpoints. Returns
   * the fresh transferId, or null when unknown or still running. */
  retry(transferId: string): string | null {
    const prev = this.transfers.get(transferId);
    if (!prev || prev.state.status === 'running') return null;
    const transfer = this.begin(prev.state.hostId, prev.params.direction, prev.state.name, {
      ...prev.params,
    });
    if (transfer.params.direction === 'upload') {
      void this.runUpload(transfer, transfer.params.localPath, transfer.params.remotePath);
    } else {
      void this.runDownload(transfer, transfer.params.remotePath, transfer.params.localPath);
    }
    return transfer.state.transferId;
  }

  /** Register + announce a new running transfer. */
  private begin(
    hostId: string,
    direction: 'upload' | 'download',
    name: string,
    params: Transfer['params'],
  ): Transfer {
    const transfer: Transfer = {
      controller: new AbortController(),
      lastTick: 0,
      params,
      state: {
        transferId: newId(direction === 'upload' ? 'sftpup' : 'sftpdl'),
        hostId,
        direction,
        name,
        doneBytes: 0,
        totalBytes: null,
        status: 'running',
        error: null,
      },
    };
    this.transfers.set(transfer.state.transferId, transfer);
    this.emit(transfer, { force: true });
    return transfer;
  }

  /** First free of "name", "name (1)", … in dir — a dual-pane download never
   * silently overwrites a local file. */
  private async uniqueLocalPath(dir: string, name: string): Promise<string> {
    const info = await fsStat(dir);
    if (!info.isDirectory()) throw new Error('Download target is not a directory');
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let i = 0; i < 1000; i++) {
      const candidate = join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
      const taken = await fsStat(candidate).then(
        () => true,
        () => false,
      );
      if (!taken) return candidate;
    }
    throw new Error('Too many name collisions in the download directory');
  }

  // -------------------------------------------------------------------------
  // Session cache

  /** Renderer panel closed — defer the teardown briefly so a StrictMode
   * remount / quick reopen reuses the live channel; a genuine close then
   * releases the SFTP hold and lets the connection idle out. */
  async close(hostId: string): Promise<void> {
    this.clearCloseTimer(hostId);
    const timer = setTimeout(() => {
      this.closeTimers.delete(hostId);
      void this.closeNow(hostId);
    }, this.closeGraceMs);
    timer.unref?.();
    this.closeTimers.set(hostId, timer);
  }

  private async closeNow(hostId: string, opts: { force?: boolean } = {}): Promise<void> {
    // A running transfer owns the channel: closing the Files panel must not
    // kill a long download/upload mid-flight. Hand teardown to the idle cycle,
    // which re-arms itself while transfers are running (see touchIdle).
    if (!opts.force) {
      const hasRunning = [...this.transfers.values()].some(
        (t) => t.state.hostId === hostId && t.state.status === 'running',
      );
      if (hasRunning) {
        this.touchIdle(hostId);
        return;
      }
    }
    const cached = this.sessions.get(hostId);
    this.sessions.delete(hostId);
    this.clearIdle(hostId);
    if (cached) (await cached.catch(() => null))?.close();
  }

  private clearCloseTimer(hostId: string): void {
    const timer = this.closeTimers.get(hostId);
    if (timer) {
      clearTimeout(timer);
      this.closeTimers.delete(hostId);
    }
  }

  closeAll(): void {
    for (const timer of this.closeTimers.values()) clearTimeout(timer);
    this.closeTimers.clear();
    // Quit is the one caller allowed to cut running transfers: abort first so
    // the forced teardown below never races a transfer that could re-arm idle.
    for (const transfer of this.transfers.values()) {
      if (transfer.state.status === 'running') transfer.controller.abort();
    }
    for (const hostId of [...this.sessions.keys()]) void this.closeNow(hostId, { force: true });
  }

  private session(hostId: string): Promise<SftpSession> {
    // A reopen (or any op) cancels a pending panel-close teardown.
    this.clearCloseTimer(hostId);
    this.touchIdle(hostId);
    let cached = this.sessions.get(hostId);
    if (!cached) {
      const promise = this.deps.openSession(hostId).then((session) => {
        session.onClose(() => {
          if (this.sessions.get(hostId) === promise) {
            this.sessions.delete(hostId);
            this.clearIdle(hostId);
          }
        });
        return session;
      });
      promise.catch(() => {
        if (this.sessions.get(hostId) === promise) {
          this.sessions.delete(hostId);
          this.clearIdle(hostId);
        }
      });
      this.sessions.set(hostId, promise);
      cached = promise;
    }
    return cached;
  }

  private touchIdle(hostId: string): void {
    this.clearIdle(hostId);
    const timer = setTimeout(() => {
      this.idleTimers.delete(hostId);
      const hasRunning = [...this.transfers.values()].some(
        (t) => t.state.hostId === hostId && t.state.status === 'running',
      );
      if (hasRunning) this.touchIdle(hostId);
      else void this.closeNow(hostId);
    }, this.sessionIdleMs);
    timer.unref?.();
    this.idleTimers.set(hostId, timer);
  }

  private clearIdle(hostId: string): void {
    const timer = this.idleTimers.get(hostId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(hostId);
    }
  }

  // -------------------------------------------------------------------------

  private finish(transfer: Transfer, status: 'done' | 'error' | 'canceled', error: string | null) {
    if (transfer.state.status !== 'running') return;
    transfer.state.status = status;
    transfer.state.error = error;
    if (status === 'done' && transfer.state.totalBytes !== null) {
      transfer.state.doneBytes = transfer.state.totalBytes;
    }
    this.emit(transfer, { force: true });
    if (status === 'error') {
      this.deps.logger.warn('sftp transfer failed', {
        hostId: transfer.state.hostId,
        direction: transfer.state.direction,
        name: transfer.state.name,
        error,
      });
    }
    // Keep terminal states around so the Transfer Center can retry with the
    // retained endpoints; then drop the bookkeeping.
    setTimeout(
      () => this.transfers.delete(transfer.state.transferId),
      RETRY_RETENTION_MS,
    ).unref?.();
  }

  private emit(transfer: Transfer, opts: { force: boolean }): void {
    const now = Date.now();
    if (!opts.force && now - transfer.lastTick < PROGRESS_TICK_MS) return;
    transfer.lastTick = now;
    this.deps.emit({ ...transfer.state });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
