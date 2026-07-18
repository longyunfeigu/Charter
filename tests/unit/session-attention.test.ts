import { describe, expect, it } from 'vitest';
import type { TaskDto } from '@pi-ide/ipc-contracts';
import {
  externalSessionReplyInfo,
  sessionCompletionInfo,
  sessionDisplayTitle,
} from '../../apps/desktop-renderer/src/store/sessionAttention.js';

function task(patch: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 'task-1',
    workspaceId: 'workspace-1',
    title: 'Refactor the parser',
    goalMd: 'Refactor the parser',
    acceptance: [],
    mode: 'edit',
    state: 'REVIEW_READY',
    model: { providerId: 'mock', modelId: 'mock-1' },
    verification: [],
    archived: false,
    createdAt: '2026-07-17T08:00:00.000Z',
    updatedAt: '2026-07-17T08:01:00.000Z',
    gitBaseline: null,
    projectName: 'charter',
    projectPath: '/tmp/charter',
    changedFiles: 2,
    worktree: null,
    external: null,
    ...patch,
  };
}

describe('sessionCompletionInfo', () => {
  it('uses the same clean display title as the Session rail', () => {
    expect(sessionDisplayTitle(task({ title: '[scenario:edit-basic] Refactor the parser' }))).toBe(
      'Refactor the parser',
    );
  });

  it('keeps external reply notices provider-specific and evidence-honest', () => {
    const claude = task({
      state: 'IN_PROGRESS',
      external: {
        cli: 'claude',
        terminalId: 'terminal-1',
        snapshotRef: null,
        status: 'active',
        sessionId: 'claude-session-1',
        captureGrade: 'observed',
      },
    });
    expect(externalSessionReplyInfo(claude, 'observed')).toEqual({
      label: 'Claude reply complete',
      body: 'Terminal output settled · Session is ready for you.',
      tone: 'success',
    });
    expect(
      externalSessionReplyInfo(
        {
          ...claude,
          external: { ...claude.external!, cli: 'codex', captureGrade: 'structured' },
        },
        'structured',
      ),
    ).toMatchObject({
      label: 'Codex reply complete',
      body: 'The latest reply finished · Session is ready for you.',
    });
    expect(externalSessionReplyInfo(claude, 'structured', 'error')).toMatchObject({
      label: 'Claude reply failed',
      tone: 'error',
    });
  });

  it('distinguishes an answer from a reviewable result using the live snapshot', () => {
    expect(sessionCompletionInfo(task({ changedFiles: 0 }))).toMatchObject({
      label: 'Answered',
      tone: 'success',
    });
    expect(sessionCompletionInfo(task({ changedFiles: 2 }))).toMatchObject({
      label: 'Ready for review',
      tone: 'review',
    });
  });

  it('announces full-auto only after apply, never at its mechanical review edge', () => {
    expect(sessionCompletionInfo(task({ mode: 'full', state: 'REVIEW_READY' }))).toBeNull();
    expect(sessionCompletionInfo(task({ mode: 'full', state: 'ACCEPTED' }))).toMatchObject({
      label: 'Completed & applied',
      tone: 'success',
    });
    expect(sessionCompletionInfo(task({ mode: 'edit', state: 'ACCEPTED' }))).toBeNull();
  });

  it('keeps failure and interruption actionable', () => {
    expect(sessionCompletionInfo(task({ state: 'FAILED' }))).toMatchObject({
      label: 'Failed',
      tone: 'error',
    });
    expect(sessionCompletionInfo(task({ state: 'INTERRUPTED' }))).toMatchObject({
      label: 'Interrupted',
      tone: 'warning',
    });
  });
});
