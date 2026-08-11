import { describe, expect, it } from 'vitest';
import type { WorkExecutionDto } from '@pi-ide/ipc-contracts';
import { executionPhase } from './forYouStore.js';

function execution(status: string): WorkExecutionDto {
  return {
    id: `execution-${status}`,
    workItemId: 'work-1',
    targetKind: 'session',
    targetId: 'task-1',
    role: 'primary',
    approach: '',
    displayLabel: '',
    agentLabel: '',
    status,
    summary: '',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };
}

describe('For-you execution status', () => {
  it('recognizes durable Session and Mission lifecycle states without fuzzy labels', () => {
    expect(executionPhase([execution('IN_PROGRESS')])).toBe('running');
    expect(executionPhase([execution('RUNNING')])).toBe('running');
    expect(executionPhase([execution('AWAITING_PERMISSION')])).toBe('waiting');
    expect(executionPhase([execution('REVIEW_READY')])).toBe('review');
    expect(executionPhase([execution('INTERRUPTED')])).toBe('stopped');
    expect(executionPhase([execution('CANCELLED')])).toBe('stopped');
    expect(executionPhase([execution('COMPLETED')])).toBe('completed');
  });

  it('keeps an aggregate live while any linked execution is still running', () => {
    expect(executionPhase([execution('INTERRUPTED'), execution('IN_PROGRESS')])).toBe('running');
    expect(executionPhase([execution('COMPLETED'), execution('INTERRUPTED')])).toBe('stopped');
    expect(executionPhase([])).toBe('linked');
  });
});
