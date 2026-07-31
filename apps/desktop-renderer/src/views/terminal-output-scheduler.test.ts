import { describe, expect, it, vi } from 'vitest';
import {
  TerminalOutputScheduler,
  type ScheduledTerminalOutput,
} from './terminal-output-scheduler.js';

describe('TerminalOutputScheduler', () => {
  it('renders foreground output before background queues', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const scheduler = new TerminalOutputScheduler(
      (output, done) => {
        writes.push(output.id);
        done();
        return true;
      },
      () => undefined,
    );
    scheduler.setForeground('active');
    scheduler.enqueue({ id: 'background', data: 'b' });
    scheduler.enqueue({ id: 'active', data: 'a' });

    vi.advanceTimersByTime(4);
    expect(writes[0]).toBe('active');
    vi.advanceTimersByTime(50);
    expect(writes).toContain('background');
    vi.useRealTimers();
  });

  it('acknowledges only after xterm completes parsing', () => {
    vi.useFakeTimers();
    let complete: (() => void) | null = null;
    const acknowledgements: number[] = [];
    const scheduler = new TerminalOutputScheduler(
      (_output, done) => {
        complete = done;
        return true;
      },
      (_id, deliveryId) => acknowledgements.push(deliveryId),
    );
    scheduler.setForeground('a');
    scheduler.enqueue({ id: 'a', data: 'output', deliveryId: 7 });
    vi.advanceTimersByTime(4);
    expect(acknowledgements).toEqual([]);

    complete!();
    expect(acknowledgements).toEqual([7]);
    vi.useRealTimers();
  });

  it('does not starve background terminals during foreground output', () => {
    vi.useFakeTimers();
    const writes: ScheduledTerminalOutput[] = [];
    const scheduler = new TerminalOutputScheduler(
      (output, done) => {
        writes.push(output);
        done();
        return true;
      },
      () => undefined,
      { maxForegroundWrites: 2, maxBackgroundWrites: 1 },
    );
    scheduler.setForeground('active');
    for (let index = 0; index < 5; index += 1) {
      scheduler.enqueue({ id: 'active', data: `a${index}` });
    }
    scheduler.enqueue({ id: 'background', data: 'b' });
    vi.advanceTimersByTime(4);

    expect(writes.slice(0, 2).map((output) => output.id)).toEqual(['active', 'background']);
    vi.runAllTimers();
    expect(writes.filter((output) => output.id === 'active')).toHaveLength(5);
    vi.useRealTimers();
  });

  it('waits for accepted parser writes before running an exit barrier', () => {
    vi.useFakeTimers();
    let complete: (() => void) | null = null;
    const barrier = vi.fn();
    const scheduler = new TerminalOutputScheduler(
      (_, done) => {
        complete = done;
        return true;
      },
      () => undefined,
    );
    scheduler.setForeground('a');
    scheduler.enqueue({ id: 'a', data: 'last' });
    scheduler.after('a', barrier);
    vi.advanceTimersByTime(4);
    expect(barrier).not.toHaveBeenCalled();

    complete!();
    expect(barrier).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('keeps one parser write in flight per terminal', () => {
    vi.useFakeTimers();
    const completions: Array<() => void> = [];
    const writes: string[] = [];
    const scheduler = new TerminalOutputScheduler(
      (output, done) => {
        writes.push(output.data);
        completions.push(done);
        return true;
      },
      () => undefined,
    );
    scheduler.setForeground('a');
    scheduler.enqueue({ id: 'a', data: 'first' });
    scheduler.enqueue({ id: 'a', data: 'second' });
    vi.runOnlyPendingTimers();
    expect(writes).toEqual(['first']);

    completions.shift()!();
    vi.runOnlyPendingTimers();
    expect(writes).toEqual(['first', 'second']);
    vi.useRealTimers();
  });

  it('parses a replacement before live output that arrives during replay', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const completions: Array<() => void> = [];
    const scheduler = new TerminalOutputScheduler(
      (output, done) => {
        writes.push(output.data);
        completions.push(done);
        return true;
      },
      () => undefined,
    );
    scheduler.setForeground('a');
    scheduler.enqueue({ id: 'a', data: 'old' });
    vi.runOnlyPendingTimers();

    let finishReplay: (() => void) | null = null;
    scheduler.replace('a', (done) => {
      writes.push('replay');
      finishReplay = done;
    });
    scheduler.enqueue({ id: 'a', data: 'new' });
    expect(writes).toEqual(['old']);

    completions.shift()!();
    expect(writes).toEqual(['old', 'replay']);
    vi.runOnlyPendingTimers();
    expect(writes).toEqual(['old', 'replay']);

    finishReplay!();
    vi.runOnlyPendingTimers();
    expect(writes).toEqual(['old', 'replay', 'new']);
    vi.useRealTimers();
  });
});
