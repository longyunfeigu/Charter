import { describe, expect, it } from 'vitest';
import { ProductFailure } from '@pi-ide/foundation';
import {
  assertAttemptTransition,
  assertDependencyInsertion,
  canTransitionAssignment,
  canTransitionMission,
  canTransitionMissionTask,
  defaultMissionExecutionPolicy,
  dependenciesSatisfied,
} from './index.js';

describe('orchestration domain', () => {
  it('uses one inherited Mission-wide execution policy', () => {
    expect(defaultMissionExecutionPolicy('/repo')).toEqual({
      inheritHostPermissions: true,
      controlScope: 'mission-wide',
      workspaceRoot: '/repo',
      toolPolicy: 'inherit',
      runtimeDefaults: { environment: {} },
      limits: { maxConcurrentAgents: null, maxTotalAgents: null },
    });
  });

  it('supports the normal Mission, task, assignment and attempt paths', () => {
    expect(canTransitionMission('PLANNING', 'RUNNING')).toBe(true);
    expect(canTransitionMissionTask('PROPOSED', 'READY')).toBe(true);
    expect(canTransitionMissionTask('READY', 'RUNNING')).toBe(true);
    expect(canTransitionAssignment('ACTIVE', 'WAITING')).toBe(true);
    expect(() => assertAttemptTransition('RUNNING', 'SUCCEEDED')).not.toThrow();
  });

  it('rejects a dependency cycle including a multi-hop cycle', () => {
    const tasks = ['T-A', 'T-B', 'T-C'];
    const edges = [
      { taskId: 'T-B', dependsOnTaskId: 'T-A' },
      { taskId: 'T-C', dependsOnTaskId: 'T-B' },
    ];
    expect(() => assertDependencyInsertion(tasks, edges, 'T-A', ['T-C'])).toThrowError(
      ProductFailure,
    );
  });

  it('rejects dependencies outside the Mission and promotes only all-complete tasks', () => {
    expect(() => assertDependencyInsertion(['T-A'], [], 'T-B', ['T-X'])).toThrowError(
      ProductFailure,
    );
    expect(
      dependenciesSatisfied(
        ['T-A', 'T-B'],
        new Map([
          ['T-A', 'COMPLETED'],
          ['T-B', 'RUNNING'],
        ]),
      ),
    ).toBe(false);
    expect(
      dependenciesSatisfied(
        ['T-A', 'T-B'],
        new Map([
          ['T-A', 'COMPLETED'],
          ['T-B', 'COMPLETED'],
        ]),
      ),
    ).toBe(true);
  });
});
