import { describe, expect, it } from 'vitest';
import type { DiscoveredSessionDto, TaskDto } from '@pi-ide/ipc-contracts';
import {
  bucketSessionHistory,
  sessionHistoryItems,
  sessionHistoryMatches,
} from './session-history.js';

function task(id: string, updatedAt: string, projectPath = '/repo'): TaskDto {
  return {
    id,
    workspaceId: 'workspace-1',
    title: `Task ${id}`,
    goalMd: `Goal ${id}`,
    acceptance: [],
    projectName: 'repo',
    projectPath,
    state: 'ACCEPTED',
    mode: 'edit',
    model: { providerId: 'mock', modelId: 'mock-1' },
    verification: [],
    createdAt: updatedAt,
    updatedAt,
    archived: false,
    gitBaseline: null,
    worktree: null,
    external: null,
    changedFiles: 0,
  };
}

function discovered(partial: Partial<DiscoveredSessionDto> = {}): DiscoveredSessionDto {
  return {
    cli: 'claude',
    sessionId: '6f3a92c1-0000-4000-8000-000000000001',
    cwd: '/repo',
    projectPath: '/repo',
    attribution: 'cwd',
    title: 'Recovered RSS work',
    startedAt: '2026-07-20T09:00:00.000Z',
    endedAt: '2026-07-20T10:00:00.000Z',
    filesTouched: ['feed.xml'],
    skills: ['web-access'],
    turnCount: 2,
    trackedTaskId: null,
    ...partial,
  };
}

describe('sessionHistoryItems', () => {
  it('merges tracked and discovered sessions without duplicating linked transcripts', () => {
    const items = sessionHistoryItems(
      [task('tracked', '2026-07-21T09:00:00.000Z')],
      [
        discovered({ trackedTaskId: 'tracked' }),
        discovered({ sessionId: '6f3a92c1-0000-4000-8000-000000000002' }),
      ],
      '/repo',
    );
    expect(items.map((item) => item.key)).toEqual([
      'task:tracked',
      'discovered:claude:6f3a92c1-0000-4000-8000-000000000002',
    ]);
  });

  it('searches task goals plus discovered files and skills', () => {
    const items = sessionHistoryItems(
      [task('login', '2026-07-21T09:00:00.000Z')],
      [discovered()],
      null,
    );
    expect(items.filter((item) => sessionHistoryMatches(item, 'Goal login'))).toHaveLength(1);
    expect(items.filter((item) => sessionHistoryMatches(item, 'feed.xml'))).toHaveLength(1);
    expect(items.filter((item) => sessionHistoryMatches(item, 'web-access'))).toHaveLength(1);
  });

  it('groups the unified timeline by recall horizon', () => {
    const now = new Date(2026, 6, 21, 12).getTime();
    const items = sessionHistoryItems(
      [task('today', new Date(2026, 6, 21, 9).toISOString())],
      [discovered({ endedAt: new Date(2026, 6, 20, 9).toISOString() })],
      null,
    );
    expect(bucketSessionHistory(items, now).map((bucket) => bucket.key)).toEqual([
      'today',
      'yesterday',
    ]);
  });
});
