import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchService } from './search.js';

let root: string;
let service: SearchService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-ide-search-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules/x'), { recursive: true });
  writeFileSync(join(root, 'src/alpha.ts'), 'const alpha = 1;\nconst needle = "alpha";\n');
  writeFileSync(join(root, 'src/beta.ts'), 'function needleFactory() {}\nconst Needle = 2;\n');
  writeFileSync(join(root, 'README.md'), 'needle in docs\n');
  writeFileSync(join(root, 'node_modules/x/ignored.js'), 'const needle = "should not match";\n');
  service = new SearchService(root, []);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('file listing for quick open', () => {
  it('lists workspace files excluding default ignores', async () => {
    const files = await service.listFiles();
    expect(files).toContain('src/alpha.ts');
    expect(files).toContain('README.md');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });
});

describe('text search', () => {
  it('finds literal matches grouped by file with line/column data', async () => {
    const result = await service.textSearch({
      query: 'needle',
      isRegex: false,
      caseSensitive: true,
      wholeWord: false,
      maxResults: 100,
    });
    const paths = result.groups.map((g) => g.path).sort();
    expect(paths).toEqual(['README.md', 'src/alpha.ts', 'src/beta.ts']);
    const alpha = result.groups.find((g) => g.path === 'src/alpha.ts')!;
    expect(alpha.matches[0]!.line).toBe(2);
    expect(alpha.matches[0]!.previewText).toContain('needle');
    expect(result.truncated).toBe(false);
  });

  it('supports case sensitivity, whole word and regex', async () => {
    const insensitive = await service.textSearch({
      query: 'needle',
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      maxResults: 100,
    });
    const total = insensitive.groups.reduce((n, g) => n + g.matches.length, 0);
    expect(total).toBeGreaterThanOrEqual(4); // includes Needle

    const word = await service.textSearch({
      query: 'needle',
      isRegex: false,
      caseSensitive: true,
      wholeWord: true,
      maxResults: 100,
    });
    const wordPaths = word.groups.map((g) => g.path);
    expect(wordPaths).not.toContain('src/beta.ts'); // needleFactory is not a word match

    const regex = await service.textSearch({
      query: 'needle(Factory)?',
      isRegex: true,
      caseSensitive: true,
      wholeWord: false,
      maxResults: 100,
    });
    expect(regex.groups.some((g) => g.path === 'src/beta.ts')).toBe(true);
  });

  it('honors include globs and maxResults truncation', async () => {
    const onlySrc = await service.textSearch({
      query: 'needle',
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      includeGlob: 'src/**',
      maxResults: 100,
    });
    expect(onlySrc.groups.every((g) => g.path.startsWith('src/'))).toBe(true);

    const truncated = await service.textSearch({
      query: 'needle',
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      maxResults: 1,
    });
    expect(truncated.truncated).toBe(true);
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await service.textSearch(
      { query: 'needle', isRegex: false, caseSensitive: false, wholeWord: false, maxResults: 10 },
      controller.signal,
    );
    expect(result.cancelled).toBe(true);
  });
});

describe('replace with version verification (SRCH-004)', () => {
  it('applies replacements only when the file hash still matches', async () => {
    const search = await service.textSearch({
      query: 'needle',
      isRegex: false,
      caseSensitive: true,
      wholeWord: false,
      maxResults: 100,
    });
    const alpha = search.groups.find((g) => g.path === 'src/alpha.ts')!;

    // Tamper with beta.ts after the search snapshot.
    const beta = search.groups.find((g) => g.path === 'src/beta.ts')!;
    writeFileSync(join(root, 'src/beta.ts'), 'completely different now\n');

    const outcome = await service.applyReplacements([
      {
        path: 'src/alpha.ts',
        expectedHash: alpha.contentHash,
        edits: alpha.matches.map((m) => ({
          start: m.absoluteStart,
          end: m.absoluteEnd,
          text: 'thread',
        })),
      },
      {
        path: 'src/beta.ts',
        expectedHash: beta.contentHash,
        edits: beta.matches.map((m) => ({
          start: m.absoluteStart,
          end: m.absoluteEnd,
          text: 'thread',
        })),
      },
    ]);

    expect(outcome.find((o) => o.path === 'src/alpha.ts')!.status).toBe('applied');
    expect(outcome.find((o) => o.path === 'src/beta.ts')!.status).toBe('stale');
    expect(readFileSync(join(root, 'src/alpha.ts'), 'utf8')).toContain('const thread = "alpha"');
    expect(readFileSync(join(root, 'src/beta.ts'), 'utf8')).toBe('completely different now\n');
  });
});
