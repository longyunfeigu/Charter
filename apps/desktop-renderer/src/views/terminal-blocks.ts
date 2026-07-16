/**
 * ADR-0021 — the terminal block model. A block is the user-relevant minimal
 * unit of scrollback: one shell command (OSC 133 A/B/C/D) or one external
 * session turn. Pure against a structural host so the whole state machine is
 * unit-testable without xterm; TerminalPanel adapts a live Terminal into
 * BlocksHost and renders rail/toolbar from `visibleBlocks()`.
 */

export interface BlockMarker {
  /** Absolute buffer line; -1 once trimmed out of scrollback. */
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

export interface BlocksHost {
  /** Marker at the line the cursor is on right now (null while buffer busy). */
  markCursorLine(): BlockMarker | null;
  cursorColumn(): number;
  /** Absolute cursor line (scrollback base + cursor y). */
  cursorLine(): number;
  /** Translated text of one absolute buffer line ('' when unavailable). */
  lineText(line: number): string;
  now(): number;
}

export type BlockKind = 'command' | 'turn';

export interface TermBlock {
  id: string;
  kind: BlockKind;
  /** Command text (from the buffer between B and C) or the turn label. */
  command: string;
  marker: BlockMarker;
  /** Line of the follow-up prompt; null while running (range ends at cursor). */
  endLine: number | null;
  /** null = ended without a reported code (integration lost the D mark). */
  exitCode: number | null;
  running: boolean;
  startedAt: number;
  endedAt: number | null;
  /** ADR-0021/VER-005: a rerun links to the block it supersedes; both stay. */
  rerunOf: string | null;
}

export interface ProgressSnapshot {
  kind: 'determinate' | 'indeterminate';
  /** 0..100; meaningful only when determinate. */
  percent: number;
  failed: boolean;
  source: 'osc' | 'parsed';
  updatedAt: number;
}

export interface BlocksEvents {
  onChange(): void;
  onCommandEnd(block: TermBlock, durationMs: number): void;
}

/** A determinate value that stops moving is a lie — expire it (Ghostty's keep-alive). */
export const PROGRESS_EXPIRY_MS = 20_000;
const MAX_BLOCKS = 200;
const MAX_COMMAND_CHARS = 2000;

/** Conservative fallback: only trust `12/96`-style counters from known runners. */
const PARSABLE_COMMAND_RE =
  /\b(vitest|playwright|jest|mocha|pytest|cargo\s+(test|build)|go\s+test|test|spec|e2e|build)\b/i;
const COUNTER_RE = /(?:^|[[(\s|])(\d{1,4})\s*\/\s*(\d{1,4})(?:[\])\s|:%]|$)/g;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b](?:\[[0-9;?]*[a-zA-Z]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;

let blockSeq = 0;

export class TerminalBlocks {
  private readonly items: TermBlock[] = [];
  private pendingCommand: { marker: BlockMarker; column: number } | null = null;
  private runningId: string | null = null;
  private progress: ProgressSnapshot | null = null;
  private nextRerunOf: string | null = null;
  selectedId: string | null = null;
  /** Row bell: a long command finished while the user was looking elsewhere. */
  bell = false;

  constructor(
    private readonly host: BlocksHost,
    private readonly events: BlocksEvents,
  ) {}

  /** OSC 133 dispatch; payloads look like "A", "B", "C", "D;0". */
  handleOsc133(data: string): boolean {
    const [mark, ...rest] = data.split(';');
    if (mark === 'A') this.onPromptStart();
    else if (mark === 'B') this.onCommandStart();
    else if (mark === 'C') this.onOutputStart();
    else if (mark === 'D') this.onCommandEnd(rest[0]);
    return true;
  }

  /** OSC 9;4 progress (ConEmu dialect): "4;<state>;<percent>". */
  handleOsc9(data: string): boolean {
    const parts = data.split(';');
    if (parts[0] !== '4') return false;
    const state = parts[1] ?? '0';
    const percent = Math.min(100, Math.max(0, Number(parts[2] ?? '0') || 0));
    if (state === '0') {
      this.progress = null;
    } else if (state === '3') {
      this.progress = {
        kind: 'indeterminate',
        percent: 0,
        failed: false,
        source: 'osc',
        updatedAt: this.host.now(),
      };
    } else {
      this.progress = {
        kind: 'determinate',
        percent,
        failed: state === '2',
        source: 'osc',
        updatedAt: this.host.now(),
      };
    }
    this.events.onChange();
    return true;
  }

  /** Plain-output fallback progress (never overrides an OSC 9;4 source). */
  feedOutput(chunk: string): void {
    const running = this.runningBlock();
    if (!running || running.kind !== 'command') return;
    if (this.progress?.source === 'osc') return;
    if (!PARSABLE_COMMAND_RE.test(running.command)) return;
    const text = chunk.replace(ANSI_RE, '');
    let match: RegExpExecArray | null = null;
    let last: { num: number; den: number } | null = null;
    COUNTER_RE.lastIndex = 0;
    while ((match = COUNTER_RE.exec(text)) !== null) {
      const num = Number(match[1]);
      const den = Number(match[2]);
      if (den > 1 && num <= den) last = { num, den };
    }
    if (!last) return;
    this.progress = {
      kind: 'determinate',
      percent: Math.round((last.num / last.den) * 100),
      failed: false,
      source: 'parsed',
      updatedAt: this.host.now(),
    };
    this.events.onChange();
  }

  /** ADR-0017/0021: external session edges and structured turns, same rail. */
  addTurnBlock(label: string, failed: boolean): void {
    const marker = this.host.markCursorLine();
    if (!marker) return;
    const now = this.host.now();
    this.push({
      id: `blk-${(blockSeq += 1)}`,
      kind: 'turn',
      command: label.slice(0, MAX_COMMAND_CHARS),
      marker,
      endLine: this.host.cursorLine(),
      exitCode: failed ? 1 : 0,
      running: false,
      startedAt: now,
      endedAt: now,
      rerunOf: null,
    });
    this.events.onChange();
  }

  /** The next command block created will link back to `blockId` (rerun ↰). */
  markNextCommandAsRerunOf(blockId: string): void {
    this.nextRerunOf = blockId;
  }

  /** Blocks whose start line still exists in scrollback, oldest first. */
  visibleBlocks(): TermBlock[] {
    return this.items.filter((b) => !b.marker.isDisposed && b.marker.line >= 0);
  }

  byId(id: string): TermBlock | null {
    return this.items.find((b) => b.id === id) ?? null;
  }

  selected(): TermBlock | null {
    return this.selectedId ? this.byId(this.selectedId) : null;
  }

  runningBlock(): TermBlock | null {
    return this.runningId ? this.byId(this.runningId) : null;
  }

  /**
   * Content range [start, end] in absolute lines. A finished command ends the
   * line before the next prompt; anything else ends where the next block
   * starts or at the cursor.
   */
  rangeOf(block: TermBlock): { start: number; end: number } {
    const start = block.marker.line;
    if (block.endLine !== null && block.endLine > start) {
      return { start, end: Math.max(start, block.endLine - 1) };
    }
    const visible = this.visibleBlocks();
    const next = visible.find((b) => b.marker.line > start);
    if (next) return { start, end: Math.max(start, next.marker.line - 1) };
    return { start, end: Math.max(start, this.host.cursorLine()) };
  }

  /** Effective progress after expiry: stale determinate falls back to honest indeterminate. */
  progressFor(now: number): ProgressSnapshot | null {
    const running = this.runningBlock();
    if (!running) return null;
    if (!this.progress) {
      return { kind: 'indeterminate', percent: 0, failed: false, source: 'osc', updatedAt: now };
    }
    if (
      this.progress.kind === 'determinate' &&
      now - this.progress.updatedAt > PROGRESS_EXPIRY_MS
    ) {
      return {
        kind: 'indeterminate',
        percent: 0,
        failed: false,
        source: this.progress.source,
        updatedAt: now,
      };
    }
    return this.progress;
  }

  /** Selection step for ⌘↑ (dir -1) / ⌘↓ (dir 1); null = leave selection mode. */
  step(dir: -1 | 1): TermBlock | null {
    const visible = this.visibleBlocks();
    if (visible.length === 0) return null;
    const index = visible.findIndex((b) => b.id === this.selectedId);
    if (index === -1) return dir === -1 ? (visible.at(-1) ?? null) : null;
    const next = index + dir;
    if (next < 0) return visible[0] ?? null;
    if (next >= visible.length) return null;
    return visible[next] ?? null;
  }

  private onPromptStart(): void {
    // A while a block is still open means the D mark was lost (integration
    // gap, hard kill): close honestly with an unknown exit code.
    this.closeRunning(null);
  }

  private onCommandStart(): void {
    this.pendingCommand?.marker.dispose();
    const marker = this.host.markCursorLine();
    this.pendingCommand = marker ? { marker, column: this.host.cursorColumn() } : null;
  }

  private onOutputStart(): void {
    this.closeRunning(null);
    const pending = this.pendingCommand;
    this.pendingCommand = null;
    const marker = pending?.marker ?? this.host.markCursorLine();
    if (!marker) return;
    const block: TermBlock = {
      id: `blk-${(blockSeq += 1)}`,
      kind: 'command',
      command: pending ? this.readCommandText(pending) : '',
      marker,
      endLine: null,
      exitCode: null,
      running: true,
      startedAt: this.host.now(),
      endedAt: null,
      rerunOf: this.nextRerunOf,
    };
    this.nextRerunOf = null;
    this.runningId = block.id;
    this.progress = null;
    this.push(block);
    this.events.onChange();
  }

  private onCommandEnd(exitText: string | undefined): void {
    const parsed = exitText === undefined || exitText === '' ? null : Number(exitText);
    this.closeRunning(parsed === null || Number.isNaN(parsed) ? null : parsed);
  }

  private closeRunning(exitCode: number | null): void {
    const block = this.runningBlock();
    this.runningId = null;
    this.progress = null;
    if (!block) return;
    block.running = false;
    block.exitCode = exitCode;
    block.endedAt = this.host.now();
    block.endLine = this.host.cursorLine();
    this.events.onChange();
    this.events.onCommandEnd(block, block.endedAt - block.startedAt);
  }

  private readCommandText(pending: { marker: BlockMarker; column: number }): string {
    const start = pending.marker.line;
    if (pending.marker.isDisposed || start < 0) return '';
    // At C time (preexec) the cursor already moved past the command's last line.
    const end = Math.max(start, this.host.cursorLine() - 1);
    const lines: string[] = [];
    for (let line = start; line <= end && lines.length < 8; line += 1) {
      const text = this.host.lineText(line);
      lines.push(line === start ? text.slice(pending.column) : text);
    }
    return lines.join(' ').trim().slice(0, MAX_COMMAND_CHARS);
  }

  private push(block: TermBlock): void {
    this.items.push(block);
    while (this.items.length > MAX_BLOCKS) {
      const dropped = this.items.shift();
      dropped?.marker.dispose();
    }
  }
}
