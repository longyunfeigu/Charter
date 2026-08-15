import { describe, expect, it } from 'vitest';
import {
  mergeScrolledUp,
  readAlternateScreenTranscript,
  similarViewport,
  snapshotRowsText,
  type AlternateScreenTranscriptDriver,
  type TerminalScreenSnapshot,
} from './transcript-read.js';

function snapshot(lines: string[]): TerminalScreenSnapshot {
  return {
    cols: 40,
    rows: lines.map((text) => ({ text, wrapContinuation: false })),
  };
}

describe('Herdr-derived alternate-screen row alignment', () => {
  it('tolerates a small dynamic status region but detects a scrolled viewport', () => {
    const initial = snapshot(['line 1', 'line 2', 'worked for 2s', 'prompt']);
    expect(
      similarViewport(initial, snapshot(['line 1', 'line 2', 'worked for 3s', 'prompt'])),
    ).toBe(true);
    expect(similarViewport(initial, snapshot(['older', 'line 1', 'line 2', 'prompt']))).toBe(false);
  });

  it('prepends newly exposed rows without repeating a fixed header', () => {
    const previous = snapshot(['sticky', 'line 4', 'line 5', 'line 6', 'line 7']);
    const next = snapshot(['sticky', 'line 2', 'line 3', 'line 4', 'line 5']);
    const history = previous.rows.map((row) => ({ ...row }));

    expect(mergeScrolledUp(history, previous, next)).toEqual({ kind: 'advanced', rows: 2 });
    expect(history.map((row) => row.text)).toEqual([
      'line 2',
      'line 3',
      'sticky',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
    ]);
  });

  it('unwraps xterm continuation rows and caps output on a UTF-8 boundary', () => {
    const rows = [
      { text: 'older', wrapContinuation: false },
      { text: '你好', wrapContinuation: false },
      { text: ' world', wrapContinuation: true },
    ];
    expect(snapshotRowsText(rows, { lines: 2, unwrap: true, maxBytes: 100 })).toMatchObject({
      content: '你好 world\n',
      truncated: true,
    });
    const capped = snapshotRowsText(rows, { lines: 2, unwrap: true, maxBytes: 9 });
    expect(capped.content).not.toContain('�');
    expect(capped.bytes).toBeLessThanOrEqual(9);
  });
});

class FrameDriver implements AlternateScreenTranscriptDriver {
  position: number;
  interrupted: string | null = null;
  emergency: Parameters<AlternateScreenTranscriptDriver['setEmergencyRestore']>[0] = null;

  constructor(
    readonly frames: TerminalScreenSnapshot[],
    start = 0,
  ) {
    this.position = start;
  }

  async snapshot(): Promise<TerminalScreenSnapshot> {
    return this.frames[this.position]!;
  }

  async sendWheel(direction: 'up' | 'down', events: number): Promise<boolean> {
    const pages = Math.max(1, Math.ceil(events / 3));
    this.position =
      direction === 'up'
        ? Math.min(this.frames.length - 1, this.position + pages)
        : Math.max(0, this.position - pages);
    return true;
  }

  interruptedBy(): string | null {
    return this.interrupted;
  }

  setEmergencyRestore(plan: typeof this.emergency): void {
    this.emergency = plan;
  }
}

const FRAMES = [
  snapshot(['sticky', 'line 7', 'line 8', 'status']),
  snapshot(['sticky', 'line 5', 'line 6', 'line 7']),
  snapshot(['sticky', 'line 3', 'line 4', 'line 5']),
  snapshot(['sticky', 'line 1', 'line 2', 'line 3']),
];

describe('alternate-screen transcript traversal state machine', () => {
  const timing = {
    settleMs: 1,
    maxDurationMs: 1_000,
    maxRestoreMs: 1_000,
    maxUnalignedChecks: 2,
    wheelStepEvents: 3,
  };

  it('probes bottom, harvests overlapping frames, and verifies bottom restoration', async () => {
    const driver = new FrameDriver(FRAMES);
    const result = await readAlternateScreenTranscript(driver, FRAMES[0]!, {
      lines: 10,
      unwrap: false,
      maxBytes: 4096,
      timing,
    });

    expect(result).toMatchObject({ ok: true, capturedRows: 10, restored: true });
    expect(driver.position).toBe(0);
    if (!result.ok) throw new Error('expected transcript');
    expect(result.content.match(/sticky/g)).toHaveLength(1);
    for (let line = 1; line <= 8; line += 1) expect(result.content).toContain(`line ${line}`);
  });

  it('detects top without duplicating the last frame and still restores', async () => {
    const driver = new FrameDriver(FRAMES);
    const result = await readAlternateScreenTranscript(driver, FRAMES[0]!, {
      lines: 20,
      unwrap: false,
      maxBytes: 4096,
      timing,
    });

    expect(result).toMatchObject({ ok: true, reachedTop: true, truncated: false, restored: true });
    expect(driver.position).toBe(0);
  });

  it('restores and refuses traversal when the initial viewport was not at bottom', async () => {
    const driver = new FrameDriver(FRAMES, 1);
    const result = await readAlternateScreenTranscript(driver, FRAMES[1]!, {
      lines: 20,
      unwrap: false,
      maxBytes: 4096,
      timing,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'viewport_not_at_bottom',
      restoreAttempted: true,
      restored: true,
    });
    expect(driver.position).toBe(1);
  });
});
