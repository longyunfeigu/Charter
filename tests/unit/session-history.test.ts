import { describe, expect, it } from 'vitest';
import { canResumeExternal, isHistoryTask } from '../../apps/desktop-renderer/src/views/labels.js';

/**
 * Rail History membership + resume affordance for external CLI sessions:
 * History = the session is over AND nothing needs a decision; a live process
 * never lands there, and settled rounds stay resumable (as a new task).
 */

function external(
  state: string,
  status: 'active' | 'ended',
  changedFiles: number | null = null,
  cli = 'claude',
) {
  return { state, changedFiles, external: { cli, status } };
}

describe('isHistoryTask', () => {
  it('keeps the ADR-0023 rule for managed tasks: settled states only', () => {
    expect(isHistoryTask({ state: 'ACCEPTED', changedFiles: 3 })).toBe(true);
    expect(isHistoryTask({ state: 'ROLLED_BACK', changedFiles: 3 })).toBe(true);
    expect(isHistoryTask({ state: 'CANCELLED', changedFiles: null })).toBe(true);
    expect(isHistoryTask({ state: 'REVIEW_READY', changedFiles: 3 })).toBe(false);
    expect(isHistoryTask({ state: 'IN_PROGRESS', changedFiles: null })).toBe(false);
    // Answered managed tasks stay in their project group (unchanged behavior).
    expect(isHistoryTask({ state: 'REVIEW_READY', changedFiles: 0 })).toBe(false);
  });

  it('sends ended external sessions with nothing to decide into History', () => {
    // Exited with no file changes — the "Ended" row that used to pile up.
    expect(isHistoryTask(external('REVIEW_READY', 'ended', 0))).toBe(true);
    // Reviewed and settled after exit.
    expect(isHistoryTask(external('ACCEPTED', 'ended', 2))).toBe(true);
    expect(isHistoryTask(external('ROLLED_BACK', 'ended', 2))).toBe(true);
  });

  it('never hides an ended session that still wants a decision', () => {
    expect(isHistoryTask(external('REVIEW_READY', 'ended', 4))).toBe(false);
    expect(isHistoryTask(external('FAILED', 'ended', 1))).toBe(false);
    expect(isHistoryTask(external('INTERRUPTED', 'ended', 0))).toBe(false);
  });

  it('never sends a live external process into History, whatever the state', () => {
    expect(isHistoryTask(external('READY', 'active'))).toBe(false);
    expect(isHistoryTask(external('REVIEW_READY', 'active', 0))).toBe(false);
    expect(isHistoryTask(external('ACCEPTED', 'active', 2))).toBe(false);
  });
});

describe('canResumeExternal', () => {
  it('offers resume for ended Agent sessions across review and settled states', () => {
    expect(canResumeExternal(external('REVIEW_READY', 'ended', 0))).toBe(true);
    expect(canResumeExternal(external('ACCEPTED', 'ended', 2))).toBe(true);
    expect(canResumeExternal(external('ROLLED_BACK', 'ended', 2, 'codex'))).toBe(true);
    expect(canResumeExternal(external('INTERRUPTED', 'ended', 0))).toBe(true);
    expect(canResumeExternal(external('FAILED', 'ended', 1))).toBe(true);
    expect(canResumeExternal(external('REVIEW_READY', 'ended', 0, 'kimi'))).toBe(true);
  });

  it('hides resume while the session is alive or no external session exists', () => {
    expect(canResumeExternal(external('REVIEW_READY', 'active', 0))).toBe(false);
    expect(canResumeExternal({ state: 'ACCEPTED', changedFiles: 2, external: null })).toBe(false);
    // A stub that never left READY has no conversation worth reviving.
    expect(canResumeExternal(external('READY', 'ended'))).toBe(false);
  });
});
