import { describe, expect, it } from 'vitest';
import { NotificationService } from './notification-service.js';

function harness(overrides: { enabled?: boolean; focused?: boolean } = {}) {
  const shown: Array<{ title: string; body: string }> = [];
  const focusedTasks: string[] = [];
  let lastClick: (() => void) | null = null;
  const service = new NotificationService({
    enabled: () => overrides.enabled ?? true,
    anyWindowFocused: () => overrides.focused ?? false,
    show: (n, onClick) => {
      shown.push(n);
      lastClick = onClick;
    },
    focusTask: (taskId) => focusedTasks.push(taskId),
  });
  return { service, shown, focusedTasks, click: () => lastClick?.() };
}

describe('NotificationService (PIVOT-014)', () => {
  it('notifies on attention states and routes clicks to the task', () => {
    const h = harness();
    h.service.onTaskState({ taskId: 't1', to: 'REVIEW_READY', title: 'Add rate limiting' });
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]).toEqual({
      title: 'Add rate limiting',
      body: 'The task finished and is ready for your review.',
    });
    h.click();
    expect(h.focusedTasks).toEqual(['t1']);
  });

  it('ADR-0009: a zero-change completion reads as an answer, not a review request', () => {
    const h = harness();
    h.service.onTaskState({ taskId: 't1', to: 'REVIEW_READY', title: 'hi', changedFiles: 0 });
    expect(h.shown[0]!.body).toBe('The agent answered — nothing changed on disk.');
    // With real changes the review copy stays.
    h.service.onTaskState({ taskId: 't2', to: 'REVIEW_READY', title: 'fix', changedFiles: 3 });
    expect(h.shown[1]!.body).toBe('The task finished and is ready for your review.');
  });

  it('fires once per edge, re-arms after leaving the state', () => {
    const h = harness();
    h.service.onTaskState({ taskId: 't1', to: 'AWAITING_PERMISSION', title: 'T' });
    h.service.onTaskState({ taskId: 't1', to: 'AWAITING_PERMISSION', title: 'T' });
    expect(h.shown).toHaveLength(1);
    h.service.onTaskState({ taskId: 't1', to: 'IN_PROGRESS', title: 'T' });
    h.service.onTaskState({ taskId: 't1', to: 'AWAITING_PERMISSION', title: 'T' });
    expect(h.shown).toHaveLength(2);
  });

  it('stays silent for non-attention states, when disabled, and when focused', () => {
    const quiet = harness();
    quiet.service.onTaskState({ taskId: 't1', to: 'IN_PROGRESS', title: 'T' });
    quiet.service.onTaskState({ taskId: 't1', to: 'ACCEPTED', title: 'T' });
    expect(quiet.shown).toHaveLength(0);

    const disabled = harness({ enabled: false });
    disabled.service.onTaskState({ taskId: 't1', to: 'FAILED', title: 'T' });
    expect(disabled.shown).toHaveLength(0);

    const watching = harness({ focused: true });
    watching.service.onTaskState({ taskId: 't1', to: 'FAILED', title: 'T' });
    expect(watching.shown).toHaveLength(0);
  });

  it('tracks tasks independently', () => {
    const h = harness();
    h.service.onTaskState({ taskId: 'a', to: 'REVIEW_READY', title: 'A' });
    h.service.onTaskState({ taskId: 'b', to: 'REVIEW_READY', title: 'B' });
    expect(h.shown.map((n) => n.title)).toEqual(['A', 'B']);
  });
});
