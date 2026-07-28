import { describe, expect, it } from 'vitest';
import {
  completionDisposition,
  projectHistoricalOrchestrationFleet,
  unresolvedFailedWriteCount,
} from './task-service.js';

describe('completionDisposition', () => {
  it('never classifies an unreconciled successful write as a chat-only answer', () => {
    expect(
      completionDisposition({
        projectedChangedFiles: 0,
        successfulWrite: true,
        failedWrite: false,
        diskChangedFiles: null,
      }),
    ).toBe('review');
  });

  it('allows a durable write sequence that is proven net-zero to settle as answered', () => {
    expect(
      completionDisposition({
        projectedChangedFiles: 0,
        successfulWrite: true,
        failedWrite: false,
        diskChangedFiles: 0,
      }),
    ).toBe('answered');
  });

  it('requires review when either projection contains net changes', () => {
    expect(
      completionDisposition({
        projectedChangedFiles: 1,
        successfulWrite: false,
        failedWrite: false,
        diskChangedFiles: null,
      }),
    ).toBe('review');
    expect(
      completionDisposition({
        projectedChangedFiles: 0,
        successfulWrite: true,
        failedWrite: false,
        diskChangedFiles: 1,
      }),
    ).toBe('review');
  });

  it('fails a write turn with no durable changes and reviews any partial side effects', () => {
    expect(
      completionDisposition({
        projectedChangedFiles: 0,
        successfulWrite: false,
        failedWrite: true,
        diskChangedFiles: 0,
      }),
    ).toBe('failed');
    expect(
      completionDisposition({
        projectedChangedFiles: 2,
        successfulWrite: false,
        failedWrite: true,
        diskChangedFiles: 2,
      }),
    ).toBe('review');
  });
});

describe('unresolvedFailedWriteCount', () => {
  it('treats a later successful write to the same path as a recovered retry', () => {
    expect(
      unresolvedFailedWriteCount([
        { name: 'apply_patch', state: 'FAILED', inputJson: '{"path":"src/index.ts"}' },
        { name: 'apply_patch', state: 'SUCCEEDED', inputJson: '{"path":"src/index.ts"}' },
      ]),
    ).toBe(0);
  });

  it('keeps a failed target unresolved when only a different file later succeeds', () => {
    expect(
      unresolvedFailedWriteCount([
        { name: 'apply_patch', state: 'FAILED', inputJson: '{"path":"src/index.ts"}' },
        { name: 'create_file', state: 'SUCCEEDED', inputJson: '{"path":"src/other.ts"}' },
      ]),
    ).toBe(1);
  });
});

describe('projectHistoricalOrchestrationFleet', () => {
  it('recovers legacy worker tasks by terminal id and excludes explicitly killed workers', () => {
    const workers = projectHistoricalOrchestrationFleet(
      [
        {
          type: 'orchestration.workerCreated',
          payload: { terminalId: 'term_agent', launch: 'claude' },
        },
        {
          type: 'orchestration.workerCreated',
          payload: { terminalId: 'term_shell', launch: 'shell', root: '/repo/tools' },
        },
        {
          type: 'orchestration.workerKilled',
          payload: { terminalId: 'term_shell' },
        },
      ],
      [
        {
          taskId: 'worker_task',
          title: 'API worker',
          projectPath: '/repo',
          external: {
            cli: 'claude',
            terminalId: 'term_agent',
            cwd: '/repo/packages/api',
            snapshotRef: null,
            status: 'ended',
          },
        },
      ],
      '/repo',
    );

    expect(workers).toEqual([
      {
        terminalId: 'term_agent',
        workerTaskId: 'worker_task',
        launch: 'claude',
        root: '/repo/packages/api',
        projectPath: '/repo',
        title: 'API worker',
      },
    ]);
  });

  it('prefers an explicit worker binding when a terminal has several historical tasks', () => {
    const workers = projectHistoricalOrchestrationFleet(
      [
        {
          type: 'orchestration.workerCreated',
          payload: {
            terminalId: 'term_1',
            workerTaskId: 'worker_original',
            launch: 'codex',
            root: '/repo',
            title: 'Codex worker',
          },
        },
        {
          type: 'orchestration.workerBound',
          payload: { terminalId: 'term_1', workerTaskId: 'worker_latest' },
        },
      ],
      [
        {
          taskId: 'worker_latest',
          title: 'Latest worker task',
          projectPath: '/repo',
          external: {
            cli: 'codex',
            terminalId: 'term_after_independent_resume',
            cwd: '/repo/packages/web',
            snapshotRef: null,
            status: 'ended',
          },
        },
      ],
      '/fallback',
    );

    expect(workers[0]).toMatchObject({
      workerTaskId: 'worker_latest',
      root: '/repo',
      projectPath: '/repo',
    });
  });
});
