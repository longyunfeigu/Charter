import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type {
  LocalTerminalBackendRequest,
  TerminalBackend,
  TerminalInfo,
} from '@pi-ide/terminal-service';
import {
  DaemonMessageDecoder,
  encodeDaemonMessage,
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  type DaemonTerminalMetadata,
  type DaemonTerminalSnapshot,
  type TerminalDaemonEvent,
  type TerminalDaemonRequest,
  type TerminalDaemonRequestInput,
} from './terminal-daemon-protocol.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DaemonListResult {
  sessions: DaemonTerminalSnapshot[];
  hostKind?: string;
  capabilities?: {
    compactList?: boolean;
    snapshotById?: boolean;
  };
}

class DaemonConnectionError extends Error {}

export interface TerminalDaemonClientOptions {
  socketPath: string;
  tokenFile: string;
  launchDaemon: () => void;
}

function metadataFromInfo(info: TerminalInfo): DaemonTerminalMetadata {
  return {
    id: info.id,
    title: info.title,
    shell: info.shell,
    cwd: info.cwd,
    projectName: info.projectName,
    projectPath: info.projectPath,
    contextKind: info.contextKind,
    contextLabel: info.contextLabel,
    contextTaskId: info.contextTaskId,
    launch: info.launch,
  };
}

function daemonIsDefinitelyAbsent(socketPath: string, error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (
    (process.platform !== 'win32' && !existsSync(socketPath)) ||
    code === 'ENOENT' ||
    code === 'ECONNREFUSED'
  );
}

class DaemonTerminalBackend implements TerminalBackend {
  persistent = true as const;
  private dataListener: ((data: string, sequence?: number) => void) | null = null;
  private resyncListener: ((replay: string, sequence: number) => void) | null = null;
  private exitListener: ((exitCode: number) => void) | null = null;
  private currentPid: number;
  private currentTitle: string;
  private currentHasChildren: boolean;
  private currentSequence = 0;
  private replayPending: boolean;

  constructor(
    private readonly client: TerminalDaemonClient,
    readonly id: string,
    status: { pid: number; processTitle: string; hasChildren: boolean; sequence?: number },
    replayPending = false,
  ) {
    this.currentPid = status.pid;
    this.currentTitle = status.processTitle;
    this.currentHasChildren = status.hasChildren;
    this.currentSequence = status.sequence ?? 0;
    this.replayPending = replayPending;
  }

  write(data: string): void {
    void this.client.request({ type: 'write', id: this.id, data }).catch(() => undefined);
  }

  async writeAccepted(data: string): Promise<boolean> {
    try {
      await this.client.request({ type: 'write', id: this.id, data });
      return true;
    } catch {
      return false;
    }
  }

  resize(cols: number, rows: number): void {
    void this.client.request({ type: 'resize', id: this.id, cols, rows }).catch(() => undefined);
  }

  kill(): void {
    void this.client.request({ type: 'kill', id: this.id }).catch(() => undefined);
  }

  detach(): void {
    // The daemon owns the PTY; app shutdown only drops the shared socket.
  }

  hasChildren(): boolean {
    return this.currentHasChildren;
  }

  processTitle(): string | null {
    return this.currentTitle;
  }

  processId(): number {
    return this.currentPid;
  }

  updateMetadata(info: TerminalInfo): void {
    void this.client
      .request({ type: 'updateMetadata', info: metadataFromInfo(info) })
      .catch(() => undefined);
  }

  onData(cb: (data: string, sequence?: number) => void): void {
    this.dataListener = cb;
  }

  onResync(cb: (replay: string, sequence: number) => void): void {
    this.resyncListener = cb;
  }

  onExit(cb: (exitCode: number) => void): void {
    this.exitListener = cb;
  }

  emitData(data: string, sequence: number): void {
    this.currentSequence = Math.max(this.currentSequence, sequence);
    this.dataListener?.(data, sequence);
  }

  emitResync(replay: string, sequence: number): void {
    this.currentSequence = sequence;
    this.resyncListener?.(replay, sequence);
  }

  emitExit(exitCode: number): void {
    this.exitListener?.(exitCode);
  }

  updateStatus(status: { pid: number; processTitle: string; hasChildren: boolean }): void {
    this.currentPid = status.pid;
    this.currentTitle = status.processTitle;
    this.currentHasChildren = status.hasChildren;
  }

  markReplayPending(): void {
    this.replayPending = true;
  }

  applySnapshot(snapshot: DaemonTerminalSnapshot): void {
    this.updateStatus(snapshot);
    if (this.replayPending || snapshot.sequence > this.currentSequence) {
      this.emitResync(snapshot.replay, snapshot.sequence);
    }
    this.replayPending = false;
  }

  sequence(): number {
    return this.currentSequence;
  }
}

export class TerminalDaemonClient {
  private decoder = new DaemonMessageDecoder<TerminalDaemonEvent>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly backends = new Map<string, DaemonTerminalBackend>();
  private readonly snapshots = new Map<string, DaemonTerminalSnapshot>();
  private socket: Socket | null = null;
  private explicitlyClosed = false;
  private reconnecting: Promise<void> | null = null;
  private synchronizing = false;
  private queuedEvents: TerminalDaemonEvent[] = [];
  private snapshotById = false;
  private readonly snapshotRefreshQueue: string[] = [];
  private snapshotRefreshRunning = false;

  private constructor(
    socket: Socket,
    snapshots: DaemonTerminalSnapshot[],
    private readonly options: TerminalDaemonClientOptions,
    private readonly token: string,
  ) {
    for (const snapshot of snapshots) this.snapshots.set(snapshot.info.id, snapshot);
    this.attachSocket(socket);
  }

  static async connect(options: TerminalDaemonClientOptions): Promise<TerminalDaemonClient> {
    mkdirSync(dirname(options.tokenFile), { recursive: true, mode: 0o700 });
    if (!existsSync(options.tokenFile)) {
      writeFileSync(options.tokenFile, `${randomBytes(32).toString('base64url')}\n`, {
        mode: 0o600,
      });
    }
    chmodSync(options.tokenFile, 0o600);
    const token = readFileSync(options.tokenFile, 'utf8').trim();
    let socket: Socket | null = null;
    const deadline = Date.now() + 8000;
    let launchedDaemon = false;
    let lastError: unknown = null;
    while (!socket && Date.now() < deadline) {
      try {
        socket = await TerminalDaemonClient.open(options.socketPath, token, 500);
      } catch (error) {
        lastError = error;
        // A timeout or authentication failure can come from a healthy daemon.
        // Never replace it unless the Unix endpoint is provably stale/absent.
        if (!launchedDaemon && daemonIsDefinitelyAbsent(options.socketPath, error)) {
          options.launchDaemon();
          launchedDaemon = true;
        }
      }
      if (!socket) await new Promise((resolve) => setTimeout(resolve, 80));
    }
    if (!socket)
      throw lastError instanceof Error ? lastError : new Error('Terminal daemon did not start.');

    const bootstrap = new TerminalDaemonClient(socket, [], options, token);
    let result = (await bootstrap.request(
      { type: 'list', includeReplay: false },
      8000,
    )) as DaemonListResult;
    bootstrap.applyCapabilities(result);
    // Early builds hosted the daemon in a second Electron application. Replace
    // that host only when it owns no PTYs; live legacy sessions remain adopted
    // until their next natural restart instead of being interrupted by upgrade.
    if (result.hostKind !== 'run-as-node' && result.sessions.length === 0) {
      await bootstrap.request({ type: 'shutdownIfIdle' }, 2000).catch(() => undefined);
      bootstrap.close();
      await new Promise((resolve) => setTimeout(resolve, 150));
      options.launchDaemon();
      const replacementDeadline = Date.now() + 8000;
      let replacementSocket: Socket | null = null;
      let replacementError: unknown = null;
      while (!replacementSocket && Date.now() < replacementDeadline) {
        try {
          replacementSocket = await TerminalDaemonClient.open(options.socketPath, token, 500);
        } catch (error) {
          replacementError = error;
        }
        if (!replacementSocket) await new Promise((resolve) => setTimeout(resolve, 80));
      }
      if (!replacementSocket) {
        throw replacementError instanceof Error
          ? replacementError
          : new Error('Replacement terminal daemon did not start.');
      }
      const replacement = new TerminalDaemonClient(replacementSocket, [], options, token);
      result = (await replacement.request(
        { type: 'list', includeReplay: false },
        8000,
      )) as DaemonListResult;
      replacement.applyCapabilities(result);
      for (const snapshot of result.sessions) replacement.snapshots.set(snapshot.info.id, snapshot);
      return replacement;
    }
    for (const snapshot of result.sessions) bootstrap.snapshots.set(snapshot.info.id, snapshot);
    return bootstrap;
  }

  restoredSessions(): DaemonTerminalSnapshot[] {
    return [...this.snapshots.values()];
  }

  async currentSnapshots(): Promise<DaemonTerminalSnapshot[]> {
    const result = (await this.request(
      { type: 'list', includeReplay: false },
      8000,
    )) as DaemonListResult;
    this.applyCapabilities(result);
    if (!this.snapshotById) return result.sessions;
    const snapshots: DaemonTerminalSnapshot[] = [];
    for (const descriptor of result.sessions) {
      snapshots.push(await this.fetchSnapshot(descriptor.info.id));
    }
    return snapshots;
  }

  backendForRestored(snapshot: DaemonTerminalSnapshot): TerminalBackend {
    const needsReplay = this.snapshotById && snapshot.replay.length === 0;
    const backend = new DaemonTerminalBackend(this, snapshot.info.id, snapshot, needsReplay);
    this.backends.set(snapshot.info.id, backend);
    // Close the small startup window between the bootstrap snapshot and the
    // backend being adopted by TerminalManager. Resync is registered before
    // this request can resolve, so output produced during app startup is kept.
    if (needsReplay) this.enqueueSnapshotRefresh(snapshot.info.id);
    return backend;
  }

  createBackend(request: LocalTerminalBackendRequest): { backend: TerminalBackend; pid: number } {
    const backend = new DaemonTerminalBackend(this, request.info.id, {
      pid: -1,
      processTitle: request.info.shell,
      hasChildren: false,
    });
    this.backends.set(request.info.id, backend);
    void this.request({
      type: 'spawn',
      info: metadataFromInfo(request.info),
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      cols: request.cols,
      rows: request.rows,
      scrollback: request.scrollback,
    })
      .then((result) => {
        const pid = (result as { pid: number }).pid;
        backend.updateStatus({ pid, processTitle: request.info.shell, hasChildren: false });
      })
      .catch(() => backend.emitExit(1));
    return { backend, pid: -1 };
  }

  async request(request: TerminalDaemonRequestInput, timeoutMs = 5000): Promise<unknown> {
    const requestId = randomUUID();
    const message = { ...request, requestId } as TerminalDaemonRequest;
    const deadline = Date.now() + timeoutMs;
    while (!this.explicitlyClosed) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Terminal daemon request timed out: ${request.type}`);
      }
      const socket = await this.connectedSocket();
      try {
        return await this.sendRequest(socket, message, remaining);
      } catch (error) {
        if (!(error instanceof DaemonConnectionError) || this.explicitlyClosed) throw error;
      }
    }
    throw new Error('Terminal daemon client closed.');
  }

  private async sendRequest(
    socket: Socket,
    message: TerminalDaemonRequest,
    timeoutMs: number,
  ): Promise<unknown> {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(message.requestId);
          reject(new Error(`Terminal daemon request timed out: ${message.type}`));
        },
        Math.max(1, timeoutMs),
      );
      timer.unref();
      this.pending.set(message.requestId, { resolve, reject, timer });
      try {
        socket.write(encodeDaemonMessage(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.requestId);
        reject(new DaemonConnectionError(error instanceof Error ? error.message : String(error)));
      }
    });
  }

  close(): void {
    if (this.explicitlyClosed) return;
    this.explicitlyClosed = true;
    const socket = this.socket;
    this.socket = null;
    socket?.end();
    this.rejectPending('Terminal daemon client closed.');
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    this.decoder = new DaemonMessageDecoder<TerminalDaemonEvent>();
    socket.on('data', (chunk: Buffer) => {
      if (this.socket === socket) this.handleData(socket, chunk);
    });
    socket.on('close', () => {
      if (this.socket === socket) this.handleClose(socket);
    });
    socket.on('error', () => undefined);
  }

  private async connectedSocket(): Promise<Socket> {
    if (this.explicitlyClosed) throw new Error('Terminal daemon client closed.');
    if (this.socket && !this.socket.destroyed && this.socket.writable) return this.socket;
    if (!this.reconnecting) {
      const reconnecting = this.reconnect();
      this.reconnecting = reconnecting;
      void reconnecting.then(
        () => {
          if (this.reconnecting === reconnecting) this.reconnecting = null;
        },
        () => {
          if (this.reconnecting === reconnecting) this.reconnecting = null;
        },
      );
    }
    await this.reconnecting;
    if (this.explicitlyClosed) throw new Error('Terminal daemon client closed.');
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      throw new Error('Terminal daemon is unavailable.');
    }
    return this.socket;
  }

  private async reconnect(): Promise<void> {
    const deadline = Date.now() + 8000;
    const mayLaunchDaemon = this.backends.size === 0 && this.snapshots.size === 0;
    let launchedDaemon = false;
    let lastError: unknown = null;

    while (!this.explicitlyClosed && Date.now() < deadline) {
      let socket: Socket | null = null;
      try {
        socket = await TerminalDaemonClient.open(this.options.socketPath, this.token, 500);
        if (this.explicitlyClosed) {
          socket.destroy();
          throw new Error('Terminal daemon client closed.');
        }
        this.synchronizing = true;
        this.queuedEvents = [];
        this.attachSocket(socket);
        const result = (await this.sendRequest(
          socket,
          { type: 'list', includeReplay: false, requestId: randomUUID() },
          2000,
        )) as DaemonListResult;
        this.applyCapabilities(result);
        this.reconcileBackends(result.sessions, !this.snapshotById);
        this.synchronizing = false;
        this.flushQueuedEvents();
        if (this.snapshotById) {
          for (const snapshot of result.sessions) {
            if (this.backends.has(snapshot.info.id)) this.enqueueSnapshotRefresh(snapshot.info.id);
          }
        }
        return;
      } catch (error) {
        lastError = error;
        this.synchronizing = false;
        this.queuedEvents = [];
        if (socket && this.socket === socket) this.socket = null;
        socket?.destroy();
        this.rejectPending('Terminal daemon connection closed.');
        if (mayLaunchDaemon && !launchedDaemon) {
          launchedDaemon = true;
          this.options.launchDaemon();
        }
      }
      if (!this.explicitlyClosed) await new Promise((resolve) => setTimeout(resolve, 80));
    }

    if (!this.explicitlyClosed) {
      for (const backend of this.backends.values()) backend.emitExit(255);
      this.backends.clear();
      this.snapshots.clear();
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(
          this.explicitlyClosed
            ? 'Terminal daemon client closed.'
            : 'Terminal daemon reconnection timed out.',
        );
  }

  private reconcileBackends(sessions: DaemonTerminalSnapshot[], completeReplay: boolean): void {
    const live = new Map(sessions.map((snapshot) => [snapshot.info.id, snapshot]));
    const queuedExits = new Set(
      this.queuedEvents
        .filter((event) => event.type === 'exit')
        .map((event) => (event.type === 'exit' ? event.id : '')),
    );
    for (const [id, backend] of this.backends) {
      const snapshot = live.get(id);
      if (!snapshot) {
        if (queuedExits.has(id)) continue;
        backend.emitExit(255);
        this.backends.delete(id);
        continue;
      }
      backend.updateStatus(snapshot);
      if (completeReplay && snapshot.sequence > backend.sequence()) backend.applySnapshot(snapshot);
      else if (!completeReplay && snapshot.sequence > backend.sequence())
        backend.markReplayPending();
    }
    this.snapshots.clear();
    for (const snapshot of sessions) this.snapshots.set(snapshot.info.id, snapshot);
  }

  private flushQueuedEvents(): void {
    const queued = this.queuedEvents;
    this.queuedEvents = [];
    for (const event of queued) this.processEvent(event);
  }

  private async refreshBackend(id: string): Promise<void> {
    const snapshot = this.snapshotById
      ? await this.fetchSnapshot(id)
      : ((await this.request({ type: 'list' }, 8000)) as DaemonListResult).sessions.find(
          (candidate) => candidate.info.id === id,
        );
    const backend = this.backends.get(id);
    if (!backend) return;
    if (!snapshot) {
      backend.emitExit(255);
      this.backends.delete(id);
      this.snapshots.delete(id);
      return;
    }
    this.snapshots.set(id, snapshot);
    backend.applySnapshot(snapshot);
  }

  private applyCapabilities(result: DaemonListResult): void {
    this.snapshotById = result.capabilities?.snapshotById === true;
  }

  private async fetchSnapshot(id: string): Promise<DaemonTerminalSnapshot> {
    const result = (await this.request({ type: 'snapshot', id }, 8000)) as {
      session: DaemonTerminalSnapshot;
    };
    return result.session;
  }

  private enqueueSnapshotRefresh(id: string): void {
    if (!this.snapshotById || this.snapshotRefreshQueue.includes(id)) return;
    this.snapshotRefreshQueue.push(id);
    if (this.snapshotRefreshRunning) return;
    this.snapshotRefreshRunning = true;
    void this.drainSnapshotRefreshes();
  }

  private async drainSnapshotRefreshes(): Promise<void> {
    try {
      for (;;) {
        const id = this.snapshotRefreshQueue.shift();
        if (!id || this.explicitlyClosed) return;
        await this.refreshBackend(id).catch(() => undefined);
      }
    } finally {
      this.snapshotRefreshRunning = false;
      if (this.snapshotRefreshQueue.length > 0 && !this.explicitlyClosed) {
        this.enqueueSnapshotRefresh(this.snapshotRefreshQueue.shift()!);
      }
    }
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DaemonConnectionError(message));
    }
    this.pending.clear();
  }

  private static async open(socketPath: string, token: string, timeoutMs: number): Promise<Socket> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connect(socketPath);
      const timer = setTimeout(() => {
        candidate.destroy();
        reject(new Error('Terminal daemon connection timed out.'));
      }, timeoutMs);
      const fail = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };
      candidate.once('error', fail);
      candidate.once('connect', () => {
        clearTimeout(timer);
        candidate.off('error', fail);
        resolve(candidate);
      });
    });
    const decoder = new DaemonMessageDecoder<TerminalDaemonEvent>();
    const requestId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Terminal daemon authentication timed out.'));
      }, timeoutMs);
      const onData = (chunk: Buffer): void => {
        try {
          for (const message of decoder.push(chunk)) {
            if (message.type !== 'response' || message.requestId !== requestId) continue;
            clearTimeout(timer);
            socket.off('data', onData);
            if (message.ok) resolve();
            else {
              socket.destroy();
              reject(new Error(message.error));
            }
          }
        } catch (error) {
          clearTimeout(timer);
          socket.destroy();
          reject(error);
        }
      };
      socket.on('data', onData);
      socket.write(
        encodeDaemonMessage({
          requestId,
          type: 'hello',
          token,
          version: TERMINAL_DAEMON_PROTOCOL_VERSION,
        }),
      );
    });
    return socket;
  }

  private handleData(socket: Socket, chunk: Buffer): void {
    let messages: TerminalDaemonEvent[];
    try {
      messages = this.decoder.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const message of messages) {
      if (message.type === 'response') {
        const pending = this.pending.get(message.requestId);
        if (!pending) continue;
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error));
      } else if (this.synchronizing) {
        this.queuedEvents.push(message);
      } else {
        this.processEvent(message);
      }
    }
  }

  private processEvent(message: TerminalDaemonEvent): void {
    if (message.type === 'response') return;
    if (message.type === 'data') {
      const backend = this.backends.get(message.id);
      if (backend && message.sequence > backend.sequence()) {
        backend.emitData(message.data, message.sequence);
      }
    } else if (message.type === 'exit') {
      this.backends.get(message.id)?.emitExit(message.exitCode);
      this.backends.delete(message.id);
      this.snapshots.delete(message.id);
    } else if (message.type === 'status') {
      this.backends.get(message.id)?.updateStatus(message);
    }
  }

  private handleClose(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.rejectPending('Terminal daemon connection closed.');
    if (!this.explicitlyClosed) void this.connectedSocket().catch(() => undefined);
  }
}
