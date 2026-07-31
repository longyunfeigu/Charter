import React from 'react';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { Ic, ProviderMark, type ProviderMarkKind } from '../home-icons.js';
import {
  assignmentForTask,
  latestProgressForAssignment,
  taskStateCopy,
} from './mission-view-model.js';

function providerMark(provider: string | null, kind: string | undefined): ProviderMarkKind {
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  if (provider === 'shell' || kind === 'shell_agent') return 'shell';
  return 'pi';
}

export function MissionWorkMap({
  snapshot,
  selectedTaskId,
  onSelect,
}: {
  snapshot: MissionSnapshotDto;
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
}): React.JSX.Element {
  const children = new Map<string | null, MissionSnapshotDto['tasks']>();
  for (const task of snapshot.tasks) {
    children.set(task.parentTaskId, [...(children.get(task.parentTaskId) ?? []), task]);
  }
  const taskById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const dependencies = new Map<string, string[]>();
  for (const dependency of snapshot.dependencies) {
    dependencies.set(dependency.taskId, [
      ...(dependencies.get(dependency.taskId) ?? []),
      dependency.dependsOnTaskId,
    ]);
  }

  const renderTask = (
    task: MissionSnapshotDto['tasks'][number],
    depth: number,
    seen: ReadonlySet<string>,
  ): React.JSX.Element => {
    if (seen.has(task.id)) {
      return (
        <div key={task.id} className="mission-work-cycle">
          This work item has an invalid ownership cycle.
        </div>
      );
    }
    const assignment = assignmentForTask(snapshot, task.id);
    const principal = snapshot.principals.find(
      (item) => item.id === assignment?.assigneePrincipalId,
    );
    const state = taskStateCopy(task.state, assignment?.state);
    const latest = assignment ? latestProgressForAssignment(snapshot, assignment.id) : null;
    const continuation = assignment
      ? (snapshot.continuations
          ?.filter(
            (item) =>
              item.ownerAssignmentId === assignment.id &&
              ['ARMED', 'READY', 'DELIVERING', 'DELIVERED'].includes(item.state),
          )
          .at(-1) ?? null)
      : null;
    const continuationTargets = continuation
      ? (snapshot.continuationTargets ?? []).filter(
          (target) => target.continuationId === continuation.id,
        )
      : [];
    const taskDependencies = (dependencies.get(task.id) ?? [])
      .map((id) => taskById.get(id))
      .filter((item): item is MissionSnapshotDto['tasks'][number] => Boolean(item));
    const nested = children.get(task.id) ?? [];
    const nextSeen = new Set(seen).add(task.id);
    return (
      <div
        key={task.id}
        className={`mission-work-branch depth-${Math.min(depth, 4)}`}
        data-depth={depth}
      >
        <button
          type="button"
          className={`mission-work-card ${selectedTaskId === task.id ? 'selected' : ''} tone-${state.tone}`}
          data-testid={`mission-work-item-${task.id}`}
          onClick={() => onSelect(task.id)}
        >
          <span className={`mission-work-state tone-${state.tone}`}>
            {state.tone === 'success' ? <Ic name="check" size={11} /> : null}
          </span>
          <span className="mission-work-card-main">
            <span className="mission-work-card-heading">
              <strong>{task.title}</strong>
              <span className={`mission-state-pill tone-${state.tone}`}>{state.label}</span>
            </span>
            <span className="mission-work-owner">
              <ProviderMark
                provider={providerMark(principal?.provider ?? null, principal?.kind)}
                size={13}
              />
              <b>{principal?.displayName ?? 'Waiting for an Agent'}</b>
              {assignment?.id === snapshot.mission.leadAssignmentId ? <em>Lead</em> : null}
              {nested.length > 0 ? (
                <span>
                  {nested.length} delegated {nested.length === 1 ? 'item' : 'items'}
                </span>
              ) : null}
            </span>
            <span className="mission-work-goal">{task.goal}</span>
            {continuation ? (
              <span className="mission-work-latest" data-testid={`mission-wait-${assignment?.id}`}>
                <Ic name="clock" size={11} />
                {continuation.state === 'ARMED'
                  ? `Waiting: ${continuationTargets.filter((target) => target.satisfiedAt).length}/${continuationTargets.length} conditions`
                  : continuation.state === 'DELIVERED'
                    ? 'Resume delivered to Agent'
                    : 'Resume queued for safe idle'}
              </span>
            ) : null}
            {latest ? (
              <span className="mission-work-latest">
                <Ic name={latest.type === 'completion' ? 'checkCircle' : 'zap'} size={11} />
                {latest.body || latest.subject}
              </span>
            ) : null}
            {taskDependencies.length > 0 ? (
              <span className="mission-work-dependencies">
                <Ic name="branch" size={11} />
                After {taskDependencies.map((item) => item.title).join(', ')}
              </span>
            ) : null}
          </span>
          <Ic name="chevron" size={12} className="mission-work-open" />
        </button>
        {nested.length > 0 ? (
          <div className="mission-work-children">
            {nested.map((child) => renderTask(child, depth + 1, nextSeen))}
          </div>
        ) : null}
      </div>
    );
  };

  const roots = children.get(null) ?? [];
  const rendered = new Set<string>();
  const collect = (task: MissionSnapshotDto['tasks'][number]): void => {
    if (rendered.has(task.id)) return;
    rendered.add(task.id);
    for (const child of children.get(task.id) ?? []) collect(child);
  };
  for (const root of roots) collect(root);
  const orphans = snapshot.tasks.filter((task) => !rendered.has(task.id));

  return (
    <div className="mission-work-map" data-testid="mission-work-map">
      {roots.map((task) => renderTask(task, 0, new Set()))}
      {orphans.length > 0 ? (
        <section className="mission-work-orphans">
          <small>Unlinked work</small>
          {orphans.map((task) => renderTask(task, 0, new Set()))}
        </section>
      ) : null}
    </div>
  );
}
