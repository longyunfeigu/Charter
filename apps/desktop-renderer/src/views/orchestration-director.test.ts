import { describe, expect, it } from 'vitest';
import type { OrchestrationWorkerDto, PermissionCardDto } from '@pi-ide/ipc-contracts';
import { directorCandidate } from './orchestration-director.js';

function worker(
  terminalId: string,
  status: OrchestrationWorkerDto['status'],
  updatedAt: string,
): OrchestrationWorkerDto {
  return {
    terminalId,
    commanderTaskId: 'task_1',
    commanderTerminalId: null,
    createdAt: updatedAt,
    launch: 'codex',
    title: terminalId,
    projectName: 'project',
    taskId: null,
    status,
    busy: status === 'streaming',
    paused: false,
    takeover: false,
    queuedSends: 0,
    exitCode: status === 'failed' ? 1 : null,
    outputTail: '',
    updatedAt,
  };
}

function permission(terminalId: string): PermissionCardDto {
  return {
    requestId: 'permission_1',
    callId: 'call_1',
    runId: 'run_1',
    taskId: 'task_1',
    toolName: 'terminal.send',
    toolDescription: 'send',
    reason: null,
    risk: { level: 'R3', reasons: ['danger'] },
    preview: { summary: 'send', targets: [terminalId] },
    input: { id: terminalId },
    paramsHash: 'hash',
    options: { allowScopes: ['once', 'task'], denyScopes: ['once'] },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('director priority (ORCH-010)', () => {
  it('orders approval > failure > completed > streaming > quiet', () => {
    const workers = [
      worker('quiet', 'quiet', '2026-01-01T00:00:01.000Z'),
      worker('stream', 'streaming', '2026-01-01T00:00:02.000Z'),
      worker('done', 'completed', '2026-01-01T00:00:03.000Z'),
      worker('failed', 'failed', '2026-01-01T00:00:04.000Z'),
      worker('approval', 'quiet', '2026-01-01T00:00:00.000Z'),
    ];
    expect(directorCandidate(workers, [permission('approval')])?.worker.terminalId).toBe(
      'approval',
    );
    expect(directorCandidate(workers, [])?.worker.terminalId).toBe('failed');
    expect(directorCandidate(workers.slice(0, 3), [])?.worker.terminalId).toBe('done');
    expect(directorCandidate(workers.slice(0, 2), [])?.worker.terminalId).toBe('stream');
  });
});
