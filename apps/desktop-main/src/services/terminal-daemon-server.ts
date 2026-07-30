import { timingSafeEqual } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as nodePty from 'node-pty';
import type { IPty } from 'node-pty';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import {
  DaemonMessageDecoder,
  encodeDaemonMessage,
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  type DaemonTerminalMetadata,
  type DaemonTerminalSnapshot,
  type TerminalDaemonEvent,
  type TerminalDaemonRequest,
} from './terminal-daemon-protocol.js';

interface DaemonConnection {
  socket: Socket;
  decoder: DaemonMessageDecoder<TerminalDaemonRequest>;
  authenticated: boolean;
  work: Promise<void>;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hasChildProcesses(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    const result = spawnSync('pgrep', ['-P', String(pid)], { timeout: 1500 });
    return result.status === 0 && result.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

class HostedTerminal {
  readonly emulator: HeadlessTerminal;
  readonly serializer = new SerializeAddon();
  sequence = 0;
  dirty = true;
  private checkpointing = false;
  private exited = false;
  private pendingLog: string[] = [];
  private logTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly info: DaemonTerminalMetadata,
    readonly pty: IPty,
    readonly dir: string,
    scrollback: number,
    private readonly publish: (event: TerminalDaemonEvent) => void,
    private readonly onExit: () => void,
  ) {
    this.emulator = new HeadlessTerminal({
      cols: Math.max(2, pty.cols),
      rows: Math.max(1, pty.rows),
      scrollback: Math.max(100, Math.min(100_000, scrollback)),
      allowProposedApi: true,
    });
    this.emulator.loadAddon(this.serializer);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(dir, 'meta.json'), info);
    pty.onData((data) => this.handleData(data));
    pty.onExit(({ exitCode }) => {
      if (this.exited) return;
      this.exited = true;
      this.publish({ type: 'exit', id: info.id, exitCode });
      this.onExit();
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  get processTitle(): string {
    try {
      return this.pty.process;
    } catch {
      return this.info.shell;
    }
  }

  get hasChildren(): boolean {
    return hasChildProcesses(this.pty.pid);
  }

  write(data: string): void {
    if (!this.exited) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited || cols < 2 || rows < 1 || cols > 1000 || rows > 1000) return;
    try {
      this.pty.resize(cols, rows);
      this.emulator.resize(cols, rows);
      this.dirty = true;
    } catch {
      // A resize racing process exit is harmless.
    }
  }

  updateMetadata(info: DaemonTerminalMetadata): void {
    Object.assign(this.info, info);
    writeJsonAtomic(join(this.dir, 'meta.json'), this.info);
  }

  kill(): void {
    if (this.exited) return;
    this.exited = true;
    const pid = this.pty.pid;
    try {
      this.pty.kill();
    } catch {
      // Already dead.
    }
    if (process.platform !== 'win32') {
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // The process group already exited.
        }
      }, 1500).unref();
    }
    this.onExit();
  }

  async snapshot(): Promise<DaemonTerminalSnapshot> {
    await new Promise<void>((resolve) => this.emulator.write('', resolve));
    return {
      info: { ...this.info },
      pid: this.pid,
      processTitle: this.processTitle,
      hasChildren: this.hasChildren,
      sequence: this.sequence,
      replay: this.serializer.serialize({ scrollback: this.emulator.options.scrollback }),
      cols: this.emulator.cols,
      rows: this.emulator.rows,
    };
  }

  async checkpoint(): Promise<void> {
    if (!this.dirty || this.checkpointing || this.exited) return;
    this.checkpointing = true;
    try {
      const snapshot = await this.snapshot();
      if (this.exited) return;
      this.flushLog();
      writeJsonAtomic(join(this.dir, 'checkpoint.json'), {
        sequence: snapshot.sequence,
        cols: this.emulator.cols,
        rows: this.emulator.rows,
        replay: snapshot.replay,
        checkpointedAt: new Date().toISOString(),
      });
      writeFileSync(join(this.dir, 'output.log'), '', { mode: 0o600 });
      this.dirty = false;
    } finally {
      this.checkpointing = false;
    }
  }

  dispose(): void {
    if (this.logTimer) clearTimeout(this.logTimer);
    this.logTimer = null;
    this.flushLog();
    this.emulator.dispose();
  }

  private handleData(data: string): void {
    if (this.exited) return;
    this.sequence += 1;
    this.dirty = true;
    this.emulator.write(data);
    this.pendingLog.push(`${JSON.stringify({ sequence: this.sequence, data })}\n`);
    if (!this.logTimer) {
      this.logTimer = setTimeout(() => {
        this.logTimer = null;
        this.flushLog();
      }, 50);
      this.logTimer.unref();
    }
    this.publish({ type: 'data', id: this.info.id, sequence: this.sequence, data });
  }

  private flushLog(): void {
    if (this.pendingLog.length === 0) return;
    const batch = this.pendingLog.join('');
    this.pendingLog = [];
    appendFileSync(join(this.dir, 'output.log'), batch, { mode: 0o600 });
  }
}

export interface TerminalDaemonServerOptions {
  socketPath: string;
  tokenFile: string;
  stateDir: string;
  log?: (event: string, context?: Record<string, unknown>) => void;
}

export class TerminalDaemonServer {
  private readonly connections = new Set<DaemonConnection>();
  private readonly sessions = new Map<string, HostedTerminal>();
  private readonly responseCache = new Map<string, string>();
  private readonly token: string;
  private server: Server | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;

  constructor(private readonly options: TerminalDaemonServerOptions) {
    this.token = readFileSync(options.tokenFile, 'utf8').trim();
    if (!this.token) throw new Error('Terminal daemon token is empty.');
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(options.stateDir, 0o700);
    // A newly started daemon cannot own PTYs from an older daemon process.
    // Remove only its private per-session directories before accepting work.
    for (const entry of readdirSync(options.stateDir)) {
      rmSync(join(options.stateDir, entry), { recursive: true, force: true });
    }
  }

  async start(): Promise<void> {
    if (process.platform !== 'win32' && existsSync(this.options.socketPath)) {
      rmSync(this.options.socketPath, { force: true });
    }
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.socketPath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') chmodSync(this.options.socketPath, 0o600);
    this.statusTimer = setInterval(() => this.publishStatuses(), 700);
    this.checkpointTimer = setInterval(() => {
      for (const session of this.sessions.values())
        void session.checkpoint().catch(() => undefined);
    }, 2000);
    this.options.log?.('started', { pid: process.pid, socketPath: this.options.socketPath });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const connection of this.connections) connection.socket.destroy();
    for (const session of [...this.sessions.values()]) session.kill();
    this.sessions.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    if (process.platform !== 'win32') rmSync(this.options.socketPath, { force: true });
  }

  private accept(socket: Socket): void {
    const connection: DaemonConnection = {
      socket,
      decoder: new DaemonMessageDecoder<TerminalDaemonRequest>(),
      authenticated: false,
      work: Promise.resolve(),
    };
    this.connections.add(connection);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    socket.on('data', (chunk) => {
      let messages: TerminalDaemonRequest[];
      try {
        messages = connection.decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const message of messages) {
        connection.work = connection.work
          .then(() => this.handleRequest(connection, message))
          .catch((error) => {
            this.options.log?.('request-failed', {
              type: message.type,
              error: error instanceof Error ? error.message : String(error),
              ...(message.type === 'spawn'
                ? {
                    executable: message.executable,
                    cwd: message.cwd,
                    daemonExecPath: process.execPath,
                  }
                : {}),
            });
            this.respond(connection, message.requestId, false, undefined, String(error));
          });
      }
    });
    socket.on('close', () => {
      this.connections.delete(connection);
      this.armIdleExit();
    });
    socket.on('error', () => undefined);
  }

  private async handleRequest(
    connection: DaemonConnection,
    request: TerminalDaemonRequest,
  ): Promise<void> {
    if (request.type === 'hello') {
      const valid =
        request.version === TERMINAL_DAEMON_PROTOCOL_VERSION &&
        safeEqual(request.token, this.token);
      if (!valid) {
        this.respond(connection, request.requestId, false, undefined, 'Authentication failed.');
        connection.socket.end();
        return;
      }
      connection.authenticated = true;
      this.respond(
        connection,
        request.requestId,
        true,
        { version: TERMINAL_DAEMON_PROTOCOL_VERSION },
        undefined,
        false,
      );
      return;
    }
    if (!connection.authenticated) {
      this.respond(connection, request.requestId, false, undefined, 'Authenticate first.');
      connection.socket.end();
      return;
    }

    const cached = this.responseCache.get(request.requestId);
    if (cached) {
      connection.socket.write(cached);
      return;
    }

    if (request.type === 'list') {
      const sessions = await Promise.all(
        [...this.sessions.values()].map((session) => session.snapshot()),
      );
      this.respond(connection, request.requestId, true, { sessions, hostKind: 'run-as-node' });
      return;
    }
    if (request.type === 'spawn') {
      if (this.sessions.has(request.info.id)) throw new Error('Terminal session already exists.');
      const pty = nodePty.spawn(request.executable, request.args, {
        name: 'xterm-256color',
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        env: request.env,
      });
      const dir = join(this.options.stateDir, request.info.id);
      const session = new HostedTerminal(
        { ...request.info },
        pty,
        dir,
        request.scrollback,
        (event) => this.publish(event),
        () => this.dropSession(request.info.id),
      );
      this.sessions.set(request.info.id, session);
      this.respond(connection, request.requestId, true, { pid: pty.pid });
      return;
    }
    if (request.type === 'updateMetadata') {
      const session = this.mustSession(request.info.id);
      session.updateMetadata(request.info);
      this.respond(connection, request.requestId, true);
      return;
    }
    if (request.type === 'write') {
      this.mustSession(request.id).write(request.data);
      this.respond(connection, request.requestId, true);
      return;
    }
    if (request.type === 'resize') {
      this.mustSession(request.id).resize(request.cols, request.rows);
      this.respond(connection, request.requestId, true);
      return;
    }
    if (request.type === 'kill') {
      const session = this.sessions.get(request.id);
      session?.kill();
      this.respond(connection, request.requestId, true);
      return;
    }
    if (request.type === 'shutdownIfIdle') {
      this.respond(connection, request.requestId, true, { idle: this.sessions.size === 0 });
      if (this.sessions.size === 0)
        setTimeout(() => void this.close().then(() => process.exit(0)), 0);
    }
  }

  private mustSession(id: string): HostedTerminal {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown terminal session: ${id}`);
    return session;
  }

  private dropSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.dispose();
    rmSync(session.dir, { recursive: true, force: true });
    this.armIdleExit();
  }

  private publish(event: TerminalDaemonEvent): void {
    const encoded = encodeDaemonMessage(event);
    for (const connection of this.connections) {
      if (connection.authenticated && !connection.socket.destroyed)
        connection.socket.write(encoded);
    }
  }

  private publishStatuses(): void {
    for (const session of this.sessions.values()) {
      this.publish({
        type: 'status',
        id: session.info.id,
        pid: session.pid,
        processTitle: session.processTitle,
        hasChildren: session.hasChildren,
      });
    }
  }

  private respond(
    connection: DaemonConnection,
    requestId: string,
    ok: boolean,
    result?: unknown,
    error?: string,
    cache = connection.authenticated,
  ): void {
    const response: TerminalDaemonEvent = ok
      ? { type: 'response', requestId, ok: true, ...(result === undefined ? {} : { result }) }
      : {
          type: 'response',
          requestId,
          ok: false,
          error: error ?? 'Terminal daemon request failed.',
        };
    const encoded = encodeDaemonMessage(response);
    if (cache) {
      this.responseCache.set(requestId, encoded);
      if (this.responseCache.size > 4096) {
        const oldest = this.responseCache.keys().next().value as string | undefined;
        if (oldest) this.responseCache.delete(oldest);
      }
    }
    connection.socket.write(encoded);
  }

  private armIdleExit(): void {
    if (this.closing || this.connections.size > 0 || this.sessions.size > 0 || this.idleTimer)
      return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.connections.size === 0 && this.sessions.size === 0) {
        void this.close().then(() => process.exit(0));
      }
    }, 5000);
    this.idleTimer.unref();
  }
}

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

export async function startTerminalDaemonFromArgs(): Promise<void> {
  const socketPath = argValue('terminal-daemon-socket');
  const tokenFile = argValue('terminal-daemon-token');
  const stateDir = argValue('terminal-daemon-state');
  const logFile = argValue('terminal-daemon-log');
  if (!socketPath || !tokenFile || !stateDir) {
    throw new Error('Terminal daemon launch arguments are incomplete.');
  }
  const log = logFile
    ? (event: string, context: Record<string, unknown> = {}): void => {
        try {
          appendFileSync(
            logFile,
            `${JSON.stringify({ at: new Date().toISOString(), event, ...context })}\n`,
            { mode: 0o600 },
          );
        } catch {
          // Diagnostics must never take down the PTY owner.
        }
      }
    : undefined;
  const server = new TerminalDaemonServer({
    socketPath,
    tokenFile,
    stateDir,
    ...(log ? { log } : {}),
  });
  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await server.start();
}
