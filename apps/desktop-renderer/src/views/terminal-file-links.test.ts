import { describe, expect, it } from 'vitest';
import {
  detectFileLinks,
  detectWideCandidates,
  fileLinkHint,
  mergeFileLinks,
  readBufferLine,
  readWrappedLine,
  resolveWideMatches,
  splitLineSuffix,
  MAX_STAT_TOKENS,
  type BufferReader,
  type CellReader,
} from './terminal-file-links.js';

const texts = (line: string) => detectFileLinks(line).map((m) => m.text);

describe('detectFileLinks (ADR-0033 regex fallback)', () => {
  it('finds bare file names the way Claude Code prints them', () => {
    expect(texts('在浏览器中打开 rocket.html 就能看到效果')).toEqual(['rocket.html']);
    expect(texts('Created rocket.html and styles.css')).toEqual(['rocket.html', 'styles.css']);
  });

  it('finds relative, dotted, home and absolute paths, with line suffixes', () => {
    expect(texts('see src/app.ts:12:3 for details')).toEqual(['src/app.ts:12:3']);
    expect(texts('wrote ./out/index.html')).toEqual(['./out/index.html']);
    expect(texts('backup at ../old/site.html')).toEqual(['../old/site.html']);
    expect(texts('log: ~/logs/run.log')).toEqual(['~/logs/run.log']);
    expect(texts('open /Users/dev/playground/rocket.html now')).toEqual([
      '/Users/dev/playground/rocket.html',
    ]);
    expect(texts('win: C:/proj/a.html')).toEqual(['C:/proj/a.html']);
  });

  it('handles dotted base names and punctuation wrappers', () => {
    expect(texts('fixed external-replay-parser.test.ts today')).toEqual([
      'external-replay-parser.test.ts',
    ]);
    expect(texts('(rocket.html)')).toEqual(['rocket.html']);
    expect(texts('"rocket.html", done.')).toEqual(['rocket.html']);
    expect(texts('打开 rocket.html。')).toEqual(['rocket.html']);
  });

  it('never linkifies version numbers or bare prose', () => {
    expect(texts('Charter v1.0 released')).toEqual([]);
    expect(texts('每 3.5 秒循环一次')).toEqual([]);
    expect(texts('54872 tokens')).toEqual([]);
  });

  it('skips tokens glued into URLs — WebLinksAddon owns those', () => {
    expect(texts('https://site.com/x.html')).toEqual([]);
    expect(texts('file:///Users/dev/a.html')).toEqual([]);
  });

  it('reports string offsets usable for highlighting', () => {
    const [m] = detectFileLinks('open rocket.html now');
    expect(m).toMatchObject({ text: 'rocket.html', start: 5, end: 16 });
  });
});

describe('splitLineSuffix', () => {
  it('splits :line and :line:col suffixes', () => {
    expect(splitLineSuffix('src/app.ts:12')).toEqual({ path: 'src/app.ts', line: 12 });
    expect(splitLineSuffix('src/app.ts:12:3')).toEqual({ path: 'src/app.ts', line: 12 });
  });

  it('leaves plain tokens and Windows drive colons alone', () => {
    expect(splitLineSuffix('rocket.html')).toEqual({ path: 'rocket.html', line: null });
    expect(splitLineSuffix('C:/proj/a.html')).toEqual({ path: 'C:/proj/a.html', line: null });
  });
});

describe('fileLinkHint', () => {
  it('mirrors the host browser/editor split and the platform modifier', () => {
    expect(fileLinkHint('rocket.html', true)).toBe('⌘+click to open in browser');
    expect(fileLinkHint('src/app.ts:12', true)).toBe('⌘+click to open in editor');
    expect(fileLinkHint('rocket.html', false)).toBe('Ctrl+click to open in browser');
  });
});

/** Resolve one line end-to-end the way TerminalPanel does, against a fake disk. */
function resolveLine(line: string, disk: string[]): string[] {
  const sure = detectFileLinks(line);
  const groups = detectWideCandidates(line, sure);
  const onDisk = new Set(disk);
  const wide = resolveWideMatches(groups, (path) => onDisk.has(path));
  return mergeFileLinks(sure, wide).map((m) => m.text);
}

describe('detectWideCandidates + resolveWideMatches (ADR-0033 am.1 stat boundaries)', () => {
  it('recovers a macOS screenshot name, superseding the narrower regex hit', () => {
    const line = 'Wrote Screenshot 2026-07-20 at 10.05.32.png to the project';
    // Regex alone can only see the dotted tail.
    expect(detectFileLinks(line).map((m) => m.text)).toEqual(['10.05.32.png']);
    expect(resolveLine(line, ['Screenshot 2026-07-20 at 10.05.32.png'])).toEqual([
      'Screenshot 2026-07-20 at 10.05.32.png',
    ]);
  });

  it('recovers CJK paths with spaces, with prose before them', () => {
    expect(resolveLine('已写入 素材/截图 2026.png', ['素材/截图 2026.png'])).toEqual([
      '素材/截图 2026.png',
    ]);
  });

  it('falls back to the plain regex hit when nothing wider exists on disk', () => {
    expect(resolveLine('Created rocket.html and styles.css', [])).toEqual([
      'rocket.html',
      'styles.css',
    ]);
  });

  it('prefers the longest candidate that exists', () => {
    // Both `b.png` and `a b.png` exist — the wider one wins.
    expect(resolveLine('open a b.png', ['b.png', 'a b.png'])).toEqual(['a b.png']);
  });

  it('stops expanding at quotes, CJK punctuation and column gaps', () => {
    const quoted = detectWideCandidates('log "my file.png"', []);
    expect(quoted[0]!.map((c) => c.text)).toEqual(['my file.png', 'file.png']);
    const cjk = detectWideCandidates('已保存：报告 v2.pdf', []);
    expect(cjk[0]!.map((c) => c.text)).toEqual(['报告 v2.pdf', 'v2.pdf']);
    const columns = detectWideCandidates('10:00  my file.png', []);
    expect(columns[0]!.map((c) => c.text)).toEqual(['my file.png', 'file.png']);
  });

  it('keeps the :line suffix on the link but strips it for the stat probe', () => {
    const groups = detectWideCandidates('at src dir/app.ts:12:3', []);
    const full = groups[0]!.find((c) => c.text.startsWith('src dir'));
    expect(full).toMatchObject({ text: 'src dir/app.ts:12:3', statPath: 'src dir/app.ts' });
  });

  it('omits candidates identical to a strict match — those need no probe', () => {
    const line = 'open rocket.html';
    const groups = detectWideCandidates(line, detectFileLinks(line));
    expect(groups[0]!.map((c) => c.text)).toEqual(['open rocket.html']);
  });

  it('caps the probe batch within the channel schema', () => {
    const line = Array.from({ length: 30 }, (_, i) => `w${i} f${i}.png`).join(' | ');
    const total = detectWideCandidates(line, detectFileLinks(line))
      .flat()
      .map((c) => c.statPath);
    expect(total.length).toBeLessThanOrEqual(MAX_STAT_TOKENS);
  });

  it('never anchors mid-token (.ts.bak, a.ts-old): only the real extension anchors', () => {
    const line = 'keep a.ts.bak and a.ts-old around';
    const anchors = detectWideCandidates(line, detectFileLinks(line));
    // One group (the .bak anchor); the .ts dots inside both tokens are ignored.
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.map((c) => c.text)).toEqual(['keep a.ts.bak']);
  });
});

describe('mergeFileLinks', () => {
  it('drops regex hits swallowed by a verified wide match, keeps the rest', () => {
    const sure = [
      { text: '10.05.32.png', start: 20, end: 32 },
      { text: 'other.ts', start: 40, end: 48 },
    ];
    const wide = [{ text: 'Shot 10.05.32.png', start: 15, end: 32 }];
    expect(mergeFileLinks(sure, wide).map((m) => m.text)).toEqual([
      'Shot 10.05.32.png',
      'other.ts',
    ]);
  });

  it('keeps the earliest of overlapping wide matches', () => {
    const wide = [
      { text: 'a b.png c.png', start: 0, end: 13 },
      { text: 'c.png', start: 8, end: 13 },
    ];
    expect(mergeFileLinks([], wide).map((m) => m.text)).toEqual(['a b.png c.png']);
  });
});

function fakeLine(cells: Array<{ chars: string; width: number }>): CellReader {
  return {
    length: cells.length,
    getCell: (x) =>
      cells[x] && {
        getChars: () => cells[x]!.chars,
        getWidth: () => cells[x]!.width,
      },
  };
}

describe('readBufferLine (wide-glyph cell mapping)', () => {
  it('maps string indexes back to cells across CJK text', () => {
    // "打开 a.html" — each CJK glyph is one string char but two buffer cells.
    const line = fakeLine([
      { chars: '打', width: 2 },
      { chars: '', width: 0 },
      { chars: '开', width: 2 },
      { chars: '', width: 0 },
      { chars: ' ', width: 1 },
      { chars: 'a', width: 1 },
      { chars: '.', width: 1 },
      { chars: 'h', width: 1 },
      { chars: 't', width: 1 },
      { chars: 'm', width: 1 },
      { chars: 'l', width: 1 },
    ]);
    const { text, cellOf } = readBufferLine(line);
    expect(text).toBe('打开 a.html');
    const [m] = detectFileLinks(text);
    expect(m!.text).toBe('a.html');
    // First char of the token sits on buffer cell 5, last on cell 10.
    expect(cellOf[m!.start]).toBe(5);
    expect(cellOf[m!.end - 1]).toBe(10);
  });

  it('renders empty cells as spaces so offsets stay aligned', () => {
    const line = fakeLine([
      { chars: 'a', width: 1 },
      { chars: '', width: 1 },
      { chars: 'b', width: 1 },
    ]);
    expect(readBufferLine(line).text).toBe('a b');
  });
});

function fakeBuffer(
  rows: Array<{ cells: Array<{ chars: string; width: number }>; wrapped?: boolean }>,
): BufferReader {
  return {
    getLine: (y) =>
      rows[y] && Object.assign(fakeLine(rows[y]!.cells), { isWrapped: rows[y]!.wrapped ?? false }),
  };
}

const ascii = (s: string) => [...s].map((chars) => ({ chars, width: 1 }));

describe('readWrappedLine (ADR-0033 am.1 logical lines)', () => {
  it('joins a path re-flowed across rows, from any hovered row', () => {
    const buffer = fakeBuffer([
      { cells: ascii('open src/deep/') },
      { cells: ascii('file.ts now'), wrapped: true },
    ]);
    for (const y of [0, 1]) {
      const { text } = readWrappedLine(buffer, y);
      expect(text).toBe('open src/deep/file.ts now');
      expect(detectFileLinks(text).map((m) => m.text)).toEqual(['src/deep/file.ts']);
    }
  });

  it('maps joined string indexes back to per-row cells', () => {
    const buffer = fakeBuffer([{ cells: ascii('ok a/') }, { cells: ascii('b.ts'), wrapped: true }]);
    const { text, cellAt } = readWrappedLine(buffer, 0);
    const [m] = detectFileLinks(text);
    expect(m!.text).toBe('a/b.ts');
    expect(cellAt[m!.start]).toEqual({ y: 0, x: 3 });
    expect(cellAt[m!.end - 1]).toEqual({ y: 1, x: 3 });
  });

  it('drops the phantom padding cell a wide glyph leaves at a row break', () => {
    // Row 0 ends with an unwritten cell because 图 (width 2) did not fit.
    const buffer = fakeBuffer([
      {
        cells: [
          ...ascii('见 '),
          { chars: '截', width: 2 },
          { chars: '', width: 0 },
          { chars: '', width: 1 },
        ],
      },
      {
        cells: [{ chars: '图', width: 2 }, { chars: '', width: 0 }, ...ascii('.png')],
        wrapped: true,
      },
    ]);
    expect(readWrappedLine(buffer, 0).text).toBe('见 截图.png');
  });

  it('does not join rows that are not wrap continuations', () => {
    const buffer = fakeBuffer([{ cells: ascii('one.ts') }, { cells: ascii('two.ts') }]);
    expect(readWrappedLine(buffer, 0).text).toBe('one.ts');
    expect(readWrappedLine(buffer, 1).text).toBe('two.ts');
  });

  it('caps runaway wrapped blocks instead of stalling hover', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      cells: ascii('x'.repeat(4)),
      wrapped: i > 0,
    }));
    const { text } = readWrappedLine(fakeBuffer(rows), 10);
    expect(text.length).toBeLessThanOrEqual(8 * 4);
  });
});
