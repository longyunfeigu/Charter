import { describe, expect, it } from 'vitest';
import {
  buildTerminalReplayTimeline,
  rebaseTerminalReplayTime,
  type TerminalReplayRawEvent,
} from './terminal-replay-model.js';
import type { TerminalReplayCompressionSpanDto } from '@pi-ide/ipc-contracts';

const output = (atMs: number, data: string): TerminalReplayRawEvent => ({
  atMs,
  code: 'o',
  data,
});

const thinkingSpan: TerminalReplayCompressionSpanDto = {
  id: 'thinking:1',
  startAtMs: 1_000,
  endAtMs: 11_000,
  kind: 'thinking',
  label: 'Agent thinking',
  confidence: 'high',
  originalDurationMs: 10_000,
  suggestedDurationMs: 1_000,
  eventCount: 101,
  live: false,
};

describe('terminal replay smart time', () => {
  it('retains every event while compressing an eight-hour sparse session', () => {
    const events = [
      output(0, 'user: one'),
      output(100, 'agent: one'),
      output(4 * 60 * 60 * 1000, 'user: two'),
      output(4 * 60 * 60 * 1000 + 100, 'agent: two'),
      output(8 * 60 * 60 * 1000, 'done'),
    ];
    const timeline = buildTerminalReplayTimeline(events, {
      idleCapMs: 1000,
      targetMs: 60_000,
      speed: 1,
    });
    expect(timeline.events.map((event) => event.data)).toEqual(events.map((event) => event.data));
    expect(timeline.durationMs).toBeLessThan(3_000);
  });

  it('keeps original time when compression is disabled', () => {
    const timeline = buildTerminalReplayTimeline([output(1_000, 'a'), output(11_000, 'b')], {
      idleCapMs: null,
      targetMs: null,
      speed: 1,
    });
    expect(timeline.durationMs).toBe(10_000);
  });

  it('never crushes continuous streaming output merely to hit the target', () => {
    const events = Array.from({ length: 101 }, (_, index) => output(index * 200, `${index}`));
    const timeline = buildTerminalReplayTimeline(events, {
      idleCapMs: 1000,
      targetMs: 1_000,
      speed: 1,
    });
    expect(timeline.durationMs).toBe(20_000);
    expect(timeline.events).toHaveLength(events.length);
  });

  it('applies manual speed after non-destructive idle compression', () => {
    const events = [output(0, 'a'), output(10_000, 'b')];
    const normal = buildTerminalReplayTimeline(events, {
      idleCapMs: 1000,
      targetMs: null,
      speed: 1,
    });
    const fast = buildTerminalReplayTimeline(events, {
      idleCapMs: 1000,
      targetMs: null,
      speed: 2,
    });
    expect(normal.durationMs).toBe(1_000);
    expect(fast.durationMs).toBe(500);
  });

  it('keeps an append-only live replay at its existing tail instead of rewinding', () => {
    const options = { idleCapMs: 1_000, targetMs: null, speed: 1 };
    const previous = buildTerminalReplayTimeline(
      [output(0, 'ready'), output(800, 'first')],
      options,
    );
    const next = buildTerminalReplayTimeline(
      [output(0, 'ready'), output(800, 'first'), output(1_600, 'second')],
      options,
    );

    expect(rebaseTerminalReplayTime(previous, next, 2, previous.durationMs)).toBe(800);
  });

  it('preserves progress inside a gap when smart timing is recalculated', () => {
    const events = [output(0, 'ready'), output(10_000, 'first'), output(20_000, 'second')];
    const previous = buildTerminalReplayTimeline(events, {
      idleCapMs: null,
      targetMs: null,
      speed: 1,
    });
    const next = buildTerminalReplayTimeline(events, {
      idleCapMs: 1_000,
      targetMs: null,
      speed: 1,
    });

    expect(rebaseTerminalReplayTime(previous, next, 2, 15_000)).toBe(1_500);
  });

  it('accelerates every frame inside an analyzed thinking span without dropping events', () => {
    const events = Array.from({ length: 101 }, (_, index) =>
      output(1_000 + index * 100, `frame-${index}`),
    );
    const timeline = buildTerminalReplayTimeline(events, {
      idleCapMs: 1_000,
      targetMs: null,
      speed: 1,
      compressionSpans: [thinkingSpan],
    });

    expect(timeline.events).toHaveLength(events.length);
    expect(timeline.durationMs).toBe(1_000);
    expect(timeline.markers[0]).toMatchObject({
      id: thinkingSpan.id,
      playDurationMs: 1_000,
      expanded: false,
    });
  });

  it('restores analyzed spans to original timing when the viewer expands one', () => {
    const events = Array.from({ length: 101 }, (_, index) =>
      output(1_000 + index * 100, `frame-${index}`),
    );
    const timeline = buildTerminalReplayTimeline(events, {
      idleCapMs: 300,
      targetMs: 1_000,
      speed: 1,
      compressionSpans: [thinkingSpan],
      expandedSpanIds: new Set([thinkingSpan.id]),
    });

    expect(timeline.durationMs).toBe(10_000);
    expect(timeline.markers[0]).toMatchObject({ expanded: true, playDurationMs: 10_000 });
  });
});
