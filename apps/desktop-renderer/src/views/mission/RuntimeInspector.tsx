import React, { useEffect, useState } from 'react';
import type { AssignmentDto, MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { ConfirmDangerButton } from '../ui.js';
import { Ic, ProviderMark, type ProviderMarkKind } from '../home-icons.js';
import { latestProgressForAssignment, taskStateCopy } from './mission-view-model.js';

function providerMark(provider: string | null, kind: string | undefined): ProviderMarkKind {
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  if (provider === 'shell' || kind === 'shell_agent') return 'shell';
  return 'pi';
}

function referenceSummary(reference: Record<string, unknown>): string | null {
  for (const key of ['path', 'uri', 'state', 'worktreePath', 'runtimeSessionId']) {
    const value = reference[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

export function RuntimeInspector({
  snapshot,
  assignment,
  missionId,
  onPause,
  onCancel,
  onRetry,
  onSteer,
  onReassign,
  onPromoteLead,
  onCloseRuntime,
  onOpenRuntime,
}: {
  snapshot: MissionSnapshotDto;
  assignment: AssignmentDto | null;
  missionId: string;
  onPause: (missionId: string, assignmentId: string, paused: boolean) => void;
  onCancel: (missionId: string, assignmentId: string) => void;
  onRetry: (missionId: string, assignmentId: string) => void;
  onSteer: (missionId: string, assignmentId: string, text: string) => void;
  onReassign: (
    missionId: string,
    assignmentId: string,
    runtime: 'managed' | 'claude' | 'codex' | 'shell',
    displayName: string,
  ) => void;
  onPromoteLead: (missionId: string, assignmentId: string) => void;
  onCloseRuntime: (missionId: string, assignmentId: string) => void;
  onOpenRuntime: (assignmentId: string) => void;
}): React.JSX.Element {
  const attempt = assignment
    ? (snapshot.attempts.find((item) => item.id === assignment.activeAttemptId) ?? null)
    : null;
  const task = assignment
    ? snapshot.tasks.find((item) => item.id === assignment.taskId)
    : undefined;
  const principal = assignment
    ? snapshot.principals.find((item) => item.id === assignment.assigneePrincipalId)
    : undefined;
  const artifacts = assignment
    ? snapshot.artifacts.filter((item) => item.assignmentId === assignment.id)
    : [];
  const runtimeSession = attempt
    ? (snapshot.runtimeSessions?.find((item) => item.attemptId === attempt.id) ?? null)
    : null;
  const latestRuntimeEvent = runtimeSession
    ? (snapshot.runtimeEvents
        ?.filter((item) => item.runtimeSessionId === runtimeSession.id)
        .at(-1) ?? null)
    : null;
  const deliverySummary = assignment
    ? (snapshot.messageDeliveries ?? []).reduce<Record<string, number>>((summary, delivery) => {
        if (delivery.assignmentId === assignment.id) {
          summary[delivery.state] = (summary[delivery.state] ?? 0) + 1;
        }
        return summary;
      }, {})
    : {};
  const latest = assignment ? latestProgressForAssignment(snapshot, assignment.id) : null;
  const [steerText, setSteerText] = useState('');
  const [reassigning, setReassigning] = useState(false);
  const [replacementRuntime, setReplacementRuntime] = useState<
    'managed' | 'claude' | 'codex' | 'shell'
  >(attempt?.requestedRuntime ?? 'managed');
  const [replacementName, setReplacementName] = useState(
    `${principal?.displayName ?? 'Agent'} replacement`,
  );
  useEffect(() => {
    setSteerText('');
    setReassigning(false);
    setReplacementRuntime(attempt?.requestedRuntime ?? 'managed');
    setReplacementName(`${principal?.displayName ?? 'Agent'} replacement`);
  }, [assignment?.id, attempt?.requestedRuntime, principal?.displayName]);

  if (!assignment || !task) {
    return (
      <div className="mission-detail-empty">
        <Ic name="compass" size={24} />
        <strong>Select a work item</strong>
        <span>See its owner, latest update, evidence and controls here.</span>
      </div>
    );
  }

  const state = taskStateCopy(task.state, assignment.state);
  const controllable = ['ACTIVE', 'WAITING', 'PAUSED'].includes(assignment.state);
  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'ORPHANED'].includes(assignment.state);
  const holdsVisibleInput = attempt?.requestedRuntime !== 'managed';
  const resultSummary =
    task.result && typeof task.result.summary === 'string' ? task.result.summary : null;

  return (
    <article className="mission-work-detail" data-testid="mission-work-detail">
      <header className="mission-detail-head">
        <span className="mission-detail-owner-mark">
          <ProviderMark
            provider={providerMark(principal?.provider ?? null, principal?.kind)}
            size={18}
          />
        </span>
        <span>
          <small>
            {assignment.id === snapshot.mission.leadAssignmentId ? 'Mission Lead' : 'Owner'}
          </small>
          <strong>{principal?.displayName ?? 'Agent'}</strong>
        </span>
        <span className={`mission-state-pill tone-${state.tone}`}>{state.label}</span>
      </header>

      <section className="mission-detail-intent">
        <h2>{task.title}</h2>
        <p>{task.goal}</p>
      </section>

      {latest || resultSummary ? (
        <section className="mission-detail-update">
          <small>{task.state === 'COMPLETED' ? 'Outcome' : 'Latest update'}</small>
          <p>{latest?.body || latest?.subject || resultSummary}</p>
        </section>
      ) : null}

      {task.acceptanceCriteria.length > 0 ? (
        <section className="mission-detail-section">
          <h3>Done when</h3>
          <ul className="mission-check-list">
            {task.acceptanceCriteria.map((criterion) => (
              <li key={criterion}>
                <Ic name={task.state === 'COMPLETED' ? 'checkCircle' : 'circle'} size={13} />
                <span>{criterion}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {artifacts.length > 0 ? (
        <section
          className="mission-detail-section mission-artifacts"
          data-testid="mission-artifacts"
        >
          <h3>Evidence</h3>
          <ul>
            {artifacts.map((artifact) => {
              const detail = referenceSummary(artifact.reference);
              return (
                <li key={artifact.id} className={`kind-${artifact.kind}`}>
                  <span className="mission-artifact-icon">
                    <Ic
                      name={
                        artifact.kind === 'file-change'
                          ? 'file'
                          : artifact.kind === 'verification'
                            ? 'checkCircle'
                            : 'clipboard'
                      }
                      size={13}
                    />
                  </span>
                  <span>
                    <strong>{artifact.label}</strong>
                    <small>{detail ?? artifact.kind.replaceAll('-', ' ')}</small>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {controllable ? (
        <form
          className="mission-guidance"
          onSubmit={(event) => {
            event.preventDefault();
            const text = steerText.trim();
            if (!text) return;
            onSteer(missionId, assignment.id, text);
            setSteerText('');
          }}
        >
          <label htmlFor={`mission-steer-${assignment.id}`}>Guide this work</label>
          <textarea
            id={`mission-steer-${assignment.id}`}
            value={steerText}
            onChange={(event) => setSteerText(event.currentTarget.value)}
            placeholder="Add context, change direction, or share a constraint…"
          />
          <button type="submit" className="mission-primary" disabled={!steerText.trim()}>
            Send guidance
          </button>
        </form>
      ) : null}

      <section className="mission-detail-actions" aria-label="Work controls">
        {attempt?.runtimeSessionId && runtimeSession?.transport !== 'acp' ? (
          <button onClick={() => onOpenRuntime(assignment.id)}>
            <Ic name="external" size={12} /> Open working session
          </button>
        ) : null}
        {runtimeSession?.transport === 'acp' ? (
          <span className="mission-runtime-chip">
            <Ic name="zap" size={12} /> ACP event stream
          </span>
        ) : null}
        {controllable ? (
          <button
            title={
              holdsVisibleInput
                ? 'Holds new Mission guidance. The current Claude, Codex, or shell turn can finish.'
                : undefined
            }
            onClick={() => onPause(missionId, assignment.id, assignment.state !== 'PAUSED')}
          >
            <Ic name={assignment.state === 'PAUSED' ? 'play' : 'pause'} size={12} />
            {holdsVisibleInput
              ? assignment.state === 'PAUSED'
                ? 'Release input'
                : 'Hold new input'
              : assignment.state === 'PAUSED'
                ? 'Resume'
                : 'Pause'}
          </button>
        ) : null}
        {['FAILED', 'ORPHANED'].includes(assignment.state) ? (
          <button onClick={() => onRetry(missionId, assignment.id)}>
            <Ic name="refresh" size={12} /> Retry
          </button>
        ) : null}
        {!['COMPLETED', 'CANCELLED'].includes(assignment.state) ? (
          <button onClick={() => setReassigning((value) => !value)}>
            <Ic name="user" size={12} /> Change owner
          </button>
        ) : null}
      </section>

      {reassigning ? (
        <form
          className="mission-reassign"
          onSubmit={(event) => {
            event.preventDefault();
            const name = replacementName.trim();
            if (!name) return;
            onReassign(missionId, assignment.id, replacementRuntime, name);
            setReassigning(false);
          }}
        >
          <strong>Change owner</strong>
          <label>
            Agent runtime
            <select
              value={replacementRuntime}
              onChange={(event) =>
                setReplacementRuntime(
                  event.currentTarget.value as 'managed' | 'claude' | 'codex' | 'shell',
                )
              }
            >
              <option value="managed">Charter Agent</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="shell">Shell Agent</option>
            </select>
          </label>
          <label>
            Display name
            <input
              value={replacementName}
              onChange={(event) => setReplacementName(event.currentTarget.value)}
            />
          </label>
          <span className="mission-reassign-actions">
            <button type="button" onClick={() => setReassigning(false)}>
              Cancel
            </button>
            <button type="submit" className="mission-primary">
              Assign
            </button>
          </span>
        </form>
      ) : null}

      <details className="mission-technical">
        <summary>Advanced controls and runtime details</summary>
        <dl>
          <div>
            <dt>Work mode</dt>
            <dd>{task.workMode.replaceAll('-', ' ')}</dd>
          </div>
          <div>
            <dt>Runtime</dt>
            <dd>
              {attempt?.requestedRuntime ?? 'Not started'}
              {runtimeSession ? ` · ${runtimeSession.transport.toUpperCase()}` : ''}
            </dd>
          </div>
          <div>
            <dt>Attempt</dt>
            <dd>{attempt ? `${attempt.ordinal} · ${attempt.state}` : '—'}</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>{attempt?.runtimeSessionId ?? '—'}</dd>
          </div>
          {runtimeSession ? (
            <>
              <div>
                <dt>Process</dt>
                <dd>{runtimeSession.processKey ?? runtimeSession.provider}</dd>
              </div>
              <div>
                <dt>Transport</dt>
                <dd>
                  {runtimeSession.transport.toUpperCase()} · {runtimeSession.state}
                </dd>
              </div>
              <div>
                <dt>Last event</dt>
                <dd>{latestRuntimeEvent?.kind ?? 'session.started'}</dd>
              </div>
              <div>
                <dt>Inbox</dt>
                <dd>
                  {Object.entries(deliverySummary)
                    .map(([state, count]) => `${count} ${state}`)
                    .join(' · ') || 'No messages'}
                </dd>
              </div>
            </>
          ) : null}
        </dl>
        <div className="mission-advanced-actions">
          {snapshot.mission.leadAssignmentId !== assignment.id &&
          ['PENDING', 'ACTIVE', 'WAITING', 'PAUSED', 'ORPHANED'].includes(assignment.state) ? (
            <button onClick={() => onPromoteLead(missionId, assignment.id)}>
              Make Mission Lead
            </button>
          ) : null}
          {terminal && attempt?.runtimeSessionId ? (
            <button onClick={() => onCloseRuntime(missionId, assignment.id)}>
              Close resident runtime
            </button>
          ) : null}
          {!['COMPLETED', 'CANCELLED'].includes(assignment.state) ? (
            <ConfirmDangerButton
              label="Cancel this work…"
              confirmLabel="Confirm cancellation"
              testid={`mission-cancel-assignment-${assignment.id}`}
              quiet
              onConfirm={() => onCancel(missionId, assignment.id)}
            />
          ) : null}
        </div>
      </details>
    </article>
  );
}
