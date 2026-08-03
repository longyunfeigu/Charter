import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { TerminalInfo, TerminalManager } from '@pi-ide/terminal-service';

const MAX_RECORDINGS = 60;
const MAX_RECORDING_BYTES = 800 * 1024 * 1024;
const HEADER_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;

export interface CharterCastMetadata {
  recordingId: string;
  terminalId: string;
  title: string;
  cwd: string;
  projectName: string;
  contextTaskId: string | null;
  launch: string;
  source: 'daemon' | 'process' | 'remote';
  hostLabel: string | null;
  startedAt: number;
}

export interface TerminalCastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp: number;
  env: { TERM: string };
  charter: CharterCastMetadata;
}

export interface TerminalRecordingCatalogItem {
  id: string;
  path: string;
  header: TerminalCastHeader;
  sizeBytes: number;
  durationMs: number;
  mtimeMs: number;
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'terminal';
}

function activeMarker(path: string): string {
  return `${path}.active`;
}

function markerProcessIsAlive(path: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pruneRecordings(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.cast'))
      .map((name) => {
        const path = join(dir, name);
        try {
          return { path, stat: statSync(path) };
        } catch {
          return null;
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
    let bytes = files.reduce((total, item) => total + item.stat.size, 0);
    let count = files.length;
    for (const item of files) {
      if (count <= MAX_RECORDINGS && bytes <= MAX_RECORDING_BYTES) break;
      const marker = activeMarker(item.path);
      if (existsSync(marker) && markerProcessIsAlive(marker)) continue;
      try {
        rmSync(item.path, { force: true });
        rmSync(marker, { force: true });
        count -= 1;
        bytes -= item.stat.size;
      } catch {
        // Retention is best effort and must never affect a PTY.
      }
    }
  } catch {
    // A broken retention scan must never affect a PTY.
  }
}

/**
 * A deliberately dumb asciinema v2 sidecar. It only appends bytes and grid
 * changes; compression and playback policy belong to the renderer.
 */
export class TerminalRecordingWriter {
  readonly id: string;
  readonly path: string;
  readonly startedAt: number;
  private stream: WriteStream | null;
  private closed = false;

  constructor(
    dir: string,
    info: TerminalInfo,
    cols: number,
    rows: number,
    source: 'daemon' | 'process' | 'remote',
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    pruneRecordings(dir);
    this.startedAt = Date.now();
    this.id = `${this.startedAt}-${safePart(info.id)}-${randomUUID().slice(0, 8)}`;
    this.path = join(dir, `${this.id}.cast`);
    const header: TerminalCastHeader = {
      version: 2,
      width: Math.max(2, cols),
      height: Math.max(1, rows),
      timestamp: Math.floor(this.startedAt / 1000),
      env: { TERM: 'xterm-256color' },
      charter: {
        recordingId: this.id,
        terminalId: info.id,
        title: info.title,
        cwd: info.cwd,
        projectName: info.projectName,
        contextTaskId: info.contextTaskId,
        launch: info.launch,
        source,
        hostLabel: info.remote?.hostLabel ?? null,
        startedAt: this.startedAt,
      },
    };
    this.stream = createWriteStream(this.path, { flags: 'a', mode: 0o600 });
    this.stream.on('error', () => {
      this.stream = null;
      rmSync(activeMarker(this.path), { force: true });
    });
    this.stream.write(`${JSON.stringify(header)}\n`);
    writeFileSync(activeMarker(this.path), `${process.pid}\n`, { mode: 0o600 });
  }

  output(data: string): void {
    this.event('o', data);
  }

  resize(cols: number, rows: number): void {
    this.event('r', `${cols}x${rows}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const stream = this.stream;
    this.stream = null;
    try {
      stream?.end();
    } catch {
      // A recorder failure never propagates into terminal shutdown.
    }
    rmSync(activeMarker(this.path), { force: true });
  }

  private event(code: 'o' | 'r', data: string): void {
    if (this.closed || !this.stream) return;
    try {
      const seconds = Math.max(0, Date.now() - this.startedAt) / 1000;
      this.stream.write(`${JSON.stringify([seconds, code, data])}\n`);
    } catch {
      this.close();
    }
  }
}

/** Records only transports not already owned by the detached daemon. */
export class TerminalRecordingCoordinator {
  private readonly writers = new Map<string, TerminalRecordingWriter>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly terminals: TerminalManager,
    private readonly recordingsDir: string,
    private readonly shouldRecordDaemon: () => boolean = () => false,
  ) {
    this.unsubscribe.push(
      terminals.onCreatedEvent(({ terminal, cols, rows }) => this.start(terminal, cols, rows)),
      terminals.onDataEvent(({ id, data }) => this.writers.get(id)?.output(data)),
      terminals.onResizeEvent(({ id, cols, rows }) => this.writers.get(id)?.resize(cols, rows)),
      terminals.onExitEvent(({ id }) => this.stop(id)),
    );
    for (const terminal of terminals.list()) this.start(terminal, 80, 24);
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    for (const writer of this.writers.values()) writer.close();
    this.writers.clear();
  }

  private start(info: TerminalInfo, cols: number, rows: number): void {
    if (
      (info.persistence === 'daemon' && !this.shouldRecordDaemon()) ||
      this.writers.has(info.id)
    ) {
      return;
    }
    try {
      const source =
        info.persistence === 'daemon'
          ? 'daemon'
          : info.persistence === 'remote'
            ? 'remote'
            : 'process';
      this.writers.set(
        info.id,
        new TerminalRecordingWriter(this.recordingsDir, info, cols, rows, source),
      );
    } catch {
      // Recording is passive: disk/permission failures cannot block a terminal.
    }
  }

  private stop(id: string): void {
    this.writers.get(id)?.close();
    this.writers.delete(id);
  }
}

function readFirstLine(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const value = buffer.subarray(0, bytes);
    const newline = value.indexOf(0x0a);
    return value.subarray(0, newline >= 0 ? newline : value.length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function readLastEventTimeMs(path: string, size: number): number {
  if (size <= 0) return 0;
  const fd = openSync(path, 'r');
  try {
    const length = Math.min(TAIL_BYTES, size);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, Math.max(0, size - length));
    const lines = buffer.toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]!.trim()) as unknown;
        if (Array.isArray(parsed) && typeof parsed[0] === 'number') {
          return Math.max(0, Math.round(parsed[0] * 1000));
        }
      } catch {
        // The first/last tail line may be partial; keep walking inward.
      }
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

export function listTerminalRecordings(dir: string): TerminalRecordingCatalogItem[] {
  if (!existsSync(dir)) return [];
  const items: TerminalRecordingCatalogItem[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.cast')) continue;
    const path = join(dir, name);
    try {
      const header = JSON.parse(readFirstLine(path)) as TerminalCastHeader;
      if (
        header.version !== 2 ||
        !header.charter?.recordingId ||
        basename(path) !== `${header.charter.recordingId}.cast`
      ) {
        continue;
      }
      const stat = statSync(path);
      items.push({
        id: header.charter.recordingId,
        path,
        header,
        sizeBytes: stat.size,
        durationMs: readLastEventTimeMs(path, stat.size),
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // A partial or corrupt recording is omitted; other recordings remain usable.
    }
  }
  return items.sort(
    (left, right) => left.header.charter.startedAt - right.header.charter.startedAt,
  );
}
