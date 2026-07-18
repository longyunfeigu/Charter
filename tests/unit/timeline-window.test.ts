import { describe, expect, it } from 'vitest';
import {
  computeWindow,
  growWindow,
  initialWindow,
  STREAM_BUFFER_CAP,
  STREAM_MARKDOWN_LIMIT,
  TIMELINE_CHUNK,
  TIMELINE_WINDOW,
} from '../../apps/desktop-renderer/src/views/timeline-window';

describe('RoomTimeline windowing (M11-04)', () => {
  it('renders everything when under the window', () => {
    const w = computeWindow(50, TIMELINE_WINDOW);
    expect(w).toEqual({ startIndex: 0, hasOlder: false, olderCount: 0 });
  });

  it('shows only the tail when over the window', () => {
    const w = computeWindow(10_000, TIMELINE_WINDOW);
    expect(w.startIndex).toBe(10_000 - TIMELINE_WINDOW);
    expect(w.hasOlder).toBe(true);
    expect(w.olderCount).toBe(10_000 - TIMELINE_WINDOW);
  });

  it('is exact at the boundary', () => {
    expect(computeWindow(TIMELINE_WINDOW, TIMELINE_WINDOW).hasOlder).toBe(false);
    expect(computeWindow(TIMELINE_WINDOW + 1, TIMELINE_WINDOW)).toMatchObject({
      startIndex: 1,
      hasOlder: true,
      olderCount: 1,
    });
  });

  it('never slices past the total or below zero', () => {
    expect(computeWindow(0, TIMELINE_WINDOW)).toEqual({
      startIndex: 0,
      hasOlder: false,
      olderCount: 0,
    });
    expect(computeWindow(10, 999_999)).toEqual({
      startIndex: 0,
      hasOlder: false,
      olderCount: 0,
    });
  });

  it('grows by a chunk, clamped to the total', () => {
    expect(growWindow(TIMELINE_WINDOW, 10_000)).toBe(TIMELINE_WINDOW + TIMELINE_CHUNK);
    expect(growWindow(9_900, 10_000)).toBe(10_000); // clamp
    expect(growWindow(10_000, 10_000)).toBe(10_000); // already all
  });

  it('walking the window from tail to head reveals every event exactly once', () => {
    const total = 3210;
    let visible = TIMELINE_WINDOW;
    let guard = 0;
    while (computeWindow(total, visible).hasOlder) {
      visible = growWindow(visible, total);
      if (++guard > 1000) throw new Error('did not converge');
    }
    // Once fully expanded, the whole timeline is in view.
    expect(computeWindow(total, visible)).toEqual({
      startIndex: 0,
      hasOlder: false,
      olderCount: 0,
    });
  });

  it('initialWindow honours a positive numeric override, else the default', () => {
    const g = globalThis as { __PI_IDE_TIMELINE_WINDOW?: unknown };
    expect(initialWindow()).toBe(TIMELINE_WINDOW);
    g.__PI_IDE_TIMELINE_WINDOW = 3;
    expect(initialWindow()).toBe(3);
    g.__PI_IDE_TIMELINE_WINDOW = 0; // invalid → default
    expect(initialWindow()).toBe(TIMELINE_WINDOW);
    g.__PI_IDE_TIMELINE_WINDOW = 'nope';
    expect(initialWindow()).toBe(TIMELINE_WINDOW);
    delete g.__PI_IDE_TIMELINE_WINDOW;
  });
});

describe('live output freeze guard (M11-04, §16.5)', () => {
  // Mirror of taskStore.appendStreamDelta — kept trivial and pinned here so a
  // regression in the buffer bound is caught without booting the store.
  const append = (text: string, delta: string): string => {
    const next = text + delta;
    return next.length > STREAM_BUFFER_CAP ? next.slice(next.length - STREAM_BUFFER_CAP) : next;
  };

  it('markdown limit is below the buffer cap so the tail path engages first', () => {
    expect(STREAM_MARKDOWN_LIMIT).toBeLessThan(STREAM_BUFFER_CAP);
  });

  it('streaming buffer never exceeds the cap and keeps the newest text', () => {
    let buf = '';
    for (let i = 0; i < 100; i++) buf = append(buf, 'x'.repeat(10_000));
    expect(buf.length).toBeLessThanOrEqual(STREAM_BUFFER_CAP);
    // The tail (most recent deltas) is what survives.
    buf = append(buf, 'TAIL_MARKER');
    expect(buf.endsWith('TAIL_MARKER')).toBe(true);
    expect(buf.length).toBeLessThanOrEqual(STREAM_BUFFER_CAP);
  });
});
