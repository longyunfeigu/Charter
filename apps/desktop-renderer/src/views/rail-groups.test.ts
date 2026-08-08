import { describe, expect, it } from 'vitest';
import type { TaskDto } from '@pi-ide/ipc-contracts';
import {
  HISTORY_PERIOD_INITIAL_LIMIT,
  buildRailGroups,
  buildHistoryPeriods,
  historyPeriodKey,
  missionSessionStatus,
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

function taskEntry(id: string, updatedAt: number): Extract<SessionEntry, { kind: 'task' }> {
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

describe('SSH workspace identity', () => {
  it('groups a server-owned Session by its canonical SSH folder, never its private mirror', () => {
    const entry = taskEntry('remote', daysAgo(0));
    entry.task = {
      ...entry.task,
      state: 'IN_PROGRESS',
      archived: false,
      projectName: 'rws_6306b288f84c4ccd',
      projectPath: '/Users/edy/Library/Application Support/Charter/remote-mirrors/rws_6306',
      external: {
        cli: 'claude',
        terminalId: 'term-remote',
        cwd: '/root/wanhua/charter-test',
        snapshotRef: null,
        status: 'active',
        sessionId: null,
        remote: {
          hostId: 'host-1',
          hostLabel: '10.0.3.46',
          root: '/root/wanhua/charter-test',
          workerSessionId: 'rws_6306b288f84c4ccd',
          workerVersion: '1.2.0',
          workspaceKind: 'remote',
        },
      },
    } as TaskDto;

    expect(buildRailGroups([entry])).toMatchObject([
      {
        name: '10.0.3.46 · charter-test',
        path: '/root/wanhua/charter-test',
        remote: true,
      },
    ]);
    expect(buildRailGroups([entry])[0]?.name).not.toContain('rws_');
  });

  it('keeps a local-owned SSH Session grouped under the canonical local project', () => {
    const entry = taskEntry('local-remote', daysAgo(0));
    entry.task = {
      ...entry.task,
      state: 'IN_PROGRESS',
      archived: false,
      projectName: 'my-local-app',
      projectPath: '/Users/edy/git/my-local-app',
      external: {
        cli: 'claude',
        terminalId: 'term-local-remote',
        cwd: '/home/edy/.charter/workspaces/rws_internal',
        snapshotRef: null,
        status: 'active',
        sessionId: null,
        remote: {
          hostId: 'host-1',
          hostLabel: 'server',
          root: '/home/edy/.charter/workspaces/rws_internal',
          workerSessionId: 'rws_internal',
          workerVersion: '1.2.0',
          workspaceKind: 'local',
        },
      },
    } as TaskDto;

    expect(buildRailGroups([entry])).toMatchObject([
      {
        name: 'my-local-app',
        path: '/Users/edy/git/my-local-app',
      },
    ]);
    expect(buildRailGroups([entry])[0]?.remote).toBeUndefined();
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
      taskState: 'RUNNING',
      waitingFor: [],
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
        taskState: 'RUNNING',
        waitingFor: [],
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
    ).toEqual([
      root.key,
      child.key,
      grandchild.key,
      'task:other-1',
      'task:other-2',
      'task:other-3',
    ]);
  });
});

describe('Mission Session status', () => {
  it('does not treat an open Assignment as proof of live Agent activity', () => {
    expect(
      missionSessionStatus({
        missionId: 'mission-1',
        assignmentId: 'assignment-active',
        parentKey: null,
        depth: 0,
        agentName: 'Claude Code',
        taskTitle: 'Review the implementation',
        provider: 'claude',
        assignmentState: 'ACTIVE',
        taskState: 'RUNNING',
        waitingFor: [],
        missionState: 'RUNNING',
        runtimeSessionId: 'terminal:terminal-1',
        terminalId: 'terminal-1',
        transport: 'terminal',
      }),
    ).toMatchObject({ label: 'Active', live: true, working: false });
  });

  it('distinguishes dependency waiting from a runnable queue', () => {
    const base = {
      missionId: 'mission-1',
      assignmentId: 'assignment-b',
      parentKey: null,
      depth: 1,
      agentName: 'Reviewer B',
      taskTitle: 'Review the implementation',
      provider: 'claude',
      assignmentState: 'PENDING' as const,
      missionState: 'RUNNING' as const,
      runtimeSessionId: null,
      terminalId: null,
      transport: null,
    };

    expect(
      missionSessionStatus({
        ...base,
        taskState: 'BLOCKED',
        waitingFor: ['Implement the feature'],
      }),
    ).toMatchObject({ label: 'Waiting', working: false });
    expect(missionSessionStatus({ ...base, taskState: 'READY', waitingFor: [] })).toMatchObject({
      label: 'Queued',
      working: false,
    });
  });
});
