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

/**
 * ADR-0033 am.1: paths with spaces or CJK segments (`素材/截图 2026.png`,
 * `Screenshot 2026-07-20 at 10.05.32.png`) are invisible to FILE_TOKEN, and no
 * regex can know whether a space belongs to the name. Instead of guessing we
 * anchor on the extension, expand leftwards into every plausible boundary, and
 * let the host stat each candidate — the longest one that actually exists on
 * disk becomes the link (superseding any narrower regex hit it contains).
 */
export interface WideCandidate {
  text: string;
  start: number;
  /** Exclusive; shared by all candidates of one extension anchor. */
  end: number;
  /** `text` minus any :line:col suffix — what the host should stat. */
  statPath: string;
}

/** Chars that terminate the leftward scan — never part of a real file name in
 * terminal prose: quotes, pipes, globs, CJK punctuation, full-width space.
 * A single ASCII space is deliberately NOT here — spanning it is the point. */
const HARD_BOUNDARY =
  /[\t"'`|<>*?\u{FF0C}\u{3002}\u{FF1B}\u{FF1A}\u{FF01}\u{FF1F}\u{3001}\u{300A}-\u{300F}\u{3010}\u{3011}\u{FF08}\u{FF09}\u{3000}\u{2026}\u{2014}]/u;
/** ASCII separators that suggest "a token may start right after me". */
const SOFT_OPENER = /[([{=:,;]/;
const EXT_ANCHOR = new RegExp(`${EXT}${LINE_SUFFIX}`, 'g');
const CJK_START = 0x2e80;
const MAX_STARTS_PER_ANCHOR = 6;
/** Ceiling on tokens per stat batch — must stay within the channel schema. */
export const MAX_STAT_TOKENS = 24;

const isCjk = (chr: string | undefined): boolean =>
  chr !== undefined && chr.charCodeAt(0) >= CJK_START;

/** Candidate groups per extension anchor, longest candidate first. Candidates
 * identical to a strict match are omitted — those link without verification. */
export function detectWideCandidates(lineText: string, sure: FileLinkMatch[]): WideCandidate[][] {
  const groups: WideCandidate[][] = [];
  let budget = MAX_STAT_TOKENS;
  EXT_ANCHOR.lastIndex = 0;
  for (let m = EXT_ANCHOR.exec(lineText); m; m = EXT_ANCHOR.exec(lineText)) {
    if (budget <= 0) break;
    const dot = m.index;
    const end = m.index + m[0].length;
    const after = lineText[end];
    // Mid-token anchors (`a.ts.bak`, `a.ts-old`, `dir.d/x`) are not file ends.
    if (after !== undefined && /[\w./\\-]/.test(after)) continue;
    const base = lineText[dot - 1];
    if (base === undefined || base === ' ' || HARD_BOUNDARY.test(base)) continue;

    // Leftward scan: region of chars that could still belong to the name.
    let regionStart = dot;
    while (regionStart > 0) {
      const prev = lineText[regionStart - 1]!;
      if (HARD_BOUNDARY.test(prev)) break;
      if (prev === ' ' && lineText[regionStart - 2] === ' ') break; // column gap
      regionStart -= 1;
    }

    const starts = new Set<number>([regionStart]);
    for (let i = regionStart + 1; i < dot; i += 1) {
      const prev = lineText[i - 1]!;
      if (prev === ' ' || SOFT_OPENER.test(prev)) starts.add(i);
      else if (isCjk(prev) && !isCjk(lineText[i])) starts.add(i); // prose→path
    }

    // Prefer starts nearest the extension (paths rarely hold many spaces),
    // but always keep the full region as the longest shot.
    const ordered = [...starts].sort((a, b) => a - b);
    const kept =
      ordered.length <= MAX_STARTS_PER_ANCHOR
        ? ordered
        : [ordered[0]!, ...ordered.slice(-(MAX_STARTS_PER_ANCHOR - 1))];

    const group: WideCandidate[] = [];
    for (const start of kept) {
      if (budget <= 0) break;
      const text = lineText.slice(start, end);
      if (text.length > 1024) continue;
      if (text[0] === ' ') continue;
      if (sure.some((s) => s.start === start && s.end === end)) continue;
      group.push({ text, start, end, statPath: splitLineSuffix(text).path });
      budget -= 1;
    }
    if (group.length > 0) groups.push(group);
  }
  return groups;
}

/** Pick the longest verified candidate per anchor. `exists` is keyed by
 * statPath (the host's response order matches the flattened request). */
export function resolveWideMatches(
  groups: WideCandidate[][],
  exists: (statPath: string) => boolean,
): FileLinkMatch[] {
  const out: FileLinkMatch[] = [];
  for (const group of groups) {
    const hit = group.find((candidate) => exists(candidate.statPath));
    if (hit) out.push({ text: hit.text, start: hit.start, end: hit.end });
  }
  return out;
}

/** Verified wide matches supersede any regex hit they overlap (`10.05.32.png`
 * inside `Screenshot … 10.05.32.png`); wide-vs-wide overlaps keep the earliest. */
export function mergeFileLinks(sure: FileLinkMatch[], wide: FileLinkMatch[]): FileLinkMatch[] {
  const keptWide: FileLinkMatch[] = [];
  for (const match of [...wide].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (!keptWide.some((w) => match.start < w.end && w.start < match.end)) {
      keptWide.push(match);
    }
  }
  const keptSure = sure.filter((s) => !keptWide.some((w) => s.start < w.end && w.start < s.end));
  return [...keptSure, ...keptWide].sort((a, b) => a.start - b.start);
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

/** Buffer row that also knows whether it continues the row above it. */
export interface WrappedCellReader extends CellReader {
  isWrapped: boolean;
}

/** Minimal slice of xterm's IBuffer that `readWrappedLine` needs. */
export interface BufferReader {
  getLine(y: number): WrappedCellReader | undefined;
}

/** A string index mapped back to its 0-based buffer row and cell. */
export interface WrappedCellRef {
  y: number;
  x: number;
}

/** ADR-0033 am.1 lifts the "wrapped long paths are invisible" limitation: a
 * path re-flowed across rows is one logical line to the shell but N buffer
 * rows to us — sane detection needs the joined text. */
const MAX_WRAPPED_ROWS = 8;

/**
 * Flatten the whole logical line containing 0-based buffer row `y` (walk up
 * while the row is a wrap continuation, then down while the next row is one),
 * capped at MAX_WRAPPED_ROWS so pathological output can't stall hover. On
 * non-final rows, trailing never-written padding cells (a wide glyph that did
 * not fit the last column) are dropped instead of becoming phantom spaces
 * inside a CJK path.
 */
export function readWrappedLine(
  buffer: BufferReader,
  y: number,
): { text: string; cellAt: WrappedCellRef[] } {
  let first = y;
  while (first > 0 && first > y - (MAX_WRAPPED_ROWS - 1) && buffer.getLine(first)?.isWrapped) {
    first -= 1;
  }
  let last = y;
  while (last - first < MAX_WRAPPED_ROWS - 1 && buffer.getLine(last + 1)?.isWrapped) {
    last += 1;
  }

  let text = '';
  const cellAt: WrappedCellRef[] = [];
  for (let row = first; row <= last; row += 1) {
    const line = buffer.getLine(row);
    if (!line) break;
    let rowText = '';
    const rowCells: WrappedCellRef[] = [];
    let written = 0; // rowText length up to the last cell with real content
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      if (!cell) break;
      if (cell.getWidth() === 0) continue;
      const chars = cell.getChars();
      for (let i = 0; i < (chars || ' ').length; i += 1) rowCells.push({ y: row, x });
      rowText += chars || ' ';
      if (chars !== '') written = rowText.length;
    }
    if (row !== last) {
      rowText = rowText.slice(0, written);
      rowCells.length = written;
    }
    text += rowText;
    cellAt.push(...rowCells);
  }
  return { text, cellAt };
}
