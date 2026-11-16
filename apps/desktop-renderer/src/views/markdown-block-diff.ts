/**
 * Reader-view diff for Markdown review (ADR-0060). A document is split into
 * top-level blocks (paragraphs, headings, lists, tables, fenced code), the two
 * block sequences are aligned, and each row renders both sides so a reviewer
 * compares what readers will see rather than raw source lines.
 */

export type MdRowKind = 'same' | 'changed' | 'removed' | 'added';

export interface MdBlockRow {
  kind: MdRowKind;
  before: string | null;
  after: string | null;
}

export type MdDisplayRow = MdBlockRow | { kind: 'gap'; rows: MdBlockRow[] };

/** Alignment cost guard: larger edited regions degrade to remove-then-add. */
const MAX_ALIGN_CELLS = 4_000_000;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const REFERENCE_DEFINITION_RE = /^ {0,3}\[[^\]\n]+\]:\s*\S/;

/** Blank lines end a block except inside fenced code or leading front matter. */
export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { char: string; length: number } | null = null;
  let index = 0;

  const flush = (): void => {
    if (current.length > 0) blocks.push(current.join('\n'));
    current = [];
  };

  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end > 0) {
      blocks.push(lines.slice(0, end + 1).join('\n'));
      index = end + 1;
    }
  }

  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    const marker = FENCE_RE.exec(line)?.[1];
    if (fence) {
      current.push(line);
      if (marker && marker[0] === fence.char && marker.length >= fence.length) {
        if (line.trim() === marker) fence = null;
      }
      continue;
    }
    if (marker) {
      fence = { char: marker[0]!, length: marker.length };
      current.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/** Reference-style link definitions, appended to every rendered block so a
 * block split away from its `[label]: url` line still resolves the link. */
export function referenceDefinitions(text: string): string {
  return splitMarkdownBlocks(text)
    .flatMap((block) => block.split('\n'))
    .filter((line) => REFERENCE_DEFINITION_RE.test(line))
    .join('\n');
}

function normalize(block: string): string {
  return block
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

type Op =
  { kind: 'same'; a: number; b: number } | { kind: 'del'; a: number } | { kind: 'ins'; b: number };

function alignMiddle(a: string[], b: string[], aStart: number, bStart: number): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, j) => ({ kind: 'ins' as const, b: bStart + j }));
  if (m === 0) return a.map((_, i) => ({ kind: 'del' as const, a: aStart + i }));
  if (n * m > MAX_ALIGN_CELLS) {
    return [
      ...a.map((_, i) => ({ kind: 'del' as const, a: aStart + i })),
      ...b.map((_, j) => ({ kind: 'ins' as const, b: bStart + j })),
    ];
  }
  // Longest common subsequence over block text, filled from the end so the
  // walk below can emit operations front to back.
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', a: aStart + i, b: bStart + j });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      ops.push({ kind: 'del', a: aStart + i });
      i += 1;
    } else {
      ops.push({ kind: 'ins', b: bStart + j });
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push({ kind: 'del', a: aStart + i });
  for (; j < m; j += 1) ops.push({ kind: 'ins', b: bStart + j });
  return ops;
}

/** Aligned rows; adjacent removed/added runs pair up as `changed` rows. */
export function markdownBlockDiff(before: string | null, after: string | null): MdBlockRow[] {
  const a = before === null ? [] : splitMarkdownBlocks(before);
  const b = after === null ? [] : splitMarkdownBlocks(after);
  const na = a.map(normalize);
  const nb = b.map(normalize);

  let prefix = 0;
  while (prefix < na.length && prefix < nb.length && na[prefix] === nb[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < na.length - prefix &&
    suffix < nb.length - prefix &&
    na[na.length - 1 - suffix] === nb[nb.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const ops: Op[] = [];
  for (let k = 0; k < prefix; k += 1) ops.push({ kind: 'same', a: k, b: k });
  ops.push(
    ...alignMiddle(
      na.slice(prefix, na.length - suffix),
      nb.slice(prefix, nb.length - suffix),
      prefix,
      prefix,
    ),
  );
  for (let k = suffix; k > 0; k -= 1) {
    ops.push({ kind: 'same', a: na.length - k, b: nb.length - k });
  }

  const rows: MdBlockRow[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = (): void => {
    const paired = Math.min(removed.length, added.length);
    for (let k = 0; k < paired; k += 1) {
      rows.push({ kind: 'changed', before: removed[k]!, after: added[k]! });
    }
    for (const block of removed.slice(paired))
      rows.push({ kind: 'removed', before: block, after: null });
    for (const block of added.slice(paired))
      rows.push({ kind: 'added', before: null, after: block });
    removed = [];
    added = [];
  };
  for (const op of ops) {
    if (op.kind === 'del') removed.push(a[op.a]!);
    else if (op.kind === 'ins') added.push(b[op.b]!);
    else {
      flush();
      rows.push({ kind: 'same', before: a[op.a]!, after: b[op.b]! });
    }
  }
  flush();
  return rows;
}

/** Fold long unchanged runs, keeping `context` blocks around each change. */
export function collapseUnchanged(rows: MdBlockRow[], context = 1): MdDisplayRow[] {
  const keep = rows.map((row) => row.kind !== 'same');
  const near = rows.map((_, index) => {
    for (let d = -context; d <= context; d += 1) {
      if (keep[index + d]) return true;
    }
    return false;
  });
  const out: MdDisplayRow[] = [];
  let gap: MdBlockRow[] = [];
  const flushGap = (): void => {
    if (gap.length === 0) return;
    // Folding a single block saves nothing; show it in place.
    if (gap.length === 1) out.push(gap[0]!);
    else out.push({ kind: 'gap', rows: gap });
    gap = [];
  };
  rows.forEach((row, index) => {
    if (near[index]) {
      flushGap();
      out.push(row);
    } else {
      gap.push(row);
    }
  });
  flushGap();
  return out;
}
