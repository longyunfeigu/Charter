import { TERMINAL_EXTERNAL_OPEN_EXTENSIONS } from '@pi-ide/ipc-contracts';

/**
 * ADR-0033: pure detection/parsing for file tokens in terminal output so
 * ⌘+click can open them (browser for html-ish files, editor otherwise).
 * Everything here is buffer-free and unit-tested; TerminalPanel wires it to
 * xterm's link provider API.
 */

/** A file-looking token inside one flattened buffer line. Offsets are indexes
 * into the JS string from `readBufferLine` (NOT cell columns — wide CJK glyphs
 * occupy two cells but one string slot; use `cellOf` to map back). */
export interface FileLinkMatch {
  text: string;
  start: number;
  /** Exclusive. */
  end: number;
}

const SEG = String.raw`[\w.@+#-]+`;
// A letter-led extension so prose like "v1.0" or "3.5" never linkifies.
const EXT = String.raw`\.[A-Za-z][A-Za-z0-9]{0,7}`;
const LINE_SUFFIX = String.raw`(?::\d+(?::\d+)?)?`;
// Unix-ish path (absolute, ~/, ./, ../ or bare relative) or a Windows drive
// path — always ending in an extension, optionally with :line[:col].
const FILE_TOKEN = new RegExp(
  String.raw`(?:[A-Za-z]:[\\/]|~/|\.\.?/|/)?(?:${SEG}[\\/])*${SEG}${EXT}${LINE_SUFFIX}`,
  'g',
);

/** Chars that mean "this token is glued to a larger word/path/URL" — e.g. the
 * `site.com/x.html` tail of `https://site.com/x.html` is preceded by `/`. */
const GLUED_BEFORE = /[\w/\\:.@~-]/;

export function detectFileLinks(lineText: string): FileLinkMatch[] {
  const out: FileLinkMatch[] = [];
  FILE_TOKEN.lastIndex = 0;
  for (let m = FILE_TOKEN.exec(lineText); m; m = FILE_TOKEN.exec(lineText)) {
    const before = m.index === 0 ? '' : lineText[m.index - 1]!;
    if (before !== '' && GLUED_BEFORE.test(before)) continue;
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** `src/app.ts:12:3` → path `src/app.ts`, line 12. Windows drive colons survive. */
export function splitLineSuffix(token: string): { path: string; line: number | null } {
  const m = /^(.+?):(\d+)(?::\d+)?$/.exec(token);
  // A single-letter "path" is a drive letter (C:120 is not a file), not a hit.
  if (m && !/^[A-Za-z]$/.test(m[1]!)) return { path: m[1]!, line: Number(m[2]) };
  return { path: token, line: null };
}

const EXTERNAL_EXTS = new Set<string>(TERMINAL_EXTERNAL_OPEN_EXTENSIONS);

/** Hover hint mirroring the host's browser/editor split for this token. */
export function fileLinkHint(token: string, mac: boolean): string {
  const { path } = splitLineSuffix(token);
  const ext = /\.[A-Za-z][A-Za-z0-9]{0,7}$/.exec(path)?.[0]?.toLowerCase() ?? '';
  const modifier = mac ? '⌘' : 'Ctrl';
  return EXTERNAL_EXTS.has(ext)
    ? `${modifier}+click to open in browser`
    : `${modifier}+click to open in editor`;
}

/** Minimal slice of xterm's IBufferLine that `readBufferLine` needs. */
export interface CellReader {
  length: number;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}

/** Flatten one buffer row to a string plus a per-string-index map back to the
 * 0-based buffer cell — regex offsets are string indexes, but link ranges need
 * cell columns and CJK text before a token shifts them apart. */
export function readBufferLine(line: CellReader): { text: string; cellOf: number[] } {
  let text = '';
  const cellOf: number[] = [];
  for (let x = 0; x < line.length; x += 1) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // trailing half of a wide glyph
    const chars = cell.getChars() || ' ';
    for (let i = 0; i < chars.length; i += 1) cellOf.push(x);
    text += chars;
  }
  return { text, cellOf };
}
