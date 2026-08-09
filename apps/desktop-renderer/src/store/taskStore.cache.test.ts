import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskDto, TimelineEventDto } from '@pi-ide/ipc-contracts';

/**
 * ADR-0055 per-task timeline cache: stale-while-revalidate on open, event
 * application to cached (hidden kept-alive) tasks, identity-preserving
 * reconciliation so a no-op revalidation causes zero re-renders, and the MRU
 * bound with active-task immunity.
 */

const handlers = new Map<string, (payload: never) => void>();
let taskGetTimeline: (taskId: string) => TimelineEventDto[];

vi.mock('../bridge.js', () => ({
  onEvent: (channel: string, listener: (payload: never) => void) => {
    handlers.set(channel, listener);
    return () => handlers.delete(channel);
  },
  rpcResult: vi.fn(async (channel: string, payload: { taskId?: string }) => {
    if (channel === 'task.get') {
      const taskId = payload.taskId!;
      return {
        ok: true as const,
        data: { task: taskDto(taskId, 'IDLE'), timeline: taskGetTimeline(taskId) },
      };
    }
    if (channel === 'task.changeSet') {
      return { ok: true as const, data: { changeSet: null } };
    }
    return { ok: false as const, error: { code: 'STUB', userMessage: 'stubbed' } };
  }),
}));

import { useTaskStore } from './taskStore.js';

function taskDto(id: string, state: string): TaskDto {
  return { id, title: id, state, changedFiles: 0 } as unknown as TaskDto;
}

function event(id: string, sequence: number, text = `event ${id}`): TimelineEventDto {
  return {
    id,
    taskId: 't-any',
    sequence,
    type: 'agent.message',
    schemaVersion: 1,
    at: new Date(1700000000000 + sequence * 1000).toISOString(),
    payload: { messageId: `m-${id}`, text },
  } as TimelineEventDto;
}

function emit(channel: string, payload: unknown): void {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  handler(payload as never);
}

beforeEach(() => {
  handlers.clear();
  taskGetTimeline = () => [];
  useTaskStore.setState({
    initialized: false,
    tasks: [taskDto('A', 'IN_PROGRESS'), taskDto('B', 'IN_PROGRESS')],
    activeTaskId: null,
    timeline: [],
    timelines: {},
    streaming: null,
    streamingThinking: null,
    loadingTimeline: false,
  });
  useTaskStore.getState().init();
});

describe('stale-while-revalidate open', () => {
  it('a cache hit paints instantly without a loading flash', async () => {
    const cached = [event('e1', 1), event('e2', 2)];
    useTaskStore.setState({ timelines: { A: cached } });
    taskGetTimeline = () => [event('e1', 1), event('e2', 2)]; // fresh objects, same ids

    const opened = useTaskStore.getState().openTask('A');
    // Synchronous view: active immediately, cached content, no Loading.
    expect(useTaskStore.getState().activeTaskId).toBe('A');
    expect(useTaskStore.getState().timeline).toBe(cached);
    expect(useTaskStore.getState().loadingTimeline).toBe(false);

    await opened;
    // Identity-preserving reconcile: unchanged history keeps the SAME array.
    expect(useTaskStore.getState().timeline).toBe(cached);
  });

  it('a cache miss keeps the loading state until the ledger arrives', async () => {
    taskGetTimeline = () => [event('e1', 1)];
    const opened = useTaskStore.getState().openTask('A');
    expect(useTaskStore.getState().loadingTimeline).toBe(true);
    await opened;
    expect(useTaskStore.getState().loadingTimeline).toBe(false);
    expect(useTaskStore.getState().timeline).toHaveLength(1);
    expect(useTaskStore.getState().timelines.A).toBe(useTaskStore.getState().timeline);
  });

  it('revalidation keeps cached events newer than the snapshot (broadcast race)', async () => {
    // e4 arrived via broadcast between the DB read and the response: the
    // fresh snapshot lacks it, but it must not blink out of the timeline.
    const e1 = event('e1', 1);
    const e4 = event('e4', 4);
    useTaskStore.setState({ timelines: { A: [e1, e4] } });
    taskGetTimeline = () => [event('e1', 1), event('e2', 2)];
    await useTaskStore.getState().openTask('A');
    const timeline = useTaskStore.getState().timeline;
    expect(timeline.map((entry) => entry.id)).toEqual(['e1', 'e2', 'e4']);
    expect(timeline[0]).toBe(e1);
    expect(timeline[2]).toBe(e4);
  });

  it('revalidation keeps a live tool row until its terminal event lands', async () => {
    const live = {
      ...event('live1', 0),
      type: 'tool.call',
      payload: { callId: 'call-x', name: 'read_file', state: 'RUNNING' },
    } as TimelineEventDto;
    useTaskStore.setState({ timelines: { A: [event('e1', 1), live] } });
    // Snapshot without the terminal event → the live row survives.
    taskGetTimeline = () => [event('e1', 1)];
    await useTaskStore.getState().openTask('A');
    expect(useTaskStore.getState().timeline.some((entry) => entry.id === 'live1')).toBe(true);
    // Snapshot WITH the persisted terminal event for the same callId → replaced.
    const terminal = {
      ...event('done1', 2),
      type: 'tool.call',
      payload: { callId: 'call-x', name: 'read_file', state: 'SUCCEEDED' },
    } as TimelineEventDto;
    useTaskStore.setState({ timelines: { A: [event('e1', 1), live] } });
    taskGetTimeline = () => [event('e1', 1), terminal];
    await useTaskStore.getState().openTask('A');
    const ids = useTaskStore.getState().timeline.map((entry) => entry.id);
    expect(ids).toContain('done1');
    expect(ids).not.toContain('live1');
  });

  it('a failed fetch removes the empty placeholder instead of caching it', async () => {
    taskGetTimeline = () => {
      throw new Error('unreachable'); // rpc will fail before calling this
    };
    const { rpcResult } = await import('../bridge.js');
    (
      rpcResult as unknown as { mockImplementationOnce: (fn: () => unknown) => void }
    ).mockImplementationOnce(async () => ({
      ok: false as const,
      error: { code: 'DOWN', userMessage: 'ledger unavailable' },
    }));
    await useTaskStore.getState().openTask('A');
    // No poisoned empty entry: the next open must fetch again, not "hit".
    expect(useTaskStore.getState().timelines.A).toBeUndefined();
    expect(useTaskStore.getState().loadingTimeline).toBe(false);
  });

  it('revalidation appends new events while old rows keep their identity', async () => {
    const cachedE1 = event('e1', 1);
    useTaskStore.setState({ timelines: { A: [cachedE1] } });
    taskGetTimeline = () => [event('e1', 1), event('e3', 3)];
    await useTaskStore.getState().openTask('A');
    const timeline = useTaskStore.getState().timeline;
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toBe(cachedE1); // old reference survives for memo rows
    expect(timeline[1]!.id).toBe('e3');
  });
});

describe('events reach cached background tasks', () => {
  it('applies an event to a cached, non-active task without touching the active view', async () => {
    taskGetTimeline = () => [event('a1', 1)];
    await useTaskStore.getState().openTask('A');
    taskGetTimeline = () => [event('b1', 1)];
    await useTaskStore.getState().openTask('B'); // A stays cached, B active

    emit('task.event', { taskId: 'A', event: event('a2', 2) });
    expect(useTaskStore.getState().timelines.A).toHaveLength(2);
    // The active singleton still belongs to B.
    expect(useTaskStore.getState().timeline).toBe(useTaskStore.getState().timelines.B);
    expect(useTaskStore.getState().timeline).toHaveLength(1);
  });

  it('drops events for tasks with no cached timeline (uncached behavior unchanged)', () => {
    emit('task.event', { taskId: 'Z', event: event('z1', 1) });
    expect(useTaskStore.getState().timelines.Z).toBeUndefined();
  });
});

describe('bounds and cleanup', () => {
  it('caps the cache and never evicts the active task', async () => {
    for (let i = 0; i < 12; i++) {
      const id = `T${i}`;
      useTaskStore.setState({
        tasks: [...useTaskStore.getState().tasks, taskDto(id, 'IDLE')],
      });
      taskGetTimeline = () => [event(`${id}-e`, 1)];
      await useTaskStore.getState().openTask(id);
    }
    const keys = Object.keys(useTaskStore.getState().timelines);
    expect(keys.length).toBeLessThanOrEqual(8);
    expect(keys).toContain('T11'); // the active (most recent) survives
  });

  it('task.deleted drops the cached timeline', async () => {
    taskGetTimeline = () => [event('a1', 1)];
    await useTaskStore.getState().openTask('A');
    emit('task.deleted', { taskId: 'A' });
    expect(useTaskStore.getState().timelines.A).toBeUndefined();
  });
});
