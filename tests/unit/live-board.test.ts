import { describe, expect, it } from 'vitest';
import {
  heatOf,
  heatScore,
  rhythmOf,
  tilesForTask,
  writesPerMinute,
  HEAT_WINDOW_MS,
} from '../../apps/desktop-renderer/src/views/live-board.js';
import type { ActivityPulse } from '../../apps/desktop-renderer/src/store/activityStore.js';

const NOW = 1_000_000_000;

function pulses(taskId: string, entries: Array<[string, number]>): ActivityPulse[] {
  return entries.map(([path, agoMs]) => ({ taskId, paths: [path], at: NOW - agoMs }));
}

describe('live board heat/decay (PIVOT-025)', () => {
  it('a fresh burst is hot; it cools as writes age out', () => {
    const burst = [NOW - 500, NOW - 1500, NOW - 2500];
    expect(heatOf(burst, NOW)).toBe('hot');
    // The same burst forty seconds later has decayed below hot.
    expect(heatOf(burst, NOW + 40_000)).not.toBe('hot');
    // Outside the window entirely → no score at all.
    expect(heatScore(burst, NOW + HEAT_WINDOW_MS + 3000)).toBe(0);
    expect(heatOf([], NOW)).toBe('cool');
  });

  it('one old write is cool, one fresh write is warm-or-hot', () => {
    expect(heatOf([NOW - 55_000], NOW)).toBe('cool');
    expect(['warm', 'hot']).toContain(heatOf([NOW - 1000], NOW));
  });

  it('rhythm buckets place old writes left and fresh writes right', () => {
    const rhythm = rhythmOf([NOW - 55_000, NOW - 1000, NOW - 2000], NOW);
    expect(rhythm).toHaveLength(6);
    expect(rhythm[0]).toBeGreaterThan(0); // ~55s ago → oldest bucket
    expect(rhythm[5]).toBe(1); // two fresh writes → hottest bucket, normalized
  });

  it('tilesForTask groups by file, sorts by recency, and scopes by task', () => {
    const all = [
      ...pulses('t1', [
        ['src/a.ts', 400],
        ['src/a.ts', 1400],
        ['src/b.ts', 30_000],
      ]),
      ...pulses('t2', [['src/other.ts', 100]]),
      // outside the window — ignored entirely
      ...pulses('t1', [['src/stale.ts', HEAT_WINDOW_MS + 5000]]),
    ];
    const tiles = tilesForTask(all, 't1', NOW);
    expect(tiles.map((t) => t.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(tiles[0]!.writing).toBe(true);
    expect(tiles[0]!.heat).not.toBe('cool');
    expect(tiles[1]!.writing).toBe(false);
    expect(writesPerMinute(all, 't1', NOW)).toBe(3);
  });
});
