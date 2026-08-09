import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDto } from '@pi-ide/ipc-contracts';

/**
 * ADR-0052 ghost-bubble guard. Main-process delta coalescing flushes before
 * every settlement broadcast, but a worker crash (or any future bypass path)
 * can still deliver a stream delta AFTER the terminal state change cleared
 * the live bubble. Accepting it would resurrect a "streaming" bubble with
 * orphan text on a settled conversation. The store must drop deltas for any
 * task that is not in a running state.
 */

const handlers = new Map<string, (payload: never) => void>();

vi.mock('../bridge.js', () => ({
  onEvent: (channel: string, listener: (payload: never) => void) => {
    handlers.set(channel, listener);
    return () => handlers.delete(channel);
  },
  rpcResult: vi.fn(async () => ({
    ok: false as const,
    error: { code: 'STUB', userMessage: 'stubbed in unit test' },
  })),
}));

import { useTaskStore } from './taskStore.js';

function emit(channel: string, payload: unknown): void {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  handler(payload as never);
}

function taskDto(state: string): TaskDto {
  return {
    id: 't1',
    title: 'Guard test',
    state,
    changedFiles: 0,
  } as unknown as TaskDto;
}

beforeEach(() => {
  handlers.clear();
  useTaskStore.setState({
    initialized: false,
    tasks: [taskDto('IN_PROGRESS')],
    activeTaskId: 't1',
    timeline: [],
    streaming: null,
    streamingThinking: null,
  });
  useTaskStore.getState().init();
});

describe('late stream deltas after settlement', () => {
  it('accepts deltas while the task runs', () => {
    emit('task.stream', { taskId: 't1', runId: 'r1', messageId: 'm1', delta: 'hel' });
    emit('task.stream', { taskId: 't1', runId: 'r1', messageId: 'm1', delta: 'lo' });
    expect(useTaskStore.getState().streaming?.text).toBe('hello');
  });

  it('drops a delta that arrives after the crash settlement (no ghost bubble)', () => {
    emit('task.stream', { taskId: 't1', runId: 'r1', messageId: 'm1', delta: 'streamin' });
    expect(useTaskStore.getState().streaming?.text).toBe('streamin');

    // Worker crash path: INTERRUPTED clears the live bubble.
    emit('task.stateChanged', {
      taskId: 't1',
      state: 'INTERRUPTED',
      task: taskDto('INTERRUPTED'),
    });
    expect(useTaskStore.getState().streaming).toBeNull();

    // A late coalesced delta must not resurrect it.
    emit('task.stream', { taskId: 't1', runId: 'r1', messageId: 'm1', delta: 'g analysis' });
    expect(useTaskStore.getState().streaming).toBeNull();

    emit('task.streamThinking', { taskId: 't1', runId: 'r1', messageId: 'm1', delta: 'thought' });
    expect(useTaskStore.getState().streamingThinking).toBeNull();
  });

  it('drops deltas for tasks not in the catalog at all', () => {
    useTaskStore.setState({ tasks: [], activeTaskId: 't1' });
    emit('task.stream', { taskId: 't1', runId: 'r1', messageId: 'm1', delta: 'orphan' });
    expect(useTaskStore.getState().streaming).toBeNull();
  });
});
