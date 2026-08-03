import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type {
  TerminalReplayAnalysisDto,
  TerminalReplayEventDto,
  TerminalReplaySegmentDto,
  TerminalReplaySessionDto,
} from '@pi-ide/ipc-contracts';
import type { Logger } from '@pi-ide/foundation';
import type { SqlDatabase } from '@pi-ide/persistence';
import type { TerminalManager } from '@pi-ide/terminal-service';
import type { TaskDto } from '@pi-ide/ipc-contracts';
import type { TaskService } from './task-service.js';
import { listTerminalRecordings, type TerminalRecordingCatalogItem } from './terminal-recording.js';
import { TerminalReplayAnalysisHost } from './terminal-replay-analysis-host.js';
import { join } from 'node:path';

const READ_CHUNK_BYTES = 256 * 1024;
const READ_PAGE_BYTES = 4 * 1024 * 1024;
const SESSION_LEAD_IN_MS = 5_000;

const SEGMENT_START_EVENTS = new Set([
  'external.sessionStarted',
  'external.sessionTerminalBound',
  'external.sessionResuming',
  'external.sessionReattached',
  'external.sessionLaunchConfirmed',
  'external.sessionAdopted',
  'external.sessionResumedFrom',
]);

interface TaskInterval {
  terminalId: string;
  startMs: number;
  endMs: number | null;
}

interface ResolvedSegment {
  dto: TerminalReplaySegmentDto;
  recording: TerminalRecordingCatalogItem;
  clipStartMs: number;
  clipEndMs: number;
  timelineOriginMs: number;
}

interface ResolvedSession {
  dto: TerminalReplaySessionDto;
  segments: ResolvedSegment[];
}

interface EventRow {
  type: string;
  payload_json: string;
  created_at: string;
}

function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function taskIntervals(db: SqlDatabase, task: TaskDto): TaskInterval[] {
  if (!task.external) return [];
  const rows = db
    .prepare(
      'SELECT type, payload_json, created_at FROM task_events WHERE task_id = ? ORDER BY sequence',
    )
    .all(task.id) as unknown as EventRow[];
  const intervals: TaskInterval[] = [];
  for (const row of rows) {
    const at = Date.parse(row.created_at);
    if (!Number.isFinite(at)) continue;
    if (row.type === 'external.sessionEnded') {
      const current = intervals.at(-1);
      if (current?.endMs === null) current.endMs = Math.max(current.startMs, at);
      continue;
    }
    if (!SEGMENT_START_EVENTS.has(row.type)) continue;
    const terminalId = jsonObject(row.payload_json).terminalId;
    if (typeof terminalId !== 'string' || !terminalId || terminalId === 'pending') continue;
    const current = intervals.at(-1);
    if (current?.endMs === null && current.terminalId === terminalId) continue;
    if (current?.endMs === null) current.endMs = Math.max(current.startMs, at);
    intervals.push({
      terminalId,
      startMs: Math.max(0, at - SESSION_LEAD_IN_MS),
      endMs: null,
    });
  }
  if (intervals.length === 0) {
    intervals.push({
      terminalId: task.external.terminalId,
      startMs: Math.max(0, Date.parse(task.createdAt) - SESSION_LEAD_IN_MS),
      endMs: task.external.status === 'ended' ? Date.parse(task.updatedAt) : null,
    });
  } else {
    const current = intervals.at(-1);
    if (current?.endMs === null && task.external.status === 'ended') {
      current.endMs = Math.max(current.startMs, Date.parse(task.updatedAt));
    }
  }
  return intervals;
}

function recordingEndMs(
  recording: TerminalRecordingCatalogItem,
  terminalLive: boolean,
  now: number,
): number {
  return terminalLive
    ? now
    : recording.header.charter.startedAt + Math.max(0, recording.durationMs);
}

/** Read-only resolver over raw .cast files; it never mutates the task ledger. */
export class TerminalReplayService {
  private readonly analysisHost: TerminalReplayAnalysisHost;

  constructor(
    private readonly db: SqlDatabase,
    private readonly tasks: TaskService,
    private readonly terminals: TerminalManager,
    private readonly recordingsDir: string,
    private readonly logger: Logger,
  ) {
    this.analysisHost = new TerminalReplayAnalysisHost(logger.child('analysis'));
  }

  session(taskId: string): { session: TerminalReplaySessionDto } {
    return { session: this.resolve(taskId).dto };
  }

  events(
    taskId: string,
    options: { segmentId: string; cursor: number; limit: number },
  ): {
    events: TerminalReplayEventDto[];
    cursor: number;
    atEnd: boolean;
    live: boolean;
  } {
    const resolved = this.resolve(taskId);
    const segment = resolved.segments.find((item) => item.dto.id === options.segmentId);
    if (!segment) {
      return { events: [], cursor: options.cursor, atEnd: true, live: false };
    }
    const page = this.readPage(segment, options.cursor, options.limit);
    return { ...page, live: segment.dto.live };
  }

  async analysis(taskId: string): Promise<{ analysis: TerminalReplayAnalysisDto }> {
    const resolved = this.resolve(taskId);
    if (!resolved.dto.available) {
      return { analysis: this.unavailableAnalysis(resolved.dto.originalDurationMs) };
    }
    const task = this.tasks.getTask(taskId);
    try {
      const analysis = await this.analysisHost.analyze({
        taskId,
        cli: task.external?.cli ?? null,
        live: resolved.dto.live,
        cacheDir: join(this.recordingsDir, '.analysis'),
        segments: resolved.segments.map((segment) => ({
          id: segment.dto.id,
          path: segment.recording.path,
          recordingStartedAtMs: segment.recording.header.charter.startedAt,
          clipStartMs: segment.clipStartMs,
          clipEndMs: segment.clipEndMs,
          timelineStartMs: segment.dto.timelineStartMs,
          durationMs: segment.dto.durationMs,
          cols: segment.dto.cols,
          rows: segment.dto.rows,
          sizeBytes: segment.dto.sizeBytes,
          live: segment.dto.live,
        })),
      });
      return { analysis };
    } catch (error) {
      this.logger.warn('terminal replay analysis unavailable', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { analysis: this.unavailableAnalysis(resolved.dto.originalDurationMs) };
    }
  }

  async dispose(): Promise<void> {
    await this.analysisHost.dispose();
  }

  private unavailableAnalysis(analyzedThroughMs: number): TerminalReplayAnalysisDto {
    return {
      version: 1,
      status: 'unavailable',
      analyzedThroughMs,
      totalEvents: 0,
      sampledFrames: 0,
      motionEvents: 0,
      collapsibleDurationMs: 0,
      spans: [],
      cached: false,
    };
  }

  private resolve(taskId: string): ResolvedSession {
    const task = this.tasks.getTask(taskId);
    const now = Date.now();
    if (!task.external) {
      return {
        dto: {
          taskId,
          available: false,
          reason: 'This Session did not run in a recordable terminal.',
          startedAt: task.createdAt,
          originalDurationMs: Math.max(0, now - Date.parse(task.createdAt)),
          live: false,
          segments: [],
        },
        segments: [],
      };
    }
    const intervals = taskIntervals(this.db, task);
    const liveTerminalIds = new Set(this.terminals.list().map((terminal) => terminal.id));
    const recordings = listTerminalRecordings(this.recordingsDir);
    const candidates: Array<{
      recording: TerminalRecordingCatalogItem;
      interval: TaskInterval;
      clipStartMs: number;
      clipEndMs: number;
      live: boolean;
    }> = [];
    for (const interval of intervals) {
      for (const recording of recordings) {
        if (recording.header.charter.terminalId !== interval.terminalId) continue;
        const terminalLive = liveTerminalIds.has(interval.terminalId);
        const start = recording.header.charter.startedAt;
        const end = recordingEndMs(recording, terminalLive, now);
        const intervalEnd = interval.endMs ?? now;
        if (start > intervalEnd || end < interval.startMs) continue;
        const clipStartMs = Math.max(start, interval.startMs);
        const clipEndMs = Math.max(clipStartMs, Math.min(end, intervalEnd));
        candidates.push({
          recording,
          interval,
          clipStartMs,
          clipEndMs,
          live: terminalLive && interval.endMs === null,
        });
      }
    }
    candidates.sort((left, right) => left.clipStartMs - right.clipStartMs);
    const timelineOriginMs = candidates[0]?.clipStartMs ?? Date.parse(task.createdAt);
    const segments: ResolvedSegment[] = candidates.map((candidate) => {
      const meta = candidate.recording.header.charter;
      const dto: TerminalReplaySegmentDto = {
        id: `${candidate.recording.id}:${candidate.interval.startMs}`,
        recordingId: candidate.recording.id,
        terminalId: meta.terminalId,
        title: meta.title,
        cwd: meta.cwd,
        source: meta.source,
        hostLabel: meta.hostLabel,
        cols: candidate.recording.header.width,
        rows: candidate.recording.header.height,
        timelineStartMs: Math.max(0, candidate.clipStartMs - timelineOriginMs),
        durationMs: Math.max(0, candidate.clipEndMs - candidate.clipStartMs),
        startedAt: new Date(candidate.clipStartMs).toISOString(),
        endedAt: candidate.live ? null : new Date(candidate.clipEndMs).toISOString(),
        live: candidate.live,
        sizeBytes: candidate.recording.sizeBytes,
      };
      return {
        dto,
        recording: candidate.recording,
        clipStartMs: candidate.clipStartMs,
        clipEndMs: candidate.clipEndMs,
        timelineOriginMs,
      };
    });
    const timelineEndMs = candidates.reduce(
      (latest, candidate) => Math.max(latest, candidate.clipEndMs),
      timelineOriginMs,
    );
    const available = segments.length > 0;
    return {
      dto: {
        taskId,
        available,
        reason: available
          ? null
          : 'No terminal recording is available for this Session. It may predate Terminal Replay.',
        startedAt: new Date(timelineOriginMs).toISOString(),
        originalDurationMs: Math.max(0, timelineEndMs - timelineOriginMs),
        live: segments.some((segment) => segment.dto.live),
        segments: segments.map((segment) => segment.dto),
      },
      segments,
    };
  }

  private readPage(
    segment: ResolvedSegment,
    requestedCursor: number,
    limit: number,
  ): { events: TerminalReplayEventDto[]; cursor: number; atEnd: boolean } {
    const fd = openSync(segment.recording.path, 'r');
    try {
      const size = fstatSync(fd).size;
      let cursor = Math.max(0, Math.min(requestedCursor, size));
      let filePosition = cursor;
      let bufferStart = cursor;
      let pending = Buffer.alloc(0);
      let bytesReadTotal = 0;
      let reachedClipEnd = false;
      const events: TerminalReplayEventDto[] = [];

      while (
        filePosition < size &&
        events.length < limit &&
        bytesReadTotal < READ_PAGE_BYTES &&
        !reachedClipEnd
      ) {
        const readLength = Math.min(READ_CHUNK_BYTES, size - filePosition);
        const chunk = Buffer.allocUnsafe(readLength);
        const bytes = readSync(fd, chunk, 0, readLength, filePosition);
        if (bytes <= 0) break;
        filePosition += bytes;
        bytesReadTotal += bytes;
        pending = pending.length
          ? Buffer.concat([pending, chunk.subarray(0, bytes)])
          : chunk.subarray(0, bytes);

        for (;;) {
          const newline = pending.indexOf(0x0a);
          if (newline < 0) break;
          const line = pending.subarray(0, newline).toString('utf8');
          const nextCursor = bufferStart + newline + 1;
          pending = pending.subarray(newline + 1);
          bufferStart = nextCursor;
          cursor = nextCursor;
          try {
            const parsed = JSON.parse(line) as unknown;
            if (!Array.isArray(parsed)) continue; // asciinema header
            const [seconds, code, data] = parsed;
            if (
              typeof seconds !== 'number' ||
              (code !== 'o' && code !== 'r') ||
              typeof data !== 'string'
            ) {
              continue;
            }
            const absoluteMs = segment.recording.header.charter.startedAt + seconds * 1000;
            if (absoluteMs < segment.clipStartMs) continue;
            if (absoluteMs > segment.clipEndMs) {
              reachedClipEnd = true;
              break;
            }
            events.push({
              atMs: Math.max(0, Math.round(absoluteMs - segment.timelineOriginMs)),
              code,
              data,
            });
            if (events.length >= limit) break;
          } catch {
            // A corrupt line does not invalidate the remaining append-only recording.
          }
        }
      }
      // We may have read ahead into `pending` before hitting the page's event
      // limit. Only the complete-line cursor proves that every byte was consumed.
      const atPhysicalEnd = cursor >= size;
      return { events, cursor, atEnd: reachedClipEnd || atPhysicalEnd };
    } catch (error) {
      this.logger.warn('terminal replay page failed', {
        taskId: segment.dto.id,
        recordingId: segment.recording.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { events: [], cursor: requestedCursor, atEnd: true };
    } finally {
      closeSync(fd);
    }
  }
}
