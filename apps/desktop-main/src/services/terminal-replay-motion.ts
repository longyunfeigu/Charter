import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type {
  TerminalReplayCompressionSpanDto,
  TerminalReplayEventDto,
} from '@pi-ide/ipc-contracts';

const SAMPLE_INTERVAL_MS = 50;
const MOTION_GRACE_MS = 420;
const MIN_MOTION_DURATION_MS = 1_200;
const MIN_MOTION_FRAMES = 5;
const IDLE_MARKER_MS = 3_000;

export interface TerminalReplayMotionAnalyzerOptions {
  segmentId: string;
  timelineStartMs: number;
  cols: number;
  rows: number;
  cli: string | null;
}

interface ScreenSnapshot {
  atMs: number;
  rows: string[];
  normalizedRows: string[];
  viewportY: number;
  baseY: number;
  cursorX: number;
  cursorY: number;
}

interface PendingFrame {
  startAtMs: number;
  endAtMs: number;
  data: string;
  eventCount: number;
}

interface MotionCandidate {
  startAtMs: number;
  endAtMs: number;
  lastMotionAtMs: number;
  frames: number;
  eventCount: number;
  score: number;
  hints: Set<string>;
}

interface FrameVerdict {
  motion: boolean;
  score: number;
  hint: string | null;
}

export interface TerminalReplayMotionSnapshot {
  spans: TerminalReplayCompressionSpanDto[];
  totalEvents: number;
  sampledFrames: number;
  motionEvents: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function writeTerminal(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

function normalizeMotionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒|/\\—–-]/g, '•')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds?|m|min|minutes?|%)\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningful(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, '');
}

function destructiveControlCount(data: string): number {
  return (
    (data.match(/\r/g)?.length ?? 0) +
    (data.match(/\x1b\[[0-?]*[ -/]*[ABCDEFGHJKSTXfhl]/g)?.length ?? 0)
  );
}

function screenHint(rows: readonly string[], data: string, cli: string | null): string | null {
  const text = `${stripAnsi(data)}\n${rows.join('\n')}`.toLowerCase();
  if (/starting (?:mcp|tool)|initiali[sz]ing|connecting|loading (?:tool|server)/.test(text)) {
    return 'tools';
  }
  if (/download|install|upload|building|compil|indexing|progress|\b\d{1,3}%\b/.test(text)) {
    return 'progress';
  }
  if (
    /thinking|working|reasoning|esc to interrupt|press esc|generating|pondering|clauding/.test(
      text,
    ) ||
    ((cli === 'claude' || cli === 'codex') && /interrupt|tokens? used|context left/.test(text))
  ) {
    return 'thinking';
  }
  return null;
}

function screenSnapshot(terminal: HeadlessTerminal, atMs: number): ScreenSnapshot {
  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  for (let index = 0; index < terminal.rows; index += 1) {
    rows.push(buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '');
  }
  return {
    atMs,
    rows,
    normalizedRows: rows.map(normalizeMotionText),
    viewportY: buffer.viewportY,
    baseY: buffer.baseY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
  };
}

function classifyFrame(
  previous: ScreenSnapshot,
  current: ScreenSnapshot,
  data: string,
  recentScreens: readonly string[],
  cli: string | null,
): FrameVerdict {
  let changedRows = 0;
  let normalizedChangedRows = 0;
  let addedRows = 0;
  let prefixGrowth = 0;
  for (let index = 0; index < current.rows.length; index += 1) {
    const before = previous.rows[index] ?? '';
    const after = current.rows[index] ?? '';
    if (before !== after) changedRows += 1;
    if (previous.normalizedRows[index] !== current.normalizedRows[index]) {
      normalizedChangedRows += 1;
    }
    if (!before.trim() && after.trim()) addedRows += 1;
    if (before.length > 0 && after.startsWith(before)) {
      prefixGrowth += meaningful(after.slice(before.length)).length;
    }
  }

  if (changedRows === 0) return { motion: false, score: 0, hint: null };

  const destructive = destructiveControlCount(data);
  const stripped = stripAnsi(data);
  const printable = meaningful(stripped).length;
  const scrolled = current.baseY > previous.baseY || current.viewportY > previous.viewportY;
  const smallRegion = changedRows <= Math.max(3, Math.ceil(current.rows.length * 0.22));
  const normalizedStable = normalizedChangedRows < changedRows || normalizedChangedRows <= 1;
  const screenKey = current.normalizedRows.join('\n');
  const cycle = recentScreens.includes(screenKey);
  const cursorMotion = current.cursorX !== previous.cursorX || current.cursorY !== previous.cursorY;
  const hint = screenHint(current.rows, data, cli);

  let score = 0;
  if (destructive > 0) score += 3;
  if (smallRegion) score += 2;
  if (normalizedStable) score += 2;
  if (cycle) score += 2;
  if (cursorMotion) score += 1;
  if (hint) score += 2;
  if (scrolled) score -= 7;
  if (prefixGrowth >= 3) score -= 6;
  if (addedRows >= 2) score -= 4;
  if (printable > 160 && !hint) score -= 3;

  return {
    motion: destructive > 0 && !scrolled && prefixGrowth < 3 && score >= 5,
    score,
    hint,
  };
}

function spanLabel(kind: TerminalReplayCompressionSpanDto['kind'], hints: Set<string>): string {
  if (hints.has('tools')) return 'Starting agent tools';
  if (kind === 'thinking') return 'Agent thinking';
  if (kind === 'progress') return 'Terminal progress';
  if (kind === 'idle') return 'No terminal activity';
  return 'Repeated terminal motion';
}

function spanKind(hints: Set<string>): TerminalReplayCompressionSpanDto['kind'] {
  if (hints.has('thinking') || hints.has('tools')) return 'thinking';
  if (hints.has('progress')) return 'progress';
  return 'motion';
}

/**
 * Stateful VT-screen analyzer. Every byte is still written to xterm; only the
 * sampling and screen-diff work is capped at 20 frames/sec.
 */
export class TerminalReplayMotionAnalyzer {
  private readonly terminal: HeadlessTerminal;
  private readonly spans: TerminalReplayCompressionSpanDto[] = [];
  private readonly recentScreens: string[] = [];
  private pending: PendingFrame | null = null;
  private previous: ScreenSnapshot | null = null;
  private candidate: MotionCandidate | null = null;
  private lastRawAtMs: number | null = null;
  private finished = false;
  private totalEventsValue = 0;
  private sampledFramesValue = 0;
  private motionEventsValue = 0;

  constructor(private readonly options: TerminalReplayMotionAnalyzerOptions) {
    this.terminal = new HeadlessTerminal({
      cols: Math.max(2, options.cols),
      rows: Math.max(1, options.rows),
      scrollback: 1_000,
      allowProposedApi: true,
      convertEol: false,
    });
  }

  async ingest(event: TerminalReplayEventDto): Promise<void> {
    if (this.finished) return;
    const atMs = Math.max(this.options.timelineStartMs, event.atMs);
    this.totalEventsValue += 1;
    if (this.lastRawAtMs !== null && atMs - this.lastRawAtMs >= IDLE_MARKER_MS) {
      this.closeCandidate(this.lastRawAtMs);
      this.addIdle(this.lastRawAtMs, atMs, false);
    }
    this.lastRawAtMs = atMs;

    if (event.code === 'r') {
      await this.flushPending();
      const match = /^(\d+)x(\d+)$/.exec(event.data);
      if (match) {
        const cols = Number(match[1]);
        const rows = Number(match[2]);
        if (cols >= 2 && rows >= 1 && cols <= 1_000 && rows <= 1_000) {
          this.terminal.resize(cols, rows);
          this.previous = screenSnapshot(this.terminal, atMs);
          this.rememberScreen(this.previous);
        }
      }
      return;
    }

    if (!this.pending) {
      this.pending = { startAtMs: atMs, endAtMs: atMs, data: event.data, eventCount: 1 };
    } else {
      this.pending.endAtMs = atMs;
      this.pending.data += event.data;
      this.pending.eventCount += 1;
    }
    if (this.pending.endAtMs - this.pending.startAtMs >= SAMPLE_INTERVAL_MS) {
      await this.flushPending();
    }
  }

  async snapshot(endAtMs: number, live: boolean): Promise<TerminalReplayMotionSnapshot> {
    await this.flushPending();
    const spans = [...this.spans];
    const candidate = this.candidateSpan(live);
    if (candidate) spans.push(candidate);
    if (
      this.lastRawAtMs !== null &&
      endAtMs - this.lastRawAtMs >= IDLE_MARKER_MS &&
      !spans.some((span) => span.endAtMs === endAtMs && span.kind === 'idle')
    ) {
      spans.push(this.idleSpan(this.lastRawAtMs, endAtMs, live));
    }
    return {
      spans: spans.sort((left, right) => left.startAtMs - right.startAtMs),
      totalEvents: this.totalEventsValue,
      sampledFrames: this.sampledFramesValue,
      motionEvents: this.motionEventsValue,
    };
  }

  async finish(endAtMs: number): Promise<TerminalReplayMotionSnapshot> {
    await this.flushPending();
    this.closeCandidate(endAtMs);
    if (this.lastRawAtMs !== null && endAtMs - this.lastRawAtMs >= IDLE_MARKER_MS) {
      this.addIdle(this.lastRawAtMs, endAtMs, false);
    }
    this.finished = true;
    return this.snapshot(endAtMs, false);
  }

  dispose(): void {
    this.terminal.dispose();
  }

  private async flushPending(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    await writeTerminal(this.terminal, pending.data);
    const current = screenSnapshot(this.terminal, pending.endAtMs);
    this.sampledFramesValue += 1;
    if (this.previous) {
      const verdict = classifyFrame(
        this.previous,
        current,
        pending.data,
        this.recentScreens,
        this.options.cli,
      );
      if (verdict.motion) {
        this.motionEventsValue += pending.eventCount;
        this.extendCandidate(this.previous.atMs, current.atMs, pending.eventCount, verdict);
      } else if (this.candidate && current.atMs - this.candidate.lastMotionAtMs > MOTION_GRACE_MS) {
        this.closeCandidate(this.candidate.lastMotionAtMs);
      }
    }
    this.previous = current;
    this.rememberScreen(current);
  }

  private rememberScreen(snapshot: ScreenSnapshot): void {
    this.recentScreens.push(snapshot.normalizedRows.join('\n'));
    if (this.recentScreens.length > 18) this.recentScreens.shift();
  }

  private extendCandidate(
    startAtMs: number,
    endAtMs: number,
    eventCount: number,
    verdict: FrameVerdict,
  ): void {
    if (!this.candidate || startAtMs - this.candidate.lastMotionAtMs > MOTION_GRACE_MS) {
      this.closeCandidate(this.candidate?.lastMotionAtMs ?? startAtMs);
      this.candidate = {
        startAtMs,
        endAtMs,
        lastMotionAtMs: endAtMs,
        frames: 1,
        eventCount,
        score: verdict.score,
        hints: new Set(verdict.hint ? [verdict.hint] : []),
      };
      return;
    }
    this.candidate.endAtMs = endAtMs;
    this.candidate.lastMotionAtMs = endAtMs;
    this.candidate.frames += 1;
    this.candidate.eventCount += eventCount;
    this.candidate.score += verdict.score;
    if (verdict.hint) this.candidate.hints.add(verdict.hint);
  }

  private candidateSpan(live: boolean): TerminalReplayCompressionSpanDto | null {
    const candidate = this.candidate;
    if (!candidate) return null;
    const duration = Math.max(0, candidate.endAtMs - candidate.startAtMs);
    if (duration < MIN_MOTION_DURATION_MS || candidate.frames < MIN_MOTION_FRAMES) return null;
    const kind = spanKind(candidate.hints);
    const averageScore = candidate.score / Math.max(1, candidate.frames);
    return {
      id: `${this.options.segmentId.slice(0, 150)}:${kind}:${Math.round(candidate.startAtMs)}`,
      startAtMs: Math.round(candidate.startAtMs),
      endAtMs: Math.round(candidate.endAtMs),
      kind,
      label: spanLabel(kind, candidate.hints),
      confidence: candidate.frames >= 10 || averageScore >= 7 ? 'high' : 'medium',
      originalDurationMs: Math.round(duration),
      suggestedDurationMs: Math.min(
        Math.round(duration),
        Math.round(clamp(850 + Math.log2(Math.max(1, duration / 1_000)) * 180, 900, 1_800)),
      ),
      eventCount: candidate.eventCount,
      live,
    };
  }

  private closeCandidate(endAtMs: number): void {
    if (!this.candidate) return;
    this.candidate.endAtMs = Math.min(this.candidate.endAtMs, endAtMs);
    const span = this.candidateSpan(false);
    if (span) this.spans.push(span);
    this.candidate = null;
  }

  private idleSpan(
    startAtMs: number,
    endAtMs: number,
    live: boolean,
  ): TerminalReplayCompressionSpanDto {
    const duration = Math.max(0, endAtMs - startAtMs);
    return {
      id: `${this.options.segmentId.slice(0, 150)}:idle:${Math.round(startAtMs)}`,
      startAtMs: Math.round(startAtMs),
      endAtMs: Math.round(endAtMs),
      kind: 'idle',
      label: spanLabel('idle', new Set()),
      confidence: 'high',
      originalDurationMs: Math.round(duration),
      suggestedDurationMs: Math.min(800, Math.round(duration)),
      eventCount: 0,
      live,
    };
  }

  private addIdle(startAtMs: number, endAtMs: number, live: boolean): void {
    const span = this.idleSpan(startAtMs, endAtMs, live);
    const previous = this.spans.at(-1);
    if (previous?.id === span.id) return;
    this.spans.push(span);
  }
}

/** Test/helper seam for a finite segment. */
export async function analyzeTerminalReplayEvents(
  events: readonly TerminalReplayEventDto[],
  options: TerminalReplayMotionAnalyzerOptions,
  endAtMs = events.at(-1)?.atMs ?? options.timelineStartMs,
): Promise<TerminalReplayMotionSnapshot> {
  const analyzer = new TerminalReplayMotionAnalyzer(options);
  try {
    for (const event of events) await analyzer.ingest(event);
    return await analyzer.finish(endAtMs);
  } finally {
    analyzer.dispose();
  }
}
