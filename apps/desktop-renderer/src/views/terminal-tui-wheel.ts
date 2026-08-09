import type { Terminal } from '@xterm/xterm';

/**
 * Finger-true wheel scrolling for mouse-tracking TUIs (Claude Code, vim, htop).
 *
 * When a TUI enables mouse tracking, xterm stops scrolling its scrollback and
 * converts wheel events into mouse reports for the app — but its converter
 * multiplies trackpad pixel deltas by 0.3 (MouseService._consumeWheelEvent),
 * so 70% of finger travel is silently discarded and the TUI scrolls far less
 * than the gesture. Combined with a TUI that repaints per report, scrolling
 * feels dead ("卡顿"). ORCA works around the same dampening with line-mode
 * wheel replays; this is that idea implemented for Charter.
 *
 * The handler only engages while mouse tracking is active and unmodified
 * vertical wheel input arrives. It accumulates true row distance (pixels ÷
 * CSS cell height, fractional remainder carried across events) and replays
 * that many synthetic line-mode wheel events. Each replay uses
 * deltaY = ±1/scrollSensitivity so xterm's modifier math yields exactly one
 * report per replayed event. Shift-modified wheel keeps xterm's native
 * "bypass mouse reporting" behavior, and terminals without mouse tracking
 * (plain shells, codex scrollback) never enter this path.
 */

// WheelEvent.deltaMode values (fixed by the DOM spec; local so the pure
// accumulator stays testable in a Node environment).
export const DOM_DELTA_PIXEL = 0;
export const DOM_DELTA_LINE = 1;
export const DOM_DELTA_PAGE = 2;

const REPLAYED = Symbol('charterReplayedTuiWheel');

interface ReplayableWheelEvent extends WheelEvent {
  [REPLAYED]?: boolean;
}

/** Pure accumulator: wheel deltas in, whole rows out, remainder carried. */
export class TuiWheelDistance {
  private carry = 0;

  /**
   * @param deltaY raw event deltaY (sign = direction)
   * @param deltaMode WheelEvent.deltaMode (pixel/line/page)
   * @param cellHeightPx CSS pixel height of one terminal cell
   * @param rows terminal rows (for page mode)
   * @param fast apply the Alt fast-scroll gear
   * @param fastMultiplier fastScrollSensitivity when fast is set
   */
  consume(
    deltaY: number,
    deltaMode: number,
    cellHeightPx: number,
    rows: number,
    fast: boolean,
    fastMultiplier: number,
  ): number {
    if (deltaY === 0 || !Number.isFinite(deltaY)) return 0;
    let amount: number;
    if (deltaMode === DOM_DELTA_LINE) amount = deltaY;
    else if (deltaMode === DOM_DELTA_PAGE) amount = deltaY * rows;
    else if (cellHeightPx > 0) amount = deltaY / cellHeightPx;
    else return 0;
    if (fast) amount *= Math.max(1, fastMultiplier);
    this.carry += amount;
    const whole = this.carry > 0 ? Math.floor(this.carry) : Math.ceil(this.carry);
    this.carry -= whole;
    return whole;
  }

  reset(): void {
    this.carry = 0;
  }
}

function cssCellHeight(term: Terminal): number {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
  const height = screen?.getBoundingClientRect().height ?? 0;
  return term.rows > 0 && height > 0 ? height / term.rows : 0;
}

function replayEvent(source: WheelEvent, direction: -1 | 1, perEventDelta: number): WheelEvent {
  const clone: ReplayableWheelEvent = new WheelEvent(source.type, {
    bubbles: source.bubbles,
    cancelable: source.cancelable,
    composed: source.composed,
    view: source.view,
    clientX: source.clientX,
    clientY: source.clientY,
    screenX: source.screenX,
    screenY: source.screenY,
    deltaX: 0,
    deltaY: direction * perEventDelta,
    deltaZ: 0,
    deltaMode: DOM_DELTA_LINE,
  });
  Object.defineProperty(clone, REPLAYED, { configurable: true, value: true });
  return clone;
}

/** Attach once per Terminal, right after construction. */
export function attachTuiWheelFidelity(term: Terminal): void {
  const distance = new TuiWheelDistance();
  term.attachCustomWheelEventHandler((event: WheelEvent) => {
    if ((event as ReplayableWheelEvent)[REPLAYED]) return true;
    if (term.modes.mouseTrackingMode === 'none') {
      distance.reset();
      return true;
    }
    // Shift = xterm's own "scroll instead of report" escape hatch; deltaY 0
    // covers horizontal-only gestures.
    if (event.shiftKey || event.deltaY === 0) return true;

    const rows = distance.consume(
      event.deltaY,
      event.deltaMode,
      cssCellHeight(term),
      term.rows,
      event.altKey || event.ctrlKey,
      Number(term.options.fastScrollSensitivity ?? 5),
    );
    if (rows === 0) return false;

    const direction: -1 | 1 = rows < 0 ? -1 : 1;
    // xterm multiplies replays by scrollSensitivity and dispatches
    // ceil(|amount|) reports for line-mode deltas. Target 0.95 — mid (0,1] —
    // so float noise can never cross an integer boundary: always one report.
    const sensitivity = Number(term.options.scrollSensitivity) || 1;
    const perEventDelta = 0.95 / sensitivity;
    const target = event.currentTarget instanceof EventTarget ? event.currentTarget : term.element;
    if (!target) return true;
    const count = Math.min(120, Math.abs(rows));
    // Dispatch after xterm's original handler unwinds so report ordering is
    // preserved; the TUI needs the full distance, so no frame capping.
    queueMicrotask(() => {
      if (term.modes.mouseTrackingMode === 'none') return;
      for (let i = 0; i < count; i += 1) {
        target.dispatchEvent(replayEvent(event, direction, perEventDelta));
      }
    });
    return false;
  });
}
