import type { ITheme } from '@xterm/xterm';

export const LIGHT_TERMINAL_MIN_CONTRAST = 4.5;
export const DARK_TERMINAL_MIN_CONTRAST = 3;

export const ORCA_DARK_TERMINAL_THEME: ITheme = {
  background: '#282c34',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#282c34',
  selectionBackground: '#5a7898',
  selectionForeground: '#ffffff',
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#d54e53',
  brightGreen: '#b9ca4a',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#eaeaea',
};

export const ORCA_LIGHT_TERMINAL_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#2e3434',
  cursor: '#2e3434',
  cursorAccent: '#ffffff',
  selectionBackground: '#accef7',
  selectionForeground: '#2e3434',
  black: '#2e3436',
  red: '#cc0000',
  green: '#4e9a06',
  yellow: '#8e7700',
  blue: '#3465a4',
  magenta: '#75507b',
  cyan: '#05727e',
  white: '#6a6a6a',
  brightBlack: '#555753',
  brightRed: '#ef2929',
  brightGreen: '#1b7a1b',
  brightYellow: '#6d5a00',
  brightBlue: '#204a87',
  brightMagenta: '#ad7fa8',
  brightCyan: '#034b50',
  brightWhite: '#3d3d3d',
};

export function resolveTerminalFontWeights(fontWeight: number): {
  fontWeight: number;
  fontWeightBold: number;
} {
  const normal = Math.min(900, Math.max(100, Math.round(fontWeight)));
  return {
    fontWeight: normal,
    fontWeightBold: Math.min(900, Math.max(700, normal + 200)),
  };
}

function isLightBackground(color: string | undefined, fallbackDark: boolean): boolean {
  const match = color?.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!match) return !fallbackDark;
  const channels = match.slice(1).map((part) => Number.parseInt(part, 16) / 255);
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722 > 0.5;
}

export function resolveTerminalMinimumContrastRatio(theme: ITheme, appDark: boolean): number {
  return isLightBackground(theme.background, appDark)
    ? LIGHT_TERMINAL_MIN_CONTRAST
    : DARK_TERMINAL_MIN_CONTRAST;
}

/**
 * xterm's default scrollbar slider is the foreground at 20% opacity — on our
 * light surfaces that reads as "no scrollbar at all" (user-reported). Derive
 * explicit slider colors from each theme's own ink so every skin keeps a
 * visible, hover-responsive slider without per-skin tuning.
 */
export function withTerminalScrollbarColors(theme: ITheme): ITheme {
  if (theme.scrollbarSliderBackground) return theme;
  const ink =
    theme.foreground && /^#[\da-f]{6}$/i.test(theme.foreground)
      ? theme.foreground
      : isLightBackground(theme.background, false)
        ? '#2e3434'
        : '#ffffff';
  return {
    ...theme,
    scrollbarSliderBackground: `${ink}52`,
    scrollbarSliderHoverBackground: `${ink}73`,
    scrollbarSliderActiveBackground: `${ink}8c`,
  };
}

export function terminalThemesEqual(a: ITheme | undefined, b: ITheme): boolean {
  if (!a) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'extendedAnsi') continue;
    if (a[key as keyof ITheme] !== b[key as keyof ITheme]) return false;
  }
  const extendedA = a.extendedAnsi;
  const extendedB = b.extendedAnsi;
  if (!extendedA || !extendedB) return extendedA === extendedB;
  return (
    extendedA.length === extendedB.length &&
    extendedA.every((value, index) => value === extendedB[index])
  );
}
