export type TerminalZoomDirection = 'in' | 'out' | 'reset';

export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;

export function nextTerminalFontSize(
  currentSize: number,
  baseSize: number,
  direction: TerminalZoomDirection,
): { fontSize: number; override: number | null } {
  if (direction === 'reset') return { fontSize: baseSize, override: null };
  const delta = direction === 'in' ? 1 : -1;
  const fontSize = Math.max(
    TERMINAL_FONT_SIZE_MIN,
    Math.min(TERMINAL_FONT_SIZE_MAX, currentSize + delta),
  );
  return { fontSize, override: fontSize };
}
