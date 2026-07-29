import type { ActivityPulse } from '../store/activityStore.js';

/**
 * Live Board math (ADR-0008, PIVOT-025). Pure projections over recorded write
 * pulses — the same event stream that drives the presence glow. No polling.
 */

export type Heat = 'hot' | 'warm' | 'cool';

export interface TileStat {
  path: string;
  /** Write timestamps, oldest → newest (within the heat window). */
  writes: number[];
  heat: Heat;
  /** True while the most recent write is seconds-fresh (the beacon). */
  writing: boolean;
  /** 6 × 10s rhythm buckets, oldest → newest, normalized 0..1. */
  rhythm: number[];
  lastWriteAt: number;
  provenance: 'agent' | 'observed';
}

export const HEAT_WINDOW_MS = 60_000;
export const WRITING_MS = 3_000;
const DECAY_TAU_MS = 20_000;
const BUCKETS = 6;

/** Exponentially-decayed write score: recent bursts run hot, then cool off. */
export function heatScore(writes: number[], now: number): number {
  let score = 0;
  for (const at of writes) {
    const age = now - at;
    if (age < 0 || age > HEAT_WINDOW_MS) continue;
    score += Math.exp(-age / DECAY_TAU_MS);
  }
  return score;
}

export function heatOf(writes: number[], now: number): Heat {
  const score = heatScore(writes, now);
  if (score >= 1.35) return 'hot';
  if (score >= 0.3) return 'warm';
  return 'cool';
}

export function rhythmOf(writes: number[], now: number): number[] {
  const bucketMs = HEAT_WINDOW_MS / BUCKETS;
  const counts = new Array<number>(BUCKETS).fill(0);
  for (const at of writes) {
    const age = now - at;
    if (age < 0 || age >= HEAT_WINDOW_MS) continue;
    const idx = BUCKETS - 1 - Math.floor(age / bucketMs);
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  const max = Math.max(1, ...counts);
  return counts.map((c) => c / max);
}

/** Per-file tile stats for one task, hottest/most recent first. */
export function tilesForTask(pulses: ActivityPulse[], taskId: string, now: number): TileStat[] {
  const byPath = new Map<string, { writes: number[]; provenance: 'agent' | 'observed' }>();
  for (const pulse of pulses) {
    if (pulse.taskId !== taskId) continue;
    if (now - pulse.at > HEAT_WINDOW_MS) continue;
    for (const path of pulse.paths) {
      const entry = byPath.get(path) ?? {
        writes: [],
        provenance: pulse.provenance,
      };
      entry.writes.push(pulse.at);
      if (pulse.provenance === 'agent') entry.provenance = 'agent';
      byPath.set(path, entry);
    }
  }
  const tiles: TileStat[] = [];
  for (const [path, entry] of byPath) {
    const { writes, provenance } = entry;
    writes.sort((a, b) => a - b);
    const lastWriteAt = writes[writes.length - 1] ?? 0;
    tiles.push({
      path,
      writes,
      heat: heatOf(writes, now),
      writing: now - lastWriteAt <= WRITING_MS,
      rhythm: rhythmOf(writes, now),
      lastWriteAt,
      provenance,
    });
  }
  tiles.sort((a, b) => b.lastWriteAt - a.lastWriteAt);
  return tiles;
}

/** Aggregate writes/min over the heat window for a task. */
export function writesPerMinute(pulses: ActivityPulse[], taskId: string, now: number): number {
  let n = 0;
  for (const pulse of pulses) {
    if (pulse.taskId === taskId && now - pulse.at <= HEAT_WINDOW_MS) n += pulse.paths.length;
  }
  return n;
}
