/**
 * Shared helpers for the §16.5 performance harness (M11-03).
 *
 * Two size regimes: the DEFAULT keeps `test:perf` runnable in seconds (large
 * enough to catch algorithmic regressions), and PI_IDE_PERF_FULL=1 scales the
 * fixtures to the spec's reference load (50k files, 1 GiB text). Every test
 * reports its measured numbers so the M11-06 gate report can quote them.
 */

export const PERF_FULL = process.env.PI_IDE_PERF_FULL === '1';

export const SIZES = {
  treeFiles: PERF_FULL ? 50_000 : 12_000,
  treeDirs: PERF_FULL ? 500 : 120,
  textBytes: PERF_FULL ? 1024 * 1024 * 1024 : 96 * 1024 * 1024,
  timelineEvents: 10_000,
};

/** Run `fn` `runs` times, return sorted-ascending elapsed ms plus percentiles. */
export function measure(runs: number, fn: () => void): { p50: number; p95: number; max: number } {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const pct = (p: number): number =>
    samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!;
  return { p50: pct(0.5), p95: pct(0.95), max: samples[samples.length - 1]! };
}

export async function measureAsync(
  runs: number,
  fn: () => Promise<void>,
): Promise<{ p50: number; p95: number; max: number }> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const pct = (p: number): number =>
    samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]!;
  return { p50: pct(0.5), p95: pct(0.95), max: samples[samples.length - 1]! };
}

export function report(name: string, stats: { p50: number; p95: number; max: number }): void {
  // eslint-disable-next-line no-console
  console.log(
    `[perf] ${name}: p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms${PERF_FULL ? ' (FULL)' : ''}`,
  );
}
