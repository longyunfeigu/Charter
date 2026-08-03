import { describe, expect, it } from 'vitest';
import type { ChangeSet } from '@pi-ide/change-service';
import {
  completionDisposition,
  mergeReviewChangeSets,
  projectHistoricalOrchestrationFleet,
  projectHistoricalOrchestrationTaskIds,
  TaskService,
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

describe('commander review projection', () => {
  it('keeps every bound worker in the delivered result after the worker exits', () => {
    expect(
      projectHistoricalOrchestrationTaskIds([
        {
          type: 'orchestration.workerCreated',
          payload: { terminalId: 'term_1', workerTaskId: 'worker_a' },
        },
        {
          type: 'orchestration.workerBound',
          payload: { terminalId: 'term_1', workerTaskId: 'worker_a' },
        },
        {
          type: 'orchestration.workerKilled',
          payload: { terminalId: 'term_1', workerTaskId: 'worker_a' },
        },
        {
          type: 'orchestration.workerBound',
          payload: { terminalId: 'term_2', workerTaskId: 'worker_b' },
        },
      ]),
    ).toEqual(['worker_a', 'worker_b']);
  });

  it('deduplicates paths and uses the task that owns the earliest baseline', () => {
    const changeSet = (
      taskId: string,
      files: Array<{ path: string; additions: number; currentHash: string }>,
    ): ChangeSet => ({
      taskId,
      files: files.map((file) => ({
        path: file.path,
        status: 'created',
        renamedFrom: null,
        binary: false,
        diff: `--- ${file.path}\n+++ ${file.path}\n+added`,
        additions: file.additions,
        deletions: 0,
        baselineHash: null,
        currentHash: file.currentHash,
      })),
      totalAdditions: files.reduce((total, file) => total + file.additions, 0),
      totalDeletions: 0,
    });
    const merged = mergeReviewChangeSets(
      'commander',
      [
        changeSet('commander', [
          { path: 'app.js', additions: 10, currentHash: 'app-final' },
          { path: 'shared.js', additions: 2, currentHash: 'shared-final' },
        ]),
        changeSet('worker', [
          { path: 'core.js', additions: 20, currentHash: 'core-final' },
          { path: 'shared.js', additions: 8, currentHash: 'shared-final' },
        ]),
      ],
      new Map([
        ['app.js', 'commander'],
        ['core.js', 'worker'],
        ['shared.js', 'worker'],
      ]),
    );

    expect(merged.files.map((file) => [file.path, file.additions])).toEqual([
      ['app.js', 10],
      ['core.js', 20],
      ['shared.js', 8],
    ]);
    expect(merged.totalAdditions).toBe(38);
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

describe('TaskService.liveOrchestrationWorkers', () => {
  it('keeps the most recently assigned live parent-child edge after restart', () => {
    const taskRows = [
      {
        task: {
          id: 'commander_old',
          projectPath: '/repo',
          external: {
            cli: 'claude',
            terminalId: 'commander_terminal_old',
            cwd: '/repo',
            snapshotRef: null,
            status: 'ended',
          },
        },
      },
      {
        task: {
          id: 'commander_new',
          projectPath: '/repo',
          external: {
            cli: 'claude',
            terminalId: 'commander_terminal_new',
            cwd: '/repo',
            snapshotRef: null,
            status: 'active',
          },
        },
      },
      {
        task: {
          id: 'worker_latest',
          title: 'Latest Codex review',
          projectPath: '/repo',
          external: {
            cli: 'codex',
            terminalId: 'term_after_resume',
            cwd: '/repo/packages/api',
            snapshotRef: null,
            status: 'active',
          },
        },
      },
    ];
    const eventRows = [
      {
        rowid: 1,
        task_id: 'commander_old',
        type: 'orchestration.workerCreated',
        payload_json: JSON.stringify({
          terminalId: 'term_worker',
          launch: 'codex',
          root: '/repo/packages/api',
          commanderTerminalId: 'commander_terminal_old',
        }),
      },
      {
        rowid: 2,
        task_id: 'commander_old',
        type: 'orchestration.workerBound',
        payload_json: JSON.stringify({ terminalId: 'term_worker', workerTaskId: 'worker_old' }),
      },
      {
        rowid: 3,
        task_id: 'commander_new',
        type: 'orchestration.workerCreated',
        payload_json: JSON.stringify({
          terminalId: 'term_worker',
          workerTaskId: 'worker_latest',
          launch: 'codex',
          root: '/repo/packages/api',
          title: 'Codex review worker',
          commanderTerminalId: 'commander_terminal_new',
        }),
      },
      {
        rowid: 4,
        task_id: 'commander_new',
        type: 'orchestration.workerTurnStarted',
        payload_json: JSON.stringify({ terminalId: 'term_worker', workerTaskId: 'worker_latest' }),
      },
      {
        rowid: 5,
        task_id: 'commander_old',
        type: 'orchestration.workerKilled',
        payload_json: JSON.stringify({ terminalId: 'term_worker' }),
      },
    ];
    const service = {
      db: {
        prepare: (query: string) => ({
          all: () => (query.includes('task_events') ? eventRows : taskRows),
        }),
      },
      rowToDto: (row: (typeof taskRows)[number]) => row.task,
    } as unknown as TaskService;

    expect(TaskService.prototype.liveOrchestrationWorkers.call(service, ['term_worker'])).toEqual([
      {
        commanderTaskId: 'commander_new',
        commanderTerminalId: 'commander_terminal_new',
        terminalId: 'term_worker',
        workerTaskId: 'worker_latest',
        launch: 'codex',
        root: '/repo/packages/api',
        projectPath: '/repo',
        title: 'Codex review worker',
        turnPending: true,
      },
    ]);
  });
});
