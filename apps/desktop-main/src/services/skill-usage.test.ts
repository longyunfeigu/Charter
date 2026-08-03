import { describe, expect, it } from 'vitest';
import {
  aggregateSkillUsage,
  composeSkillUsage,
  joinExternalSkillEvents,
  usageWeekCount,
  type ConsumerSkillUsageEvent,
} from './skill-usage.js';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-07-20T12:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function charter(skill: string, at: string): ConsumerSkillUsageEvent {
  return { skill, at, consumer: 'charter' };
}

describe('aggregateSkillUsage (ADR-0037)', () => {
  it('counts events per skill inside the window and keeps the latest timestamp', () => {
    const events: ConsumerSkillUsageEvent[] = [
      charter('alpha', daysAgo(1)),
      charter('alpha', daysAgo(10)),
      charter('alpha', daysAgo(44)),
      charter('beta', daysAgo(2)),
    ];
    const out = aggregateSkillUsage(events, NOW, 45);
    expect(out.get('alpha')?.uses).toBe(3);
    expect(out.get('alpha')?.lastUsedAt).toBe(daysAgo(1));
    expect(out.get('beta')?.uses).toBe(1);
  });

  it('drops events outside the window and malformed timestamps', () => {
    const out = aggregateSkillUsage(
      [charter('alpha', daysAgo(46)), charter('alpha', 'not-a-date')],
      NOW,
      45,
    );
    expect(out.has('alpha')).toBe(false);
  });

  it('clamps small clock skew into the newest bucket instead of dropping it', () => {
    const out = aggregateSkillUsage([charter('alpha', daysAgo(-0.01))], NOW, 45);
    expect(out.get('alpha')?.uses).toBe(1);
    const weekly = out.get('alpha')!.weekly;
    expect(weekly[weekly.length - 1]).toBe(1);
  });

  it('buckets by week, oldest → newest', () => {
    const out = aggregateSkillUsage(
      [
        charter('alpha', daysAgo(0)), // newest bucket
        charter('alpha', daysAgo(8)), // one week back
        charter('alpha', daysAgo(44)), // oldest bucket
      ],
      NOW,
      45,
    );
    const weekly = out.get('alpha')!.weekly;
    expect(weekly).toHaveLength(usageWeekCount(45));
    expect(weekly[weekly.length - 1]).toBe(1);
    expect(weekly[weekly.length - 2]).toBe(1);
    expect(weekly[0]).toBe(1);
    expect(weekly.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('splits mixed consumers while the top level stays the merged view (ADR-0040)', () => {
    const out = aggregateSkillUsage(
      [
        charter('alpha', daysAgo(9)),
        { skill: 'alpha', at: daysAgo(1), consumer: 'claude' },
        { skill: 'alpha', at: daysAgo(2), consumer: 'claude' },
        { skill: 'alpha', at: daysAgo(3), consumer: 'codex' },
      ],
      NOW,
      45,
    );
    const alpha = out.get('alpha')!;
    expect(alpha.uses).toBe(4);
    expect(alpha.lastUsedAt).toBe(daysAgo(1));
    expect(alpha.byConsumer.charter.uses).toBe(1);
    expect(alpha.byConsumer.charter.lastUsedAt).toBe(daysAgo(9));
    expect(alpha.byConsumer.claude.uses).toBe(2);
    expect(alpha.byConsumer.claude.lastUsedAt).toBe(daysAgo(1));
    expect(alpha.byConsumer.codex.uses).toBe(1);
    expect(alpha.byConsumer.codex.lastUsedAt).toBe(daysAgo(3));
    // Every slice shares the merged bucket count, and slices sum to the merge.
    const weeks = usageWeekCount(45);
    for (const series of [
      alpha.byConsumer.charter,
      alpha.byConsumer.claude,
      alpha.byConsumer.codex,
    ]) {
      expect(series.weekly).toHaveLength(weeks);
    }
    for (let i = 0; i < weeks; i++) {
      expect(
        alpha.byConsumer.charter.weekly[i]! +
          alpha.byConsumer.claude.weekly[i]! +
          alpha.byConsumer.codex.weekly[i]!,
      ).toBe(alpha.weekly[i]);
    }
  });
});

describe('joinExternalSkillEvents (ADR-0040)', () => {
  const catalog = [
    { name: 'pdf', displayName: 'pdf', sourceId: 'agents' },
    { name: 'pdf@claude', displayName: 'pdf', sourceId: 'claude' },
    { name: 'baoyu-comic', displayName: 'Baoyu Comic', sourceId: 'claude' },
    { name: 'lonely', displayName: 'lonely', sourceId: 'agents' },
  ];

  it('slugifies raw names and prefers the copy from the same source', () => {
    const out = joinExternalSkillEvents(
      [{ skill: 'Baoyu Comic', at: daysAgo(1), consumer: 'claude' }],
      catalog,
    );
    expect(out).toEqual([{ skill: 'baoyu-comic', at: daysAgo(1), consumer: 'claude' }]);
  });

  it('lands conflict-qualified names on the source-owned copy', () => {
    const out = joinExternalSkillEvents(
      [{ skill: 'pdf', at: daysAgo(2), consumer: 'claude' }],
      catalog,
    );
    expect(out[0]?.skill).toBe('pdf@claude');
  });

  it('falls back to an exact runtime-name match when the source has no copy', () => {
    const out = joinExternalSkillEvents(
      [{ skill: 'lonely', at: daysAgo(3), consumer: 'claude' }],
      catalog,
    );
    expect(out[0]?.skill).toBe('lonely');
  });

  it('drops plugin-namespaced and non-catalog names', () => {
    const out = joinExternalSkillEvents(
      [
        { skill: 'compound-engineering:ce-commit', at: daysAgo(1), consumer: 'claude' },
        { skill: 'never-heard-of-it', at: daysAgo(1), consumer: 'claude' },
      ],
      catalog,
    );
    expect(out).toHaveLength(0);
  });
});

describe('composeSkillUsage (ADR-0037)', () => {
  it('joins every catalog skill with usage + token estimates, zero-filling gaps', () => {
    const usage = aggregateSkillUsage([charter('alpha', daysAgo(3))], NOW, 45);
    const rows = composeSkillUsage(
      [{ name: 'alpha' }, { name: 'idle' }],
      { bySkill: new Map([['alpha', 120]]) },
      usage,
      45,
    );
    expect(rows).toHaveLength(2);
    const alpha = rows.find((r) => r.name === 'alpha')!;
    expect(alpha.preambleTokens).toBe(120);
    expect(alpha.uses).toBe(1);
    expect(alpha.lastUsedAt).toBe(daysAgo(3));
    expect(alpha.byConsumer.charter.uses).toBe(1);
    expect(alpha.byConsumer.claude.uses).toBe(0);
    const idle = rows.find((r) => r.name === 'idle')!;
    expect(idle.preambleTokens).toBe(0);
    expect(idle.uses).toBe(0);
    expect(idle.lastUsedAt).toBeNull();
    expect(idle.weekly).toHaveLength(usageWeekCount(45));
    expect(idle.weekly.every((n) => n === 0)).toBe(true);
    // v2 rows always carry a fully zero-filled per-consumer split.
    for (const consumer of ['charter', 'claude', 'codex'] as const) {
      expect(idle.byConsumer[consumer].uses).toBe(0);
      expect(idle.byConsumer[consumer].lastUsedAt).toBeNull();
      expect(idle.byConsumer[consumer].weekly).toHaveLength(usageWeekCount(45));
    }
  });

  it('drops usage rows whose skill left the catalog', () => {
    const usage = aggregateSkillUsage([charter('ghost', daysAgo(1))], NOW, 45);
    const rows = composeSkillUsage([{ name: 'alpha' }], { bySkill: new Map() }, usage, 45);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('alpha');
  });
});
