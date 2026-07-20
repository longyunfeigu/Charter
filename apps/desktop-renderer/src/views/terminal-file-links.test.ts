import { describe, expect, it } from 'vitest';
import {
  detectFileLinks,
  fileLinkHint,
  readBufferLine,
  splitLineSuffix,
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
