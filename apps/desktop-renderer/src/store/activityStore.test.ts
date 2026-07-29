import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem } from '@pi-ide/ipc-contracts';

vi.mock('../bridge.js', () => ({
  rpcResult: vi.fn(),
  onEvent: vi.fn(() => () => {}),
}));

import { useActivityStore } from './activityStore.js';

function write(author: 'agent' | 'system'): ActivityItem {
  return {
    key: `${author}-write`,
    taskId: 'task-1',
    sequence: 1,
    at: '2026-07-24T00:00:00.000Z',
    kind: 'write',
    label: author === 'agent' ? 'Edited src/app.ts' : 'Workspace observed modified src/app.ts',
    status: 'ok',
    paths: ['src/app.ts'],
    author,
  };
}

function observedExternalWrite(): ActivityItem {
  return {
    ...write('system'),
    key: 'observed-external-write',
    source: 'claude',
    captureGrade: 'observed',
    evidenceKinds: ['file'],
  };
}

beforeEach(() => {
  useActivityStore.setState({ perTask: {}, pulses: [], initialized: false });
});

describe('activity write presence', () => {
  it('tracks observed workspace paths without claiming the agent is writing', () => {
    useActivityStore.getState().ingest(write('system'));

    expect(useActivityStore.getState().perTask['task-1']?.filesTouched).toEqual(['src/app.ts']);
    expect(useActivityStore.getState().perTask['task-1']?.lastAction).toBeNull();
    expect(useActivityStore.getState().pulses).toEqual([]);
  });

  it('keeps presence pulses for writes proven to come from a managed agent', () => {
    useActivityStore.getState().ingest(write('agent'));

    expect(useActivityStore.getState().pulses).toHaveLength(1);
    expect(useActivityStore.getState().pulses[0]?.provenance).toBe('agent');
    expect(useActivityStore.getState().perTask['task-1']?.lastAction?.author).toBe('agent');
  });

  it('animates explicitly observed external writes without claiming a tool action', () => {
    useActivityStore.getState().ingest(observedExternalWrite());

    expect(useActivityStore.getState().pulses).toHaveLength(1);
    expect(useActivityStore.getState().pulses[0]?.provenance).toBe('observed');
    expect(useActivityStore.getState().perTask['task-1']?.lastAction).toBeNull();
  });
});
