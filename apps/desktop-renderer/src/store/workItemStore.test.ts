import { describe, expect, it } from 'vitest';
import type { WorkBoardSnapshotDto, WorkItemDto } from '@pi-ide/ipc-contracts';
import { workAttentionCount } from './workItemStore.js';

const now = Date.parse('2026-08-08T09:00:00.000Z');

function item(id: string, columnId: string, dueAt: string | null = null): WorkItemDto {
  return {
    id,
    typeId: 'general',
    columnId,
    title: id,
    descriptionMd: '',
    backgroundMd: '',
    sourcePerson: '',
    sourceChannel: '',
    sourceUrl: '',
    assignee: '',
    priority: 'none',
    labels: [],
    startAt: null,
    dueAt,
    acceptance: [],
    deliverables: [],
    customFields: {},
    position: 1,
    archived: false,
    version: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    completedAt: null,
  };
}

describe('workAttentionCount', () => {
  it('counts overdue, waiting, review and fired reminders once per work item', () => {
    const snapshot: WorkBoardSnapshotDto = {
      columns: [
        {
          id: 'active',
          name: 'Active',
          category: 'active',
          color: '#000',
          position: 1,
          wipLimit: null,
          archived: false,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'waiting',
          name: 'Waiting',
          category: 'waiting',
          color: '#000',
          position: 2,
          wipLimit: null,
          archived: false,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'review',
          name: 'Review',
          category: 'review',
          color: '#000',
          position: 3,
          wipLimit: null,
          archived: false,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'done',
          name: 'Done',
          category: 'completed',
          color: '#000',
          position: 4,
          wipLimit: null,
          archived: false,
          createdAt: '',
          updatedAt: '',
        },
      ],
      types: [],
      items: [
        item('overdue', 'active', '2026-08-08T08:59:00.000Z'),
        item('waiting', 'waiting'),
        item('review', 'review'),
        item('reminded', 'active'),
        item('done', 'done', '2026-08-01T00:00:00.000Z'),
      ],
      executions: [],
      reminders: [
        {
          id: 'r1',
          workItemId: 'reminded',
          remindAt: '2026-08-08T08:00:00.000Z',
          state: 'fired',
          message: '',
          firedAt: '2026-08-08T08:00:00.000Z',
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'r2',
          workItemId: 'overdue',
          remindAt: '2026-08-08T08:00:00.000Z',
          state: 'fired',
          message: '',
          firedAt: '2026-08-08T08:00:00.000Z',
          createdAt: '',
          updatedAt: '',
        },
      ],
    };
    expect(workAttentionCount(snapshot, now)).toBe(4);
  });
});
