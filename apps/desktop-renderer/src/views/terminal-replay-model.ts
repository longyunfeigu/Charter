import type { TerminalReplayCompressionSpanDto } from '@pi-ide/ipc-contracts';

export type TerminalReplayCode = 'o' | 'r' | 'reset';

export interface TerminalReplayRawEvent {
  atMs: number;
  code: TerminalReplayCode;
  data: string;
  cols?: number;
  rows?: number;
}

export interface TerminalReplayTimedEvent extends TerminalReplayRawEvent {
  playAtMs: number;
}

export interface TerminalReplayTimingOptions {
  /** null means retain the real gap. */
  idleCapMs: number | null;
  /** null means no target-duration transform. */
  targetMs: number | null;
  speed: number;
  compressionSpans?: readonly TerminalReplayCompressionSpanDto[];
  expandedSpanIds?: ReadonlySet<string>;
}

export interface TerminalReplayMarker extends TerminalReplayCompressionSpanDto {
  playStartMs: number;
  playEndMs: number;
  playDurationMs: number;
  expanded: boolean;
}

export interface TerminalReplayTimeline {
  events: TerminalReplayTimedEvent[];
  durationMs: number;
  firstVisibleAtMs: number;
  markers: TerminalReplayMarker[];
}

function sameRawEvent(
  left: TerminalReplayTimedEvent | undefined,
  right: TerminalReplayTimedEvent | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.atMs === right.atMs &&
    left.code === right.code &&
    left.data === right.data &&
    left.cols === right.cols &&
    left.rows === right.rows,
  );
}

/** Output gaps at or below this threshold are readable streaming rhythm. */
export const TERMINAL_REPLAY_STREAM_GAP_MS = 250;

interface TimedGap {
  event: TerminalReplayRawEvent;
  rawAtMs: number;
  gapMs: number;
  locked: boolean;
}

function smartGap(
  startAtMs: number,
  endAtMs: number,
  spans: readonly TerminalReplayCompressionSpanDto[],
  expandedSpanIds: ReadonlySet<string>,
): { durationMs: number; locked: boolean } {
  if (endAtMs <= startAtMs || spans.length === 0) {
    return { durationMs: Math.max(0, endAtMs - startAtMs), locked: false };
  }
  let cursor = startAtMs;
  let durationMs = 0;
  let locked = false;
  for (const span of spans) {
    if (span.endAtMs <= cursor) continue;
    if (span.startAtMs >= endAtMs) break;
    const overlapStart = Math.max(cursor, startAtMs, span.startAtMs);
    const overlapEnd = Math.min(endAtMs, span.endAtMs);
    if (overlapEnd <= overlapStart) continue;
    durationMs += Math.max(0, overlapStart - cursor);
    const expanded = expandedSpanIds.has(span.id);
    if (expanded) locked = true;
    const ratio = expanded
      ? 1
      : Math.max(0, Math.min(1, span.suggestedDurationMs / Math.max(1, span.originalDurationMs)));
    durationMs += (overlapEnd - overlapStart) * ratio;
    cursor = overlapEnd;
  }
  durationMs += Math.max(0, endAtMs - cursor);
  return { durationMs, locked };
}

function mapRawTime(events: readonly TerminalReplayTimedEvent[], rawAtMs: number): number {
  if (events.length === 0) return 0;
  let low = 0;
  let high = events.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (events[middle]!.atMs < rawAtMs) low = middle + 1;
    else high = middle - 1;
  }
  const right = events[Math.min(events.length - 1, low)];
  const left = events[Math.max(0, low - 1)];
  if (!left) return right?.playAtMs ?? 0;
  if (!right || right.atMs === left.atMs) return left.playAtMs;
  const progress = Math.max(0, Math.min(1, (rawAtMs - left.atMs) / (right.atMs - left.atMs)));
  return Math.round(left.playAtMs + (right.playAtMs - left.playAtMs) * progress);
}

/**
 * Fanbox's essential timing model: retain every byte, preserve streaming
 * rhythm, and spend the target-duration budget only on otherwise-idle gaps.
 */
export function buildTerminalReplayTimeline(
  input: readonly TerminalReplayRawEvent[],
  options: TerminalReplayTimingOptions,
): TerminalReplayTimeline {
  if (input.length === 0) return { events: [], durationMs: 0, firstVisibleAtMs: 0, markers: [] };
  const ordered = input
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.atMs - right.event.atMs || left.index - right.index)
    .map(({ event }) => event);
  const firstOutput = ordered.find((event) => event.code === 'o');
  const firstVisibleAtMs = firstOutput?.atMs ?? ordered[0]!.atMs;
  const spans = [...(options.compressionSpans ?? [])]
    .filter((span) => span.endAtMs > span.startAtMs)
    .sort((left, right) => left.startAtMs - right.startAtMs || left.endAtMs - right.endAtMs);
  const expandedSpanIds = options.expandedSpanIds ?? new Set<string>();
  let previousRawAtMs = firstVisibleAtMs;
  const gaps: TimedGap[] = ordered.map((event) => {
    const rawMs = Math.max(0, event.atMs - firstVisibleAtMs);
    const realGapMs = Math.max(0, event.atMs - previousRawAtMs);
    const smart = smartGap(previousRawAtMs, event.atMs, spans, expandedSpanIds);
    previousRawAtMs = Math.max(previousRawAtMs, event.atMs);
    return {
      event,
      rawAtMs: rawMs,
      gapMs:
        options.idleCapMs === null || smart.locked
          ? smart.durationMs
          : Math.min(smart.durationMs, options.idleCapMs),
      locked: smart.locked,
    };
  });

  if (options.targetMs !== null) {
    let streamMs = 0;
    let idleMs = 0;
    for (const gap of gaps) {
      if (gap.locked || gap.gapMs <= TERMINAL_REPLAY_STREAM_GAP_MS) streamMs += gap.gapMs;
      else idleMs += gap.gapMs;
    }
    const idleBudgetMs = Math.max(0, options.targetMs - streamMs);
    if (idleMs > idleBudgetMs && idleMs > 0) {
      const ratio = idleBudgetMs / idleMs;
      for (const gap of gaps) {
        if (!gap.locked && gap.gapMs > TERMINAL_REPLAY_STREAM_GAP_MS) gap.gapMs *= ratio;
      }
    }
  }

  const speed = Number.isFinite(options.speed) && options.speed > 0 ? options.speed : 1;
  let elapsedMs = 0;
  const events = gaps.map(({ event, gapMs }) => {
    elapsedMs += gapMs / speed;
    return { ...event, playAtMs: Math.round(elapsedMs) };
  });
  const markers = spans
    .map((span): TerminalReplayMarker | null => {
      const playStartMs = mapRawTime(events, Math.max(firstVisibleAtMs, span.startAtMs));
      const playEndMs = mapRawTime(events, Math.max(firstVisibleAtMs, span.endAtMs));
      if (playEndMs < 0 || playStartMs > elapsedMs) return null;
      return {
        ...span,
        playStartMs: Math.max(0, playStartMs),
        playEndMs: Math.max(playStartMs, playEndMs),
        playDurationMs: Math.max(0, playEndMs - playStartMs),
        expanded: expandedSpanIds.has(span.id),
      };
    })
    .filter((marker): marker is TerminalReplayMarker => marker !== null);
  return {
    events,
    durationMs: events.at(-1)?.playAtMs ?? 0,
    firstVisibleAtMs,
    markers,
  };
}

/**
 * Keep the viewer on the same semantic point when an append-only live stream
 * causes the smart-time mapping to be recalculated. `consumedEvents` is the
 * raw event cursor already painted into xterm.
 */
export function rebaseTerminalReplayTime(
  previous: TerminalReplayTimeline,
  next: TerminalReplayTimeline,
  consumedEvents: number,
  currentMs: number,
): number {
  if (next.durationMs <= 0) return 0;
  const clampedCurrent = Math.max(0, Math.min(previous.durationMs, currentMs));
  const consumed = Math.max(
    0,
    Math.min(consumedEvents, previous.events.length, next.events.length),
  );

  if (consumed === 0) {
    const previousFirst = previous.events[0]?.playAtMs ?? previous.durationMs;
    const nextFirst = next.events[0]?.playAtMs ?? next.durationMs;
    const progress = previousFirst > 0 ? Math.min(1, clampedCurrent / previousFirst) : 0;
    return Math.round(Math.max(0, Math.min(next.durationMs, nextFirst * progress)));
  }

  const previousMarker = previous.events[consumed - 1];
  const nextMarker = next.events[consumed - 1];
  if (!sameRawEvent(previousMarker, nextMarker)) {
    return Math.round(Math.max(0, Math.min(next.durationMs, clampedCurrent)));
  }

  const previousStart = previousMarker!.playAtMs;
  const nextStart = nextMarker!.playAtMs;
  const previousEnd = previous.events[consumed]?.playAtMs ?? previous.durationMs;
  const nextEnd = next.events[consumed]?.playAtMs ?? next.durationMs;
  const previousGap = Math.max(0, previousEnd - previousStart);
  const gapProgress =
    previousGap > 0 ? Math.max(0, Math.min(1, (clampedCurrent - previousStart) / previousGap)) : 0;
  return Math.round(
    Math.max(0, Math.min(next.durationMs, nextStart + (nextEnd - nextStart) * gapProgress)),
  );
}

export function formatTerminalReplayTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function formatTerminalReplayDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
