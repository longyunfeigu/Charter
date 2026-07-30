import { describe, expect, it } from 'vitest';
import type { RecentWorkspaceDto } from '@pi-ide/ipc-contracts';
import { selectableRecentWorkspaces } from './recent-workspaces.js';

function workspace(path: string, exists: boolean): RecentWorkspaceDto {
  return {
    path,
    displayName: path.split('/').pop() ?? path,
    lastOpenedAt: '2026-07-30T00:00:00.000Z',
    pinned: false,
    exists,
    kind: null,
  };
}

describe('selectableRecentWorkspaces', () => {
  it('hides deleted project paths from the Session home picker', () => {
    const present = workspace('/Users/dev/git/present', true);
    const deleted = workspace('/Users/dev/git/deleted', false);

    expect(selectableRecentWorkspaces([deleted, present])).toEqual([present]);
  });
});
