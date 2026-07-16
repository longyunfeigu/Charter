import { describe, expect, it } from 'vitest';
import {
  PROGRESS_EXPIRY_MS,
  TerminalBlocks,
  type BlockMarker,
  type BlocksHost,
  type TermBlock,
} from './terminal-blocks.js';

/** Scriptable buffer: lines + cursor, markers pinned to absolute lines. */
class FakeHost implements BlocksHost {
  lines: string[] = [''];
  cursorCol = 0;
  time = 1000;
  markers: Array<{ line: number; disposed: boolean }> = [];

  markCursorLine(): BlockMarker {
    const entry = { line: this.lines.length - 1, disposed: false };
    this.markers.push(entry);
    return {
      get line() {
        return entry.disposed ? -1 : entry.line;
      },
      get isDisposed() {
        return entry.disposed;
      },
      dispose() {
        entry.disposed = true;
      },
    };
  }
  cursorColumn(): number {
    return this.cursorCol;
  }
  cursorLine(): number {
    return this.lines.length - 1;
  }
  lineText(line: number): string {
    return this.lines[line] ?? '';
  }
  now(): number {
    return this.time;
  }

  /** Simulate output: append to the current line then move to a fresh line. */
  print(text: string): void {
    this.lines[this.lines.length - 1] += text;
    this.cursorCol = (this.lines.at(-1) ?? '').length;
  }
  newline(): void {
    this.lines.push('');
    this.cursorCol = 0;
  }
}

function setup(): {
  host: FakeHost;
  blocks: TerminalBlocks;
  ended: Array<{ block: TermBlock; durationMs: number }>;
  changes: { count: number };
} {
  const host = new FakeHost();
  const ended: Array<{ block: TermBlock; durationMs: number }> = [];
  const changes = { count: 0 };
  const blocks = new TerminalBlocks(host, {
    onChange: () => {
      changes.count += 1;
    },
    onCommandEnd: (block, durationMs) => ended.push({ block, durationMs }),
  });
  return { host, blocks, ended, changes };
}

/** Drive one full shell command through the OSC 133 lifecycle. */
function runCommand(
  host: FakeHost,
  blocks: TerminalBlocks,
  command: string,
  exit: number,
  output: string[] = ['out'],
): void {
  blocks.handleOsc133('A');
  host.print('proj % ');
  blocks.handleOsc133('B');
  host.print(command);
  host.newline();
  blocks.handleOsc133('C');
  for (const line of output) {
    host.print(line);
    host.newline();
  }
  blocks.handleOsc133(`D;${exit}`);
}

describe('TerminalBlocks — OSC 133 lifecycle', () => {
  it('builds a block with command text, exit code and duration', () => {
    const { host, blocks, ended } = setup();
    blocks.handleOsc133('A');
    host.print('proj % ');
    blocks.handleOsc133('B');
    host.print('npm run lint');
    host.newline();
    blocks.handleOsc133('C');
    host.time += 3800;
    host.print('1 problem');
    host.newline();
    blocks.handleOsc133('D;1');

    const visible = blocks.visibleBlocks();
    expect(visible).toHaveLength(1);
    const block = visible[0]!;
    expect(block.command).toBe('npm run lint');
    expect(block.exitCode).toBe(1);
    expect(block.running).toBe(false);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.durationMs).toBe(3800);
    // Range covers the command line through the last output line.
    expect(blocks.rangeOf(block)).toEqual({ start: 0, end: 1 });
  });

  it('a block is running between C and D', () => {
    const { host, blocks } = setup();
    blocks.handleOsc133('A');
    host.print('% ');
    blocks.handleOsc133('B');
    host.print('npm run test:e2e');
    host.newline();
    blocks.handleOsc133('C');
    expect(blocks.runningBlock()?.command).toBe('npm run test:e2e');
    blocks.handleOsc133('D;0');
    expect(blocks.runningBlock()).toBeNull();
  });

  it('a lost D mark closes the block honestly with an unknown exit code', () => {
    const { host, blocks, ended } = setup();
    blocks.handleOsc133('A');
    host.print('% ');
    blocks.handleOsc133('B');
    host.print('crashy');
    host.newline();
    blocks.handleOsc133('C');
    // Integration gap: next prompt arrives without D.
    blocks.handleOsc133('A');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.block.exitCode).toBeNull();
  });

  it('C without B still creates a block (foreign prompt themes)', () => {
    const { host, blocks } = setup();
    blocks.handleOsc133('A');
    host.print('% something');
    host.newline();
    blocks.handleOsc133('C');
    expect(blocks.runningBlock()).not.toBeNull();
    expect(blocks.runningBlock()!.command).toBe('');
  });

  it('multi-line commands are joined', () => {
    const { host, blocks } = setup();
    blocks.handleOsc133('A');
    host.print('% ');
    blocks.handleOsc133('B');
    host.print('echo one \\');
    host.newline();
    host.print('two');
    host.newline();
    blocks.handleOsc133('C');
    expect(blocks.runningBlock()!.command).toBe('echo one \\ two');
  });

  it('rerun links the new block to the superseded one (VER-005)', () => {
    const { host, blocks } = setup();
    runCommand(host, blocks, 'npm run lint', 1);
    const failed = blocks.visibleBlocks()[0]!;
    blocks.markNextCommandAsRerunOf(failed.id);
    runCommand(host, blocks, 'npm run lint', 0);
    const rerun = blocks.visibleBlocks()[1]!;
    expect(rerun.rerunOf).toBe(failed.id);
    expect(blocks.visibleBlocks()).toHaveLength(2); // history preserved
  });

  it('blocks trimmed out of scrollback disappear from visibleBlocks', () => {
    const { host, blocks } = setup();
    runCommand(host, blocks, 'one', 0);
    runCommand(host, blocks, 'two', 0);
    host.markers[0]!.disposed = true; // B marker of command one
    expect(blocks.visibleBlocks().map((b) => b.command)).toEqual(['two']);
  });
});

describe('TerminalBlocks — selection stepping (⌘↑/⌘↓)', () => {
  it('steps from the bottom to the last block, up, then back out', () => {
    const { host, blocks } = setup();
    runCommand(host, blocks, 'one', 0);
    runCommand(host, blocks, 'two', 0);
    const up1 = blocks.step(-1);
    expect(up1?.command).toBe('two');
    blocks.selectedId = up1!.id;
    const up2 = blocks.step(-1);
    expect(up2?.command).toBe('one');
    blocks.selectedId = up2!.id;
    expect(blocks.step(-1)?.command).toBe('one'); // clamps at the top
    const down = blocks.step(1);
    expect(down?.command).toBe('two');
    blocks.selectedId = down!.id;
    expect(blocks.step(1)).toBeNull(); // below the last block = leave selection
  });
});

describe('TerminalBlocks — progress (three honest sources)', () => {
  it('no signal at all reports indeterminate while running', () => {
    const { host, blocks } = setup();
    blocks.handleOsc133('A');
    blocks.handleOsc133('B');
    host.print('sleep 100');
    host.newline();
    blocks.handleOsc133('C');
    expect(blocks.progressFor(host.time)!.kind).toBe('indeterminate');
    blocks.handleOsc133('D;0');
    expect(blocks.progressFor(host.time)).toBeNull();
  });

  it('OSC 9;4 wins and expires into indeterminate when stale', () => {
    const { host, blocks } = setup();
    blocks.handleOsc133('A');
    blocks.handleOsc133('B');
    host.print('npm run test:e2e');
    host.newline();
    blocks.handleOsc133('C');
    blocks.handleOsc9('4;1;42');
    expect(blocks.progressFor(host.time)).toMatchObject({ kind: 'determinate', percent: 42 });
    // A crashed reporter must never leave a frozen bar.
    expect(blocks.progressFor(host.time + PROGRESS_EXPIRY_MS + 1)!.kind).toBe('indeterminate');
  });

  it('error state renders failed', () => {
    const { host, blocks } = setup();
    blocks.handleOsc133('A');
    blocks.handleOsc133('B');
    host.print('make build');
    host.newline();
    blocks.handleOsc133('C');
    blocks.handleOsc9('4;2;80');
    expect(blocks.progressFor(host.time)).toMatchObject({ failed: true, percent: 80 });
  });

  it('parsed counters work only for known runners and never override OSC', () => {
    const { host, blocks } = setup();
    blocks.handleOsc133('A');
    blocks.handleOsc133('B');
    host.print('npx playwright test');
    host.newline();
    blocks.handleOsc133('C');
    blocks.feedOutput('[12/96] checkout.spec.ts');
    expect(blocks.progressFor(host.time)).toMatchObject({
      kind: 'determinate',
      percent: 13,
      source: 'parsed',
    });
    blocks.handleOsc9('4;1;50');
    blocks.feedOutput('[90/96] done');
    expect(blocks.progressFor(host.time)).toMatchObject({ percent: 50, source: 'osc' });
  });

  it('unknown commands never get invented progress', () => {
    const { host, blocks } = setup();
    blocks.handleOsc133('A');
    blocks.handleOsc133('B');
    host.print('curl -s https://x/download');
    host.newline();
    blocks.handleOsc133('C');
    blocks.feedOutput('chunk 3/8 received');
    expect(blocks.progressFor(host.time)!.kind).toBe('indeterminate');
  });
});

describe('TerminalBlocks — turn blocks (ADR-0017 external sessions)', () => {
  it('turns appear on the same rail with their own kind', () => {
    const { host, blocks } = setup();
    runCommand(host, blocks, 'claude', 0);
    blocks.addTurnBlock('Claude run completed', false);
    const visible = blocks.visibleBlocks();
    expect(visible).toHaveLength(2);
    expect(visible[1]).toMatchObject({ kind: 'turn', exitCode: 0, running: false });
  });
});
