import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * `npm run test:perf` (§16.5, M11-03) — the algorithmic performance harness:
 * tree scan / Quick Open / global search first-batch / Timeline projection at
 * the §16.5 reference load (50k files, large text, 10k events).
 *
 * Kept OUT of the default `npm test` because the fixtures are heavy (tens of
 * thousands of real files, big text blobs). Single-threaded + no isolation so
 * timings are not distorted by worker contention. The full §16.5 reference
 * sizes (50k / 1 GB) run when PI_IDE_PERF_FULL=1; the default sizes are large
 * enough to catch algorithmic regressions without a minute-long write phase.
 */
export default defineConfig({
  resolve: base.resolve,
  test: {
    include: ['tests/perf/**/*.perf.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
