import { productError, ProductFailure } from '@pi-ide/foundation';
import type { TaskDependency } from './mission-task.js';

function reachable(adjacency: Map<string, Set<string>>, from: string, target: string): boolean {
  const pending = [from];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return false;
}

export function assertDependencyInsertion(
  taskIds: Iterable<string>,
  existing: Iterable<Pick<TaskDependency, 'taskId' | 'dependsOnTaskId'>>,
  taskId: string,
  dependencies: readonly string[],
): void {
  const known = new Set(taskIds);
  known.add(taskId);
  const adjacency = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    const targets = adjacency.get(from) ?? new Set<string>();
    targets.add(to);
    adjacency.set(from, targets);
  };
  for (const edge of existing) add(edge.taskId, edge.dependsOnTaskId);

  for (const dependency of dependencies) {
    if (!known.has(dependency)) {
      throw new ProductFailure(
        productError('ORCHESTRATION_DEPENDENCY_NOT_FOUND', {
          userMessage: `Dependency ${dependency} does not belong to this Mission.`,
          context: { taskId, dependency },
        }),
      );
    }
    if (dependency === taskId || reachable(adjacency, dependency, taskId)) {
      throw new ProductFailure(
        productError('ORCHESTRATION_DEPENDENCY_CYCLE', {
          userMessage: 'This dependency would create a cycle in the Mission work graph.',
          context: { taskId, dependency },
        }),
      );
    }
    add(taskId, dependency);
  }
}

export function dependenciesSatisfied(
  dependencyIds: readonly string[],
  states: ReadonlyMap<string, string>,
): boolean {
  return dependencyIds.every((id) => states.get(id) === 'COMPLETED');
}
