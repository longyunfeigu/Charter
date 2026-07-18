/**
 * RoomTimeline windowing (M11-04, §16.5). The Room is the product's only main
 * conversation surface; at 10k events, building a React node per event freezes
 * scrolling. We render only the tail (where live activity and the pinned-to-
 * bottom follow live) and reveal older events in chunks on demand. Pure so the
 * boundary math is unit-tested; the component owns the slice + scroll anchoring.
 */

/** Events shown initially and revealed per "load earlier" step. */
export const TIMELINE_WINDOW = 400;
export const TIMELINE_CHUNK = 400;

/**
 * Live-output freeze guard (§16.5: large agent/tool output must not freeze the
 * renderer > 500ms). While streaming, re-parsing the whole markdown string on
 * every delta is O(n) per token — quadratic over a long answer. Past this many
 * characters the live bubble shows a plain-text tail instead (cheap); the
 * completed `agent.message` event still renders the full markdown once settled.
 */
export const STREAM_MARKDOWN_LIMIT = 16_000;

/** Memory bound for the in-flight streaming buffer (the completed event carries the full text). */
export const STREAM_BUFFER_CAP = 256_000;

/**
 * Initial window size, overridable via a global so E2E can force a small window
 * without seeding 10k events. Also a natural seam if this ever becomes a
 * setting. Falsy/invalid overrides fall back to the default.
 */
export function initialWindow(): number {
  const override = (globalThis as { __PI_IDE_TIMELINE_WINDOW?: unknown }).__PI_IDE_TIMELINE_WINDOW;
  return typeof override === 'number' && override > 0 ? override : TIMELINE_WINDOW;
}

export interface TimelineWindow {
  /** First timeline index to render (inclusive). */
  startIndex: number;
  /** Whether older events remain above the window. */
  hasOlder: boolean;
  /** How many events are hidden above the window. */
  olderCount: number;
}

/** Given the total event count and how many the user has chosen to see, resolve the slice. */
export function computeWindow(total: number, visibleCount: number): TimelineWindow {
  const capped = Math.max(0, Math.min(visibleCount, total));
  const startIndex = Math.max(0, total - capped);
  return { startIndex, hasOlder: startIndex > 0, olderCount: startIndex };
}

/** Next visibleCount after a "load earlier" click, clamped to the total. */
export function growWindow(visibleCount: number, total: number, chunk = TIMELINE_CHUNK): number {
  return Math.min(total, visibleCount + chunk);
}
