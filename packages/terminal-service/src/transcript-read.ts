/**
 * Alternate-screen transcript traversal.
 *
 * The viewport traversal and overlap-merging design is adapted from Herdr's
 * `src/server/alt_screen_read.rs` and `src/terminal/history_read.rs` at
 * ddffb6e1d79efb517a92034ed18b75c388a36e55 (Apache-2.0). This TypeScript
 * adaptation uses xterm screen rows and Charter's preemptible input lease.
 */

export interface TerminalScreenRow {
  text: string;
  /** xterm's row is a soft-wrap continuation of the preceding row. */
  wrapContinuation: boolean;
}

export interface TerminalScreenSnapshot {
  cols: number;
  rows: TerminalScreenRow[];
}

export type TranscriptWheelDirection = 'up' | 'down';

export type TerminalTranscriptFailureReason =
  | 'terminal_unavailable'
  | 'not_alternate_screen'
  | 'mouse_reporting_unavailable'
  | 'read_in_progress'
  | 'viewport_not_at_bottom'
  | 'screen_changed'
  | 'alignment_failed'
  | 'timed_out'
  | 'interrupted'
  | 'restore_failed';

export interface TerminalTranscriptReadSuccess {
  ok: true;
  content: string;
  bytes: number;
  totalBytes: number;
  truncated: boolean;
  capturedRows: number;
  reachedTop: boolean;
  restored: true;
}

export interface TerminalTranscriptReadFailure {
  ok: false;
  reason: TerminalTranscriptFailureReason;
  interruptedBy?: string;
  restoreAttempted: boolean;
  restored: boolean;
}

export type TerminalTranscriptReadResult =
  TerminalTranscriptReadSuccess | TerminalTranscriptReadFailure;

export interface TerminalTranscriptTiming {
  settleMs: number;
  maxDurationMs: number;
  maxRestoreMs: number;
  maxUnalignedChecks: number;
  wheelStepEvents: number;
}

export const DEFAULT_TRANSCRIPT_TIMING: TerminalTranscriptTiming = {
  settleMs: 120,
  maxDurationMs: 15_000,
  maxRestoreMs: 5_000,
  maxUnalignedChecks: 4,
  wheelStepEvents: 3,
};

export interface AlternateScreenTranscriptDriver {
  snapshot(): Promise<TerminalScreenSnapshot | null>;
  sendWheel(
    direction: TranscriptWheelDirection,
    events: number,
    snapshot: TerminalScreenSnapshot,
  ): Promise<boolean>;
  interruptedBy(): string | null;
  /**
   * Lets the owner restore synchronously before a higher-priority user write
   * or resize proceeds. The traversal itself still performs and verifies the
   * normal restore path when it retains the lease.
   */
  setEmergencyRestore(
    plan: {
      direction: TranscriptWheelDirection;
      events: number;
      snapshot: TerminalScreenSnapshot;
    } | null,
  ): void;
}

type UpwardMerge =
  { kind: 'advanced'; rows: number } | { kind: 'unchanged' } | { kind: 'unaligned' };

const MIN_ALIGNMENT_RATIO_PERCENT = 30;
const SIMILAR_VIEWPORT_RATIO_PERCENT = 70;

function rowIdentities(rows: readonly TerminalScreenRow[]): string[] {
  return rows.map((row) => row.text.trimEnd());
}

/** Dynamic status/spinner rows may change while the viewport is otherwise stable. */
export function similarViewport(
  leftSnapshot: TerminalScreenSnapshot,
  rightSnapshot: TerminalScreenSnapshot,
): boolean {
  if (
    leftSnapshot.cols !== rightSnapshot.cols ||
    leftSnapshot.rows.length !== rightSnapshot.rows.length
  ) {
    return false;
  }
  const left = rowIdentities(leftSnapshot.rows);
  const right = rowIdentities(rightSnapshot.rows);
  let comparable = 0;
  let matches = 0;
  for (let index = 0; index < left.length; index += 1) {
    if ((left[index] ?? '') === '' && (right[index] ?? '') === '') continue;
    comparable += 1;
    if (left[index] === right[index]) matches += 1;
  }
  if (comparable === 0) return true;
  return matches * 100 >= comparable * SIMILAR_VIEWPORT_RATIO_PERCENT;
}

function bestUpwardShift(previous: readonly string[], next: readonly string[]): number | null {
  let best: { shift: number; matches: number; comparable: number } | null = null;
  for (let shift = 1; shift < previous.length; shift += 1) {
    const overlap = previous.length - shift;
    let comparable = 0;
    let matches = 0;
    for (let index = 0; index < overlap; index += 1) {
      const before = previous[index] ?? '';
      const after = next[index + shift] ?? '';
      if (!before || !after) continue;
      comparable += 1;
      if (before === after) matches += 1;
    }
    if (comparable === 0 || matches * 100 < comparable * MIN_ALIGNMENT_RATIO_PERCENT) continue;
    if (
      !best ||
      matches > best.matches ||
      (matches === best.matches && comparable > best.comparable)
    ) {
      best = { shift, matches, comparable };
    }
  }
  return best?.shift ?? null;
}

/** Prepends only newly exposed rows, excluding repeated fixed headers/status rows. */
export function mergeScrolledUp(
  history: TerminalScreenRow[],
  previous: TerminalScreenSnapshot,
  next: TerminalScreenSnapshot,
): UpwardMerge {
  if (previous.cols !== next.cols || previous.rows.length !== next.rows.length) {
    return { kind: 'unaligned' };
  }
  const previousText = rowIdentities(previous.rows);
  const nextText = rowIdentities(next.rows);
  if (previousText.every((row, index) => row === nextText[index])) return { kind: 'unchanged' };

  const shift = bestUpwardShift(previousText, nextText);
  if (shift === null) return { kind: 'unaligned' };
  let boundary = -1;
  for (let index = 0; index < previousText.length - shift; index += 1) {
    const nextIndex = index + shift;
    if (previousText[index] && previousText[index] === nextText[nextIndex]) {
      boundary = nextIndex;
      break;
    }
  }
  if (boundary < 0) return { kind: 'unaligned' };
  const added = next.rows
    .slice(0, boundary)
    .filter((_, index) => !nextText[index] || previousText[index] !== nextText[index]);
  if (added.length === 0) return { kind: 'unaligned' };
  history.unshift(...added.map((row) => ({ ...row })));
  return { kind: 'advanced', rows: added.length };
}

function textFromRows(rows: readonly TerminalScreenRow[], unwrap: boolean): string {
  const lines: string[] = [];
  for (const row of rows) {
    const text = row.text.trimEnd();
    if (unwrap && row.wrapContinuation && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.at(-1)?.trim() === '') lines.pop();
  const value = lines.join('\n');
  return value ? `${value}\n` : '';
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let tail = bytes.subarray(bytes.byteLength - maxBytes).toString('utf8');
  while (tail.charCodeAt(0) === 0xfffd) tail = tail.slice(1);
  return tail;
}

export function snapshotRowsText(
  rows: readonly TerminalScreenRow[],
  options: { lines: number; unwrap: boolean; maxBytes: number; truncated?: boolean },
): Omit<TerminalTranscriptReadSuccess, 'ok' | 'capturedRows' | 'reachedTop' | 'restored'> {
  const selected = rows.slice(Math.max(0, rows.length - options.lines));
  const full = textFromRows(selected, options.unwrap);
  const totalBytes = Buffer.byteLength(full, 'utf8');
  const content = utf8Tail(full, options.maxBytes);
  return {
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    totalBytes,
    truncated:
      Boolean(options.truncated) || rows.length > options.lines || totalBytes > options.maxBytes,
  };
}

function failure(
  reason: TerminalTranscriptFailureReason,
  input: { interruptedBy?: string; restoreAttempted?: boolean; restored?: boolean } = {},
): TerminalTranscriptReadFailure {
  return {
    ok: false,
    reason,
    ...(input.interruptedBy ? { interruptedBy: input.interruptedBy } : {}),
    restoreAttempted: input.restoreAttempted ?? false,
    restored: input.restored ?? false,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function sameDimensions(initial: TerminalScreenSnapshot, current: TerminalScreenSnapshot): boolean {
  return initial.cols === current.cols && initial.rows.length === current.rows.length;
}

async function restoreToBottom(
  driver: AlternateScreenTranscriptDriver,
  initial: TerminalScreenSnapshot,
  latest: TerminalScreenSnapshot,
  upwardEvents: number,
  timing: TerminalTranscriptTiming,
): Promise<boolean> {
  if (upwardEvents === 0) return true;
  if (driver.interruptedBy()) return false;
  driver.setEmergencyRestore(null);
  if (!(await driver.sendWheel('down', upwardEvents, latest))) return false;
  const startedAt = Date.now();
  let previous = latest;
  let stableChecks = 0;
  while (Date.now() - startedAt < timing.maxRestoreMs) {
    await wait(timing.settleMs);
    if (driver.interruptedBy()) return false;
    const snapshot = await driver.snapshot();
    if (!snapshot || !sameDimensions(initial, snapshot)) return false;
    if (similarViewport(snapshot, previous)) {
      stableChecks += 1;
      if (stableChecks >= 2) return true;
      continue;
    }
    previous = snapshot;
    stableChecks = 0;
    const events = Math.max(1, Math.floor(snapshot.rows.length / 2));
    if (!(await driver.sendWheel('down', events, snapshot))) return false;
  }
  return false;
}

/**
 * Drive an application-owned alternate-screen transcript and restore it to
 * the bottom before returning. Preconditions such as recognized Agent and
 * semantic Idle are enforced by the caller; this function owns viewport
 * integrity and bounded traversal.
 */
export async function readAlternateScreenTranscript(
  driver: AlternateScreenTranscriptDriver,
  initial: TerminalScreenSnapshot,
  options: {
    lines: number;
    unwrap: boolean;
    maxBytes: number;
    timing?: Partial<TerminalTranscriptTiming>;
  },
): Promise<TerminalTranscriptReadResult> {
  const timing = { ...DEFAULT_TRANSCRIPT_TIMING, ...options.timing };
  const startedAt = Date.now();
  let settled = initial;
  let stableChecks = 0;

  // Settle twice, resetting the baseline if the idle TUI was still repainting.
  while (stableChecks < 2) {
    await wait(timing.settleMs);
    const interruptedBy = driver.interruptedBy();
    if (interruptedBy) return failure('interrupted', { interruptedBy });
    const snapshot = await driver.snapshot();
    if (!snapshot || !sameDimensions(initial, snapshot)) return failure('screen_changed');
    if (similarViewport(snapshot, settled)) stableChecks += 1;
    else {
      settled = snapshot;
      stableChecks = 0;
    }
    if (Date.now() - startedAt >= timing.maxDurationMs) return failure('timed_out');
  }

  // A down-wheel probe proves the caller has not left the TUI viewport above
  // the bottom. If it moves, restore the original viewport and refuse to read.
  if (!(await driver.sendWheel('down', timing.wheelStepEvents, settled))) {
    return failure('mouse_reporting_unavailable');
  }
  await wait(timing.settleMs);
  let current = await driver.snapshot();
  const interruptedAfterProbe = driver.interruptedBy();
  if (interruptedAfterProbe)
    return failure('interrupted', { interruptedBy: interruptedAfterProbe });
  if (!current || !sameDimensions(initial, current)) return failure('screen_changed');
  if (!similarViewport(current, settled)) {
    driver.setEmergencyRestore({
      direction: 'up',
      events: timing.wheelStepEvents,
      snapshot: current,
    });
    const restoreAttempted = await driver.sendWheel('up', timing.wheelStepEvents, current);
    driver.setEmergencyRestore(null);
    if (!restoreAttempted) return failure('restore_failed', { restoreAttempted: true });
    const restoreStartedAt = Date.now();
    while (Date.now() - restoreStartedAt < timing.maxRestoreMs) {
      await wait(timing.settleMs);
      const restored = await driver.snapshot();
      if (!restored || !sameDimensions(initial, restored)) {
        return failure('restore_failed', { restoreAttempted: true });
      }
      if (similarViewport(restored, settled)) {
        return failure('viewport_not_at_bottom', { restoreAttempted: true, restored: true });
      }
      if (driver.interruptedBy()) break;
    }
    return failure('restore_failed', { restoreAttempted: true });
  }

  const history = settled.rows.map((row) => ({ ...row }));
  let previous = settled;
  let upwardEvents = 0;
  let reachedTop = false;
  let failureReason: TerminalTranscriptFailureReason | null = null;

  while (history.length < options.lines) {
    if (Date.now() - startedAt >= timing.maxDurationMs) {
      failureReason = 'timed_out';
      break;
    }
    const interruptedBy = driver.interruptedBy();
    if (interruptedBy) {
      return failure('interrupted', {
        interruptedBy,
        restoreAttempted: upwardEvents > 0,
      });
    }
    upwardEvents += timing.wheelStepEvents;
    driver.setEmergencyRestore({ direction: 'down', events: upwardEvents, snapshot: previous });
    if (!(await driver.sendWheel('up', timing.wheelStepEvents, previous))) {
      upwardEvents -= timing.wheelStepEvents;
      driver.setEmergencyRestore(
        upwardEvents > 0 ? { direction: 'down', events: upwardEvents, snapshot: previous } : null,
      );
      failureReason = 'mouse_reporting_unavailable';
      break;
    }

    let merged = false;
    for (let check = 0; check < timing.maxUnalignedChecks; check += 1) {
      await wait(timing.settleMs);
      const interrupted = driver.interruptedBy();
      if (interrupted) {
        return failure('interrupted', {
          interruptedBy: interrupted,
          restoreAttempted: upwardEvents > 0,
        });
      }
      current = await driver.snapshot();
      if (!current || !sameDimensions(initial, current)) {
        failureReason = 'screen_changed';
        break;
      }
      const merge = mergeScrolledUp(history, previous, current);
      if (merge.kind === 'advanced') {
        previous = current;
        merged = true;
        break;
      }
      if (merge.kind === 'unchanged') {
        reachedTop = true;
        previous = current;
        merged = true;
        break;
      }
      if (check + 1 === timing.maxUnalignedChecks) failureReason = 'alignment_failed';
    }
    if (failureReason || reachedTop) break;
    if (!merged) {
      failureReason = 'alignment_failed';
      break;
    }
  }

  const restored = await restoreToBottom(driver, initial, previous, upwardEvents, timing);
  driver.setEmergencyRestore(null);
  if (!restored) {
    return failure('restore_failed', {
      restoreAttempted: upwardEvents > 0,
    });
  }
  if (failureReason) {
    return failure(failureReason, {
      restoreAttempted: upwardEvents > 0,
      restored: true,
    });
  }

  const rendered = snapshotRowsText(history, {
    lines: options.lines,
    unwrap: options.unwrap,
    maxBytes: options.maxBytes,
    truncated: !reachedTop,
  });
  return {
    ok: true,
    ...rendered,
    capturedRows: history.length,
    reachedTop,
    restored: true,
  };
}
