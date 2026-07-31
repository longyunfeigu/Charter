import { describe, expect, it } from 'vitest';
import type { TaskDto } from '@pi-ide/ipc-contracts';
import {
  HISTORY_PERIOD_INITIAL_LIMIT,
  buildHistoryPeriods,
  historyPeriodKey,
  visibleHistoryPeriodEntries,
  visibleRailGroupEntries,
  type RailGroup,
  type SessionEntry,
} from './rail-groups.js';

const now = new Date(2026, 6, 28, 18, 0, 0).getTime();

function daysAgo(days: number, hour = 12): number {
  const value = new Date(now);
  value.setDate(value.getDate() - days);
  value.setHours(hour, 0, 0, 0);
  return value.getTime();
}

function taskEntry(id: string, updatedAt: number): SessionEntry {
  return {
    key: `task:${id}`,
    kind: 'task',
    task: { id, updatedAt: new Date(updatedAt).toISOString() } as TaskDto,
  };
}

describe('History periods', () => {
  it('uses mutually exclusive local-calendar ranges', () => {
    expect(historyPeriodKey(daysAgo(0), now)).toBe('today');
    expect(historyPeriodKey(daysAgo(1), now)).toBe('yesterday');
    expect(historyPeriodKey(daysAgo(2), now)).toBe('previous-7-days');
    expect(historyPeriodKey(daysAgo(7), now)).toBe('previous-7-days');
    expect(historyPeriodKey(daysAgo(8), now)).toBe('previous-30-days');
    expect(historyPeriodKey(daysAgo(30), now)).toBe('previous-30-days');
    expect(historyPeriodKey(daysAgo(31), now)).toBe('older');
  });

  it('orders periods and their entries from newest to oldest', () => {
    const periods = buildHistoryPeriods(
      [
        taskEntry('older', daysAgo(45)),
        taskEntry('today-morning', daysAgo(0, 9)),
        taskEntry('month', daysAgo(12)),
        taskEntry('week', daysAgo(3)),
        taskEntry('yesterday', daysAgo(1)),
        taskEntry('today-afternoon', daysAgo(0, 15)),
      ],
      now,
    );

    expect(periods.map((period) => period.key)).toEqual([
      'today',
      'yesterday',
      'previous-7-days',
      'previous-30-days',
      'older',
    ]);
    expect(periods[0]?.entries.map((entry) => entry.key)).toEqual([
      'task:today-afternoon',
      'task:today-morning',
    ]);
  });

  it('shows five entries initially and bypasses pagination while filtering', () => {
    const period = buildHistoryPeriods(
      Array.from({ length: 12 }, (_, index) => taskEntry(`month-${index}`, daysAgo(12, index))),
      now,
    )[0]!;

    expect(
      visibleHistoryPeriodEntries(period, {
        limit: HISTORY_PERIOD_INITIAL_LIMIT,
        filtering: false,
      }),
    ).toHaveLength(5);
    expect(
      visibleHistoryPeriodEntries(period, {
        limit: HISTORY_PERIOD_INITIAL_LIMIT,
        filtering: true,
      }),
    ).toHaveLength(12);
  });
});

describe('Mission hierarchy pagination', () => {
  it('keeps descendants visible when their root is within the compact limit', () => {
    const root = taskEntry('root', daysAgo(0));
    root.mission = {
      missionId: 'mission-1',
      assignmentId: 'assignment-a',
      parentKey: null,
      depth: 0,
      agentName: 'Lead A',
      taskTitle: 'Lead work',
      provider: 'codex',
      assignmentState: 'ACTIVE',
      missionState: 'RUNNING',
      runtimeSessionId: 'runtime-a',
      terminalId: null,
      transport: 'acp',
    };
    const child: SessionEntry = {
      key: 'mission:mission-1:assignment-b',
      kind: 'mission',
      projectName: 'Project',
      projectPath: '/tmp/project',
      updatedAt: new Date(daysAgo(0)).toISOString(),
      mission: {
        missionId: 'mission-1',
        assignmentId: 'assignment-b',
        parentKey: root.key,
        depth: 1,
        agentName: 'Agent B',
        taskTitle: 'Build the feature',
        provider: 'codex',
        assignmentState: 'ACTIVE',
        missionState: 'RUNNING',
        runtimeSessionId: 'runtime-b',
        terminalId: 'acp:attempt-b',
        transport: 'acp',
      },
    };
    const grandchild: SessionEntry = {
      ...child,
      key: 'mission:mission-1:assignment-d',
      mission: {
        ...child.mission,
        assignmentId: 'assignment-d',
        parentKey: child.key,
        depth: 2,
        agentName: 'Agent D',
      },
    };
    const group: RailGroup = {
      key: 'proj:Project',
      name: 'Project',
      path: '/tmp/project',
      entries: [
        root,
        child,
        grandchild,
        taskEntry('other-1', daysAgo(0)),
        taskEntry('other-2', daysAgo(0)),
        taskEntry('other-3', daysAgo(0)),
      ],
      needs: 0,
    };

    expect(
      visibleRailGroupEntries(group, { expanded: false, filtering: false }).map(
        (entry) => entry.key,
      ),
    ).toEqual([root.key, child.key, grandchild.key, 'task:other-1', 'task:other-2']);
  });
});
