import { afterAll, describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import { rmSync } from 'node:fs';
import { createLargeTreeFixture, createLargeTextFixture } from '@pi-ide/test-fixtures';
import { SearchService } from '@pi-ide/search-service';
import { SIZES, measureAsync, report } from './perf-lib';

/**
 * §16.5: global search over a large corpus returns its first batch quickly and
 * is cancellable, through the real SearchService (ripgrep when present, JS
 * fallback otherwise). The corpus is the many-file tree fixture (every file
 * carries a searchable token); a separate oversized single file confirms the
 * per-file scan cap keeps search bounded rather than freezing.
 */
describe('global search first batch (§16.5)', () => {
  const root = createLargeTreeFixture({ files: SIZES.treeFiles, dirs: SIZES.treeDirs });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const opts = (query: string, maxResults: number) => ({
    query,
    isRegex: false,
    caseSensitive: false,
    wholeWord: false,
    maxResults,
  });

  it('first 200 matches return under 1s p95', async () => {
    const search = new SearchService(root, []);
    await search.textSearch(opts('searchable-token', 200)); // warm
    const stats = await measureAsync(4, async () => {
      const res = await search.textSearch(opts('searchable-token', 200));
      const total = res.groups.reduce((n, g) => n + g.matches.length, 0);
      expect(total).toBeGreaterThan(0);
    });
    report('global search first 200', stats);
    expect(stats.p95).toBeLessThan(1000);
  });

  it('a pre-aborted search returns cancelled immediately', async () => {
    const search = new SearchService(root, []);
    const ac = new AbortController();
    ac.abort();
    const started = performance.now();
    const res = await search.textSearch(opts('searchable-token', 100_000), ac.signal);
    const elapsed = performance.now() - started;
    report('search cancel (pre-aborted)', { p50: elapsed, p95: elapsed, max: elapsed });
    expect(res.cancelled).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });
});

/**
 * A single file above the per-file scan cap (4 MiB) is skipped rather than
 * scanned — so a 96 MiB / 1 GiB log never freezes search. Honest-boundary perf
 * assertion (§16.5 "large output cannot freeze the renderer").
 */
describe('oversized single file stays bounded (§16.5)', () => {
  const file = createLargeTextFixture({ sizeBytes: SIZES.textBytes, plantToken: 'NEEDLE_TOKEN' });
  const root = dirname(file);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('search over a directory holding one huge file returns fast', async () => {
    const search = new SearchService(root, []);
    const started = performance.now();
    const res = await search.textSearch({
      query: 'NEEDLE_TOKEN',
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      maxResults: 200,
    });
    const elapsed = performance.now() - started;
    report('search over oversized file', { p50: elapsed, p95: elapsed, max: elapsed });
    // The huge file is over the JS per-file cap; whether rg indexes it or not,
    // the call must return promptly and never hang.
    expect(elapsed).toBeLessThan(3000);
    expect(res.cancelled).toBe(false);
  });
});
