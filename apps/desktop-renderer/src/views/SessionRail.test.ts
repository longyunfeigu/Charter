import { describe, expect, it } from 'vitest';
import type { SessionEntry } from './rail-groups.js';
import { runningSessionTargets } from './session-running-targets.js';

describe('runningSessionTargets', () => {
  it('keeps a host-active external Session when the renderer snapshot is stale', () => {
    const entry = {
      key: 'task:external_task',
      kind: 'task',
      task: {
        id: 'external_task',
        state: 'IN_PROGRESS',
        external: {
          status: 'active',
        },
      },
    } as unknown as SessionEntry;

    expect(
      runningSessionTargets([entry], {
        external_task: { status: 'ended' },
      }),
    ).toEqual([{ key: 'external:external_task', kind: 'external', taskId: 'external_task' }]);
  });
});
