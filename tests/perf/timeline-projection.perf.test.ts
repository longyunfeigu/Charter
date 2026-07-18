import { describe, expect, it } from 'vitest';
import type { ActivityItem } from '@pi-ide/ipc-contracts';
import { projectReplay, type ReplayTaskContext } from '@pi-ide/ipc-contracts';
import { SIZES, measure, report } from './perf-lib';

/**
 * §16.5: a 10k-event Timeline projects fast enough to stay scrollable. This is
 * the pure projection cost (the renderer memoizes it per timeline change); the
 * RoomTimeline windowing that bounds the DOM is M11-04.
 */
function task(): ReplayTaskContext {
  return {
    id: 'task-1',
    goalMd: 'Large task',
    state: 'REVIEW_READY',
    createdAt: '2026-07-15T00:00:00.000Z',
    external: null,
  };
}

function buildItems(n: number): ActivityItem[] {
  const base = Date.parse('2026-07-15T00:00:00.000Z');
  const items: ActivityItem[] = [];
  for (let i = 0; i < n; i++) {
    const isWrite = i % 200 === 0;
    items.push({
      key: `evt-${i}`,
      taskId: 'task-1',
      sequence: i,
      at: new Date(base + i * 1000).toISOString(),
      kind: isWrite ? 'write' : i % 3 === 0 ? 'read' : 'command',
      label: 'event',
      status: 'ok',
      paths: [`src/f${i % 40}.ts`],
      author: 'agent',
      source: 'pi',
      captureGrade: 'full',
      ...(isWrite ? { changeIds: [`c${i}`] } : {}),
    });
  }
  return items;
}

describe('timeline projection at scale (§16.5)', () => {
  it('projects 10k events under 200ms p95', () => {
    const items = buildItems(SIZES.timelineEvents);
    // warm
    projectReplay({ task: task(), items });
    const stats = measure(6, () => {
      const { facts, session } = projectReplay({ task: task(), items });
      expect(facts.length).toBe(SIZES.timelineEvents);
      expect(session.chapters.length).toBeLessThanOrEqual(8);
    });
    report('projectReplay(10k)', stats);
    expect(stats.p95).toBeLessThan(200);
  });
});
