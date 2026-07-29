import { describe, expect, it } from 'vitest';
import {
  DARK_TERMINAL_MIN_CONTRAST,
  LIGHT_TERMINAL_MIN_CONTRAST,
  ORCA_DARK_TERMINAL_THEME,
  ORCA_LIGHT_TERMINAL_THEME,
  resolveTerminalFontWeights,
  resolveTerminalMinimumContrastRatio,
} from './terminal-visuals.js';
import { nextTerminalFontSize } from './terminal-zoom.js';

describe('Orca-compatible terminal visuals', () => {
  it('uses medium text and a bold weight of at least 700', () => {
    expect(resolveTerminalFontWeights(500)).toEqual({ fontWeight: 500, fontWeightBold: 700 });
    expect(resolveTerminalFontWeights(800)).toEqual({ fontWeight: 800, fontWeightBold: 900 });
  });

  it('applies WCAG AA correction to light backgrounds and a mild dark floor', () => {
    expect(resolveTerminalMinimumContrastRatio(ORCA_LIGHT_TERMINAL_THEME, false)).toBe(
      LIGHT_TERMINAL_MIN_CONTRAST,
    );
    expect(resolveTerminalMinimumContrastRatio(ORCA_DARK_TERMINAL_THEME, true)).toBe(
      DARK_TERMINAL_MIN_CONTRAST,
    );
  });

  it('steps one terminal independently and resets it to the global size', () => {
    expect(nextTerminalFontSize(14, 14, 'in')).toEqual({ fontSize: 15, override: 15 });
    expect(nextTerminalFontSize(8, 14, 'out')).toEqual({ fontSize: 8, override: 8 });
    expect(nextTerminalFontSize(19, 14, 'reset')).toEqual({ fontSize: 14, override: null });
  });
});
