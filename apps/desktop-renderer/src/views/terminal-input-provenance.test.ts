import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalUserInputTracker } from './terminal-input-provenance.js';

describe('TerminalUserInputTracker', () => {
  afterEach(() => vi.useRealTimers());

  it('classifies only the next terminal data chunk after a real user gesture', () => {
    const tracker = new TerminalUserInputTracker();
    expect(tracker.consume()).toBe(false);

    tracker.mark();
    expect(tracker.consume()).toBe(true);
    expect(tracker.consume()).toBe(false);
  });

  it('collapses overlapping DOM signals and expires an unconsumed gesture', () => {
    vi.useFakeTimers();
    const tracker = new TerminalUserInputTracker();
    tracker.mark();
    tracker.mark();
    expect(tracker.consume()).toBe(true);
    expect(tracker.consume()).toBe(false);

    tracker.mark();
    vi.advanceTimersByTime(251);
    expect(tracker.consume()).toBe(false);
  });
});
