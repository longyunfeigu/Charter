import { describe, expect, it } from 'vitest';
import type { TerminalReplayEventDto } from '@pi-ide/ipc-contracts';
import { analyzeTerminalReplayEvents } from './terminal-replay-motion.js';

const options = {
  segmentId: 'segment-test',
  timelineStartMs: 0,
  cols: 100,
  rows: 30,
  cli: 'codex',
};

function output(atMs: number, data: string): TerminalReplayEventDto {
  return { atMs, code: 'o', data };
}

describe('TerminalReplayMotionAnalyzer', () => {
  it('recognizes an in-place agent thinking animation', async () => {
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];
    const events = Array.from({ length: 81 }, (_, index) =>
      output(index * 100, `\r\x1b[2K${spinner[index % spinner.length]} Thinking ${index / 10}s`),
    );
    events.push(output(8_200, '\r\x1b[2KDone\n'));

    const result = await analyzeTerminalReplayEvents(events, options, 8_200);

    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({ kind: 'thinking', label: 'Agent thinking' });
    expect(result.spans[0]!.originalDurationMs).toBeGreaterThan(7_000);
    expect(result.spans[0]!.suggestedDurationMs).toBeLessThan(1_800);
  });

  it('does not classify a streamed answer that grows meaningful text', async () => {
    const chunks = 'A careful answer should stay readable even while it arrives token by token.';
    const events = [...chunks].map((character, index) => output(index * 80, character));

    const result = await analyzeTerminalReplayEvents(events, options);

    expect(result.spans.filter((span) => span.kind !== 'idle')).toEqual([]);
  });

  it('does not classify scrolling build logs as terminal motion', async () => {
    const events = Array.from({ length: 120 }, (_, index) =>
      output(index * 75, `compiled src/module-${index}.ts successfully\r\n`),
    );

    const result = await analyzeTerminalReplayEvents(events, options);

    expect(result.spans.filter((span) => span.kind !== 'idle')).toEqual([]);
  });

  it('recognizes a destructive in-place progress display', async () => {
    const events = Array.from({ length: 61 }, (_, index) =>
      output(index * 100, `\r\x1b[2KBuilding ${Math.min(100, index * 2)}%`),
    );

    const result = await analyzeTerminalReplayEvents(events, options);

    expect(result.spans.some((span) => span.kind === 'progress')).toBe(true);
  });

  it('indexes long no-output gaps separately from inferred thinking', async () => {
    const result = await analyzeTerminalReplayEvents(
      [output(0, 'prompt\r\n'), output(10_000, 'answer\r\n')],
      options,
      10_000,
    );

    expect(result.spans).toEqual([
      expect.objectContaining({
        kind: 'idle',
        label: 'No terminal activity',
        originalDurationMs: 10_000,
      }),
    ]);
  });

  it('survives terminal resizes between animated regions', async () => {
    const events: TerminalReplayEventDto[] = [
      output(0, 'ready\r\n'),
      { atMs: 100, code: 'r', data: '132x42' },
      ...Array.from({ length: 30 }, (_, index) =>
        output(200 + index * 100, `\r\x1b[2KWorking ${index}s`),
      ),
    ];

    const result = await analyzeTerminalReplayEvents(events, options);

    expect(result.sampledFrames).toBeGreaterThan(10);
    expect(result.spans.some((span) => span.kind === 'thinking')).toBe(true);
  });
});
