import { describe, expect, it } from 'vitest';
import {
  collapseUnchanged,
  markdownBlockDiff,
  referenceDefinitions,
  splitMarkdownBlocks,
} from './markdown-block-diff.js';

describe('splitMarkdownBlocks', () => {
  it('splits on blank lines but keeps fenced code and front matter whole', () => {
    const text = [
      '---',
      'title: Doc',
      '',
      'draft: true',
      '---',
      '# Title',
      '',
      'Intro paragraph',
      'continues here.',
      '',
      '```ts',
      'const a = 1;',
      '',
      'const b = 2;',
      '```',
      '',
      '- one',
      '- two',
    ].join('\n');
    expect(splitMarkdownBlocks(text)).toEqual([
      '---\ntitle: Doc\n\ndraft: true\n---',
      '# Title',
      'Intro paragraph\ncontinues here.',
      '```ts\nconst a = 1;\n\nconst b = 2;\n```',
      '- one\n- two',
    ]);
  });

  it('only closes a fence with the same marker of at least the opening length', () => {
    const text = '````md\n```\ninner\n```\n\nstill code\n````\n\nafter';
    expect(splitMarkdownBlocks(text)).toEqual([
      '````md\n```\ninner\n```\n\nstill code\n````',
      'after',
    ]);
  });

  it('normalizes CRLF line endings', () => {
    expect(splitMarkdownBlocks('a\r\n\r\nb\r\n')).toEqual(['a', 'b']);
  });
});

describe('markdownBlockDiff', () => {
  it('pairs an edited paragraph and keeps unchanged blocks aligned', () => {
    const before = '# Title\n\nOld sentence.\n\nKept tail.';
    const after = '# Title\n\nNew sentence.\n\nKept tail.';
    expect(markdownBlockDiff(before, after)).toEqual([
      { kind: 'same', before: '# Title', after: '# Title' },
      { kind: 'changed', before: 'Old sentence.', after: 'New sentence.' },
      { kind: 'same', before: 'Kept tail.', after: 'Kept tail.' },
    ]);
  });

  it('reports inserted and deleted blocks on their own side', () => {
    const rows = markdownBlockDiff('A\n\nB\n\nC', 'A\n\nC\n\nD');
    expect(rows.map((row) => row.kind)).toEqual(['same', 'removed', 'same', 'added']);
    expect(rows[1]).toEqual({ kind: 'removed', before: 'B', after: null });
    expect(rows[3]).toEqual({ kind: 'added', before: null, after: 'D' });
  });

  it('treats a missing side as a wholly created or deleted document', () => {
    expect(markdownBlockDiff(null, 'A\n\nB').map((row) => row.kind)).toEqual(['added', 'added']);
    expect(markdownBlockDiff('A', null).map((row) => row.kind)).toEqual(['removed']);
  });

  it('ignores trailing whitespace when matching blocks', () => {
    expect(markdownBlockDiff('Same  \n\nEnd', 'Same\n\nEnd').map((row) => row.kind)).toEqual([
      'same',
      'same',
    ]);
  });
});

describe('collapseUnchanged', () => {
  it('folds long unchanged runs but keeps context around changes', () => {
    const before = ['1', '2', '3', '4', '5', 'old', '7'].join('\n\n');
    const after = ['1', '2', '3', '4', '5', 'new', '7'].join('\n\n');
    const display = collapseUnchanged(markdownBlockDiff(before, after));
    expect(display[0]).toEqual({
      kind: 'gap',
      rows: ['1', '2', '3', '4'].map((block) => ({ kind: 'same', before: block, after: block })),
    });
    expect(display.slice(1).map((row) => row.kind)).toEqual(['same', 'changed', 'same']);
  });

  it('never folds a single block', () => {
    const display = collapseUnchanged(
      markdownBlockDiff('1\n\n2\n\nx\n\n4\n\n5', '1\n\n2\n\ny\n\n4\n\n5'),
    );
    expect(display.map((row) => row.kind)).toEqual(['same', 'same', 'changed', 'same', 'same']);
  });
});

describe('referenceDefinitions', () => {
  it('collects reference link definitions for per-block rendering', () => {
    expect(referenceDefinitions('See [docs][d].\n\n[d]: https://example.com\n\nText')).toBe(
      '[d]: https://example.com',
    );
  });
});
