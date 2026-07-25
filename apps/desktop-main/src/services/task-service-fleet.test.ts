import { describe, expect, it } from 'vitest';
import { projectHistoricalOrchestrationFleet } from './task-service.js';

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
