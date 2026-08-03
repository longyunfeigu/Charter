import { describe, expect, it } from 'vitest';
import { TerminalOutputDispatcher } from '../../apps/desktop-main/src/services/terminal-output-dispatcher.js';
import { TerminalInputWriter } from '../../apps/desktop-renderer/src/views/terminal-input-writer.js';
import { measure, measureAsync, report } from './perf-lib.js';

describe('terminal transport at interactive load', () => {
  it('coalesces 50k tiny PTY emissions without an event-loop-sized CPU spike', () => {
    const stats = measure(6, () => {
      let deliveredBytes = 0;
      const dispatcher = new TerminalOutputDispatcher(
        (delivery) => {
          deliveredBytes += delivery.data.length;
        },
        {
          schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
          cancel: () => undefined,
        },
      );
      for (let index = 0; index < 50_000; index += 1) {
        dispatcher.push('term', 'x', index);
      }
      dispatcher.flush('term');
      dispatcher.dispose();
      expect(deliveredBytes).toBe(50_000);
    });
    report('terminal output coalescing (50k emissions)', stats);
    expect(stats.p95).toBeLessThan(150);
  });

  it('dispatches 10k keystrokes through the one-way coalescing lane', async () => {
    const stats = await measureAsync(6, async () => {
      let delivered = '';
      const writer = new TerminalInputWriter(
        (input) => {
          delivered += input.data;
        },
        { wait: async () => undefined },
      );
      for (let index = 0; index < 10_000; index += 1) {
        writer.enqueue({ id: 'term', data: 'x', userInitiated: true });
      }
      await writer.settle();
      expect(delivered.length).toBe(10_000);
    });
    report('terminal input dispatch (10k keystrokes)', stats);
    expect(stats.p95).toBeLessThan(75);
  });

  it('delivers a 1 MiB paste with accepted 256-byte TTY-safe chunks', async () => {
    const paste = '界'.repeat(Math.floor((1024 * 1024) / 3));
    const stats = await measureAsync(4, async () => {
      let delivered = '';
      let acceptedChunks = 0;
      let maxChunkBytes = 0;
      const writer = new TerminalInputWriter(() => undefined, {
        sendAccepted: async (input) => {
          delivered += input.data;
          acceptedChunks += 1;
          maxChunkBytes = Math.max(maxChunkBytes, Buffer.byteLength(input.data));
        },
        wait: async () => undefined,
      });
      writer.enqueue({ id: 'term', data: paste, userInitiated: true, paste: true });
      await writer.settle();
      expect(delivered).toBe(paste);
      expect(maxChunkBytes).toBeLessThanOrEqual(256);
      expect(acceptedChunks).toBeGreaterThan(4_000);
      expect(acceptedChunks).toBeLessThan(4_200);
    });
    report('terminal accepted TTY-safe paste (1 MiB UTF-8)', stats);
    expect(stats.p95).toBeLessThan(150);
  });
});
