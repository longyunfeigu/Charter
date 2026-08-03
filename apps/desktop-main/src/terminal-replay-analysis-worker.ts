import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  TerminalReplayAnalysisDtoSchema,
  type TerminalReplayAnalysisDto,
  type TerminalReplayCompressionSpanDto,
} from '@pi-ide/ipc-contracts';
import {
  TerminalReplayMotionAnalyzer,
  type TerminalReplayMotionSnapshot,
} from './services/terminal-replay-motion.js';
import type {
  TerminalReplayAnalysisInbound,
  TerminalReplayAnalysisOutbound,
  TerminalReplayAnalysisRequest,
  TerminalReplayAnalysisSegmentInput,
} from './services/terminal-replay-analysis-protocol.js';

const ANALYZER_VERSION = 1;
const READ_CHUNK_BYTES = 256 * 1024;

interface SegmentState {
  fingerprint: string;
  cursor: number;
  analyzer: TerminalReplayMotionAnalyzer;
  finished: boolean;
}

interface TaskState {
  segments: Map<string, SegmentState>;
  lastAccessAt: number;
}

interface CachedEnvelope {
  signature: string;
  analysis: TerminalReplayAnalysisDto;
}

const port = process.parentPort;
if (!port) {
  console.error('terminal-replay-analysis-worker must run as an Electron utility process');
  process.exit(1);
}

const tasks = new Map<string, TaskState>();

function send(message: TerminalReplayAnalysisOutbound): void {
  port!.postMessage(message);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requestSignature(request: TerminalReplayAnalysisRequest): string {
  return digest(
    JSON.stringify({
      version: ANALYZER_VERSION,
      cli: request.cli,
      live: request.live,
      segments: request.segments.map((segment) => ({
        id: segment.id,
        path: segment.path,
        start: segment.clipStartMs,
        end: segment.clipEndMs,
        timeline: segment.timelineStartMs,
        duration: segment.durationMs,
        cols: segment.cols,
        rows: segment.rows,
        size: segment.sizeBytes,
        live: segment.live,
      })),
    }),
  );
}

function segmentFingerprint(
  segment: TerminalReplayAnalysisSegmentInput,
  cli: string | null,
): string {
  return JSON.stringify({
    path: segment.path,
    recordingStartedAtMs: segment.recordingStartedAtMs,
    clipStartMs: segment.clipStartMs,
    timelineStartMs: segment.timelineStartMs,
    cols: segment.cols,
    rows: segment.rows,
    cli,
  });
}

function cachePath(request: TerminalReplayAnalysisRequest): string {
  return join(request.cacheDir, `${digest(request.taskId)}.json`);
}

function readCache(
  request: TerminalReplayAnalysisRequest,
  signature: string,
): TerminalReplayAnalysisDto | null {
  if (request.live) return null;
  try {
    const parsed = JSON.parse(readFileSync(cachePath(request), 'utf8')) as CachedEnvelope;
    if (parsed.signature !== signature) return null;
    const result = TerminalReplayAnalysisDtoSchema.safeParse(parsed.analysis);
    return result.success ? { ...result.data, cached: true } : null;
  } catch {
    return null;
  }
}

function writeCache(
  request: TerminalReplayAnalysisRequest,
  signature: string,
  analysis: TerminalReplayAnalysisDto,
): void {
  if (request.live) return;
  try {
    mkdirSync(request.cacheDir, { recursive: true, mode: 0o700 });
    chmodSync(request.cacheDir, 0o700);
    const path = cachePath(request);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ signature, analysis })}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    send({
      type: 'log',
      level: 'warn',
      message: `could not cache replay analysis: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function processSegment(
  request: TerminalReplayAnalysisRequest,
  segment: TerminalReplayAnalysisSegmentInput,
  taskState: TaskState,
): Promise<TerminalReplayMotionSnapshot> {
  const fingerprint = segmentFingerprint(segment, request.cli);
  let state = taskState.segments.get(segment.id);
  if (!state || state.fingerprint !== fingerprint) {
    state?.analyzer.dispose();
    state = {
      fingerprint,
      cursor: 0,
      analyzer: new TerminalReplayMotionAnalyzer({
        segmentId: segment.id,
        timelineStartMs: segment.timelineStartMs,
        cols: segment.cols,
        rows: segment.rows,
        cli: request.cli,
      }),
      finished: false,
    };
    taskState.segments.set(segment.id, state);
  }

  if (!state.finished && existsSync(segment.path)) {
    const fd = openSync(segment.path, 'r');
    try {
      const size = fstatSync(fd).size;
      let filePosition = Math.min(state.cursor, size);
      let bufferStart = filePosition;
      let pending = Buffer.alloc(0);
      while (filePosition < size) {
        const length = Math.min(READ_CHUNK_BYTES, size - filePosition);
        const chunk = Buffer.allocUnsafe(length);
        const bytes = readSync(fd, chunk, 0, length, filePosition);
        if (bytes <= 0) break;
        filePosition += bytes;
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
          state.cursor = nextCursor;
          try {
            const parsed = JSON.parse(line) as unknown;
            if (!Array.isArray(parsed)) continue;
            const [seconds, code, data] = parsed;
            if (
              typeof seconds !== 'number' ||
              (code !== 'o' && code !== 'r') ||
              typeof data !== 'string'
            ) {
              continue;
            }
            const absoluteMs = segment.recordingStartedAtMs + seconds * 1_000;
            if (absoluteMs < segment.clipStartMs || absoluteMs > segment.clipEndMs) continue;
            await state.analyzer.ingest({
              atMs: Math.max(
                segment.timelineStartMs,
                Math.round(segment.timelineStartMs + absoluteMs - segment.clipStartMs),
              ),
              code,
              data,
            });
          } catch {
            // A malformed complete line is isolated; the append-only tail remains analyzable.
          }
        }
      }
    } finally {
      closeSync(fd);
    }
  }

  const segmentEndAtMs = segment.timelineStartMs + segment.durationMs;
  if (!segment.live && !state.finished) {
    state.finished = true;
    return await state.analyzer.finish(segmentEndAtMs);
  }
  return await state.analyzer.snapshot(segmentEndAtMs, segment.live);
}

function mergeSpans(
  spans: readonly TerminalReplayCompressionSpanDto[],
): TerminalReplayCompressionSpanDto[] {
  const ordered = [...new Map(spans.map((span) => [span.id, span])).values()].sort(
    (left, right) => left.startAtMs - right.startAtMs || left.endAtMs - right.endAtMs,
  );
  const merged: TerminalReplayCompressionSpanDto[] = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.kind === span.kind &&
      span.startAtMs <= previous.endAtMs + 250 &&
      !previous.live
    ) {
      const endAtMs = Math.max(previous.endAtMs, span.endAtMs);
      previous.endAtMs = endAtMs;
      previous.originalDurationMs = endAtMs - previous.startAtMs;
      previous.suggestedDurationMs = Math.max(
        previous.suggestedDurationMs,
        span.suggestedDurationMs,
      );
      previous.eventCount += span.eventCount;
      previous.confidence =
        previous.confidence === 'high' || span.confidence === 'high' ? 'high' : 'medium';
      previous.live = span.live;
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

async function analyze(request: TerminalReplayAnalysisRequest): Promise<TerminalReplayAnalysisDto> {
  const signature = requestSignature(request);
  const cached = readCache(request, signature);
  if (cached) return cached;

  let taskState = tasks.get(request.taskId);
  if (!taskState) {
    taskState = { segments: new Map(), lastAccessAt: Date.now() };
    tasks.set(request.taskId, taskState);
  }
  taskState.lastAccessAt = Date.now();
  if (tasks.size > 8) {
    const stale = [...tasks.entries()]
      .filter(([taskId]) => taskId !== request.taskId)
      .sort((left, right) => left[1].lastAccessAt - right[1].lastAccessAt);
    while (tasks.size > 8 && stale.length > 0) {
      const entry = stale.shift();
      if (!entry) break;
      for (const state of entry[1].segments.values()) state.analyzer.dispose();
      tasks.delete(entry[0]);
    }
  }
  const liveIds = new Set(request.segments.map((segment) => segment.id));
  for (const [id, state] of taskState.segments) {
    if (liveIds.has(id)) continue;
    state.analyzer.dispose();
    taskState.segments.delete(id);
  }

  const results: TerminalReplayMotionSnapshot[] = [];
  for (const segment of request.segments) {
    results.push(await processSegment(request, segment, taskState));
  }
  const spans = mergeSpans(results.flatMap((result) => result.spans));
  const analysis: TerminalReplayAnalysisDto = {
    version: 1,
    status: 'ready',
    analyzedThroughMs: Math.max(
      0,
      ...request.segments.map((segment) => segment.timelineStartMs + segment.durationMs),
    ),
    totalEvents: results.reduce((total, result) => total + result.totalEvents, 0),
    sampledFrames: results.reduce((total, result) => total + result.sampledFrames, 0),
    motionEvents: results.reduce((total, result) => total + result.motionEvents, 0),
    collapsibleDurationMs: spans.reduce(
      (total, span) => total + Math.max(0, span.originalDurationMs - span.suggestedDurationMs),
      0,
    ),
    spans,
    cached: false,
  };
  writeCache(request, signature, analysis);
  return analysis;
}

let work = Promise.resolve();
port.on('message', (event) => {
  const message = event.data as TerminalReplayAnalysisInbound;
  if (message.type === 'shutdown') {
    for (const task of tasks.values()) {
      for (const state of task.segments.values()) state.analyzer.dispose();
    }
    process.exit(0);
  }
  work = work
    .then(async () => {
      try {
        send({
          type: 'response',
          reqId: message.reqId,
          ok: true,
          analysis: await analyze(message),
        });
      } catch (error) {
        send({
          type: 'response',
          reqId: message.reqId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })
    .catch(() => undefined);
});

(port as unknown as NodeJS.EventEmitter).on('close', () => process.exit(0));
setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, 5_000).unref();

send({ type: 'ready', pid: process.pid });
