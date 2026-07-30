import { describe, expect, it } from 'vitest';
import type { TaskDto } from '@pi-ide/ipc-contracts';
import { dismissCurrentAttention, visibleAttentionTasks } from './attentionDismissals.js';

function task(id: string, state: TaskDto['state'], updatedAt = '2026-07-30T00:00:00Z'): TaskDto {
  return {
    id,
    state,
    updatedAt,
    archived: false,
    changedFiles: 1,
  } as TaskDto;
}

describe('attention dismissals', () => {
  it('clears current reminders without removing their sessions', () => {
    const review = task('review', 'REVIEW_READY');
    const waiting = task('waiting', 'AWAITING_USER');
    const tasks = [review, waiting, task('idle', 'IDLE')];
    const dismissals = dismissCurrentAttention(tasks, {});

    expect(tasks).toContain(review);
    expect(visibleAttentionTasks(tasks, dismissals)).toEqual([]);
  });

  it('shows a dismissed task again after it receives a new update', () => {
    const original = task('review', 'REVIEW_READY');
    const dismissals = dismissCurrentAttention([original], {});
    const updated = { ...original, updatedAt: '2026-07-30T01:00:00Z' };

    expect(visibleAttentionTasks([updated], dismissals)).toEqual([updated]);
  });
});
