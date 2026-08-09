import { describe, expect, it } from 'vitest';
import {
  DOM_DELTA_LINE,
  DOM_DELTA_PAGE,
  DOM_DELTA_PIXEL,
  TuiWheelDistance,
} from './terminal-tui-wheel.js';

const CELL = 18; // css px per row
const ROWS = 40;

describe('TuiWheelDistance', () => {
  it('converts pixel deltas to whole rows without trackpad dampening', () => {
    const d = new TuiWheelDistance();
    // 10 trackpad ticks of 9px = 90px = 5 rows exactly — none discarded.
    let rows = 0;
    for (let i = 0; i < 10; i += 1) {
      rows += d.consume(9, DOM_DELTA_PIXEL, CELL, ROWS, false, 5);
    }
    expect(rows).toBe(5);
  });

  it('carries fractional remainders across events instead of flooring each one', () => {
    const d = new TuiWheelDistance();
    // 4px ticks: individually below one row, but 9 of them = 2 rows.
    const perEvent = Array.from({ length: 9 }, () =>
      d.consume(4, DOM_DELTA_PIXEL, CELL, ROWS, false, 5),
    );
    expect(perEvent.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('keeps direction sign and resets carry on direction math naturally', () => {
    const d = new TuiWheelDistance();
    expect(d.consume(-36, DOM_DELTA_PIXEL, CELL, ROWS, false, 5)).toBe(-2);
    expect(d.consume(36, DOM_DELTA_PIXEL, CELL, ROWS, false, 5)).toBe(2);
  });

  it('passes line and page modes through at face value', () => {
    const d = new TuiWheelDistance();
    expect(d.consume(3, DOM_DELTA_LINE, CELL, ROWS, false, 5)).toBe(3);
    expect(d.consume(1, DOM_DELTA_PAGE, CELL, ROWS, false, 5)).toBe(ROWS);
  });

  it('applies the fast-scroll gear for modified wheels', () => {
    const d = new TuiWheelDistance();
    expect(d.consume(18, DOM_DELTA_PIXEL, CELL, ROWS, true, 5)).toBe(5);
  });

  it('yields zero for degenerate input instead of NaN pollution', () => {
    const d = new TuiWheelDistance();
    expect(d.consume(0, DOM_DELTA_PIXEL, CELL, ROWS, false, 5)).toBe(0);
    expect(d.consume(9, DOM_DELTA_PIXEL, 0, ROWS, false, 5)).toBe(0);
    expect(d.consume(Number.NaN, DOM_DELTA_PIXEL, CELL, ROWS, false, 5)).toBe(0);
    // and the good path still works afterwards
    expect(d.consume(90, DOM_DELTA_PIXEL, CELL, ROWS, false, 5)).toBe(5);
  });

  it('reset drops accumulated remainder when tracking mode flips off', () => {
    const d = new TuiWheelDistance();
    d.consume(9, DOM_DELTA_PIXEL, CELL, ROWS, false, 5); // 0.5 carried
    d.reset();
    expect(d.consume(9, DOM_DELTA_PIXEL, CELL, ROWS, false, 5)).toBe(0);
  });
});
