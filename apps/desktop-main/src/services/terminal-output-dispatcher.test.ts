import { describe, expect, it, vi } from 'vitest';
import {
  TerminalOutputDispatcher,
  type TerminalOutputDelivery,
} from './terminal-output-dispatcher.js';

describe('TerminalOutputDispatcher', () => {
  it('coalesces small output and preserves the newest daemon sequence', () => {
    vi.useFakeTimers();
    const deliveries: TerminalOutputDelivery[] = [];
    const dispatcher = new TerminalOutputDispatcher((delivery) => deliveries.push(delivery));

    dispatcher.push('a', 'one', 1);
    dispatcher.push('a', 'two', 2);
    expect(deliveries).toEqual([]);
    vi.advanceTimersByTime(2);

    expect(deliveries).toEqual([{ id: 'a', data: 'onetwo', sequence: 2, deliveryId: 1 }]);
    vi.useRealTimers();
  });

  it('sends an input-adjacent foreground redraw immediately', () => {
    const deliveries: TerminalOutputDelivery[] = [];
    const dispatcher = new TerminalOutputDispatcher((delivery) => deliveries.push(delivery));
    dispatcher.setActive('a');
    dispatcher.noteInput('a');

    dispatcher.push('a', '\u001b[2K\rprompt');

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.data).toBe('\u001b[2K\rprompt');
  });

  it('holds output above the high-water mark until xterm acknowledges it', () => {
    vi.useFakeTimers();
    const deliveries: TerminalOutputDelivery[] = [];
    const dispatcher = new TerminalOutputDispatcher((delivery) => deliveries.push(delivery), {
      maxChunkSize: 4,
      terminalHighWaterMark: 4,
      maxWritesPerDrain: 8,
    });
    dispatcher.push('a', 'aaaa');
    dispatcher.push('a', 'bbbb');
    vi.advanceTimersByTime(2);
    expect(deliveries.map((delivery) => delivery.data)).toEqual(['aaaa']);

    dispatcher.acknowledge('a', deliveries[0]!.deliveryId);
    vi.runOnlyPendingTimers();
    expect(deliveries.map((delivery) => delivery.data)).toEqual(['aaaa', 'bbbb']);
    vi.useRealTimers();
  });

  it('prioritizes the active terminal and round-robins background sessions', () => {
    vi.useFakeTimers();
    const deliveries: TerminalOutputDelivery[] = [];
    const dispatcher = new TerminalOutputDispatcher((delivery) => deliveries.push(delivery), {
      maxWritesPerDrain: 2,
    });
    dispatcher.setActive('active');
    dispatcher.push('background-1', 'b1');
    dispatcher.push('active', 'a');
    dispatcher.push('background-2', 'b2');
    vi.advanceTimersByTime(2);

    expect(deliveries[0]!.id).toBe('active');
    expect(deliveries[1]!.id).toBe('background-1');
    vi.runOnlyPendingTimers();
    expect(deliveries[2]!.id).toBe('background-2');
    vi.useRealTimers();
  });

  it('reserves global renderer credit for the active terminal', () => {
    vi.useFakeTimers();
    const deliveries: TerminalOutputDelivery[] = [];
    const dispatcher = new TerminalOutputDispatcher((delivery) => deliveries.push(delivery), {
      maxChunkSize: 4,
      maxWritesPerDrain: 8,
      terminalHighWaterMark: 16,
      globalHighWaterMark: 8,
      activeReserveBytes: 4,
    });
    dispatcher.setActive('active');
    dispatcher.push('background', 'bbbb');
    dispatcher.push('background', 'cccc');
    vi.advanceTimersByTime(2);
    expect(deliveries.map((delivery) => delivery.data)).toEqual(['bbbb']);

    dispatcher.noteInput('active');
    dispatcher.push('active', '\r>>>');
    expect(deliveries.map((delivery) => delivery.data)).toEqual(['bbbb', '\r>>>']);
    vi.useRealTimers();
  });
});
