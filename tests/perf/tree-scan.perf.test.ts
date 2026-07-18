import { afterAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { createLargeTreeFixture } from '@pi-ide/test-fixtures';
import { listDirectory } from '@pi-ide/workspace-service';
import { SearchService } from '@pi-ide/search-service';
import { SIZES, measureAsync, report } from './perf-lib';

/**
 * §16.5: at the 50k-file reference load, lazy tree listing stays fast (only two
 * directory levels are read, never the whole tree) and Quick Open's file list
 * returns its first batch quickly.
 */
describe('large workspace scan (§16.5)', () => {
  const root = createLargeTreeFixture({ files: SIZES.treeFiles, dirs: SIZES.treeDirs });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists a directory level lazily under 300ms p95', async () => {
    // warm
    await listDirectory(root, '', { showIgnored: false, extraIgnores: [] });
    const stats = await measureAsync(8, async () => {
      const rootEntries = await listDirectory(root, '', { showIgnored: false, extraIgnores: [] });
      const oneDir = await listDirectory(root, 'module-000', {
        showIgnored: false,
        extraIgnores: [],
      });
      expect(rootEntries.length).toBe(SIZES.treeDirs + 1); // dirs + package.json
      expect(oneDir.length).toBeGreaterThan(0);
    });
    report('tree lazy list (root + one dir)', stats);
    expect(stats.p95).toBeLessThan(300);
  });

  it('Quick Open file list first batch (2000) returns under 1s p95', async () => {
    const search = new SearchService(root, []);
    // warm rg / fallback path
    await search.listFiles(2000);
    const stats = await measureAsync(5, async () => {
      const files = await search.listFiles(2000);
      expect(files.length).toBeGreaterThan(0);
    });
    report('quick-open listFiles(2000)', stats);
    expect(stats.p95).toBeLessThan(1000);
  });
});
