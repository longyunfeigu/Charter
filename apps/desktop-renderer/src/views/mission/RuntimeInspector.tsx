import React, { useEffect, useState } from 'react';
import type { AssignmentDto, MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { ConfirmDangerButton } from '../ui.js';
import { Ic, ProviderMark, type ProviderMarkKind } from '../home-icons.js';
import { latestProgressForAssignment, taskStateCopy } from './mission-view-model.js';
import { useAgentCatalogStore } from '../../store/agentCatalogStore.js';

type InspectorTab = 'details' | 'session' | 'conversation' | 'attempts' | 'evidence';

function providerMark(provider: string | null, kind: string | undefined): ProviderMarkKind {
  if (provider === 'shell' || kind === 'shell_agent') return 'shell';
  return provider && provider !== 'managed' ? provider : 'pi';
}

function referenceSummary(reference: Record<string, unknown>): string | null {
  for (const key of ['path', 'uri', 'state', 'worktreePath', 'runtimeSessionId']) {
    const value = reference[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeEventText(payload: Record<string, unknown>): string | null {
  const content = objectValue(payload.content);
  for (const value of [
    content?.text,
    payload.text,
    payload.message,
    payload.title,
    payload.stopReason,
    payload.status,
  ]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function runtimeEventLabel(kind: string): string {
  if (kind.includes('agent_message')) return 'Agent';
  if (kind.includes('tool_call')) return 'Tool';
  if (kind.includes('plan')) return 'Plan';
  if (kind === 'turn.started') return 'Turn started';
  if (kind === 'turn.stopped') return 'Turn completed';
  if (kind === 'turn.failed') return 'Turn failed';
  return kind.replace(/^acp\./, '').replaceAll('_', ' ');
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
  onOpenAgentSession,
  requestedTab = 'details',
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
    runtime: string,
    displayName: string,
  ) => void;
  onPromoteLead: (missionId: string, assignmentId: string) => void;
  onCloseRuntime: (missionId: string, assignmentId: string) => void;
  onOpenRuntime: (assignmentId: string) => void;
  onOpenAgentSession?: () => void;
  requestedTab?: 'details' | 'session';
}): React.JSX.Element {
  const catalogAgents = useAgentCatalogStore((state) => state.agents);
  const initAgentCatalog = useAgentCatalogStore((state) => state.init);
  useEffect(() => initAgentCatalog(), [initAgentCatalog]);
  const runtimeAgents = catalogAgents.filter(
    (agent) => agent.installed && (agent.capabilities.acp || agent.capabilities.terminal),
  );
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
  const runtimeEvents = runtimeSession
    ? (snapshot.runtimeEvents ?? [])
        .filter((item) => item.runtimeSessionId === runtimeSession.id)
        .slice(-200)
    : [];
  const deliverySummary = assignment
    ? (snapshot.messageDeliveries ?? []).reduce<Record<string, number>>((summary, delivery) => {
        if (delivery.assignmentId === assignment.id) {
          summary[delivery.state] = (summary[delivery.state] ?? 0) + 1;
        }
        return summary;
      }, {})
    : {};
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
  const continuationIntent = continuation
    ? ((snapshot.resumeIntents ?? []).find((intent) => intent.continuationId === continuation.id) ??
      null)
    : null;
  const latest = assignment ? latestProgressForAssignment(snapshot, assignment.id) : null;
  const assignmentAttempts = assignment
    ? snapshot.attempts
        .filter((item) => item.assignmentId === assignment.id)
        .toSorted((left, right) => right.ordinal - left.ordinal)
    : [];
  const relatedMessages = assignment
    ? snapshot.messages
        .filter(
          (message) =>
            message.fromAssignmentId === assignment.id || message.toAssignmentId === assignment.id,
        )
        .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    : [];
  const [tab, setTab] = useState<InspectorTab>('details');
  const [steerText, setSteerText] = useState('');
  const [reassigning, setReassigning] = useState(false);
  const [replacementRuntime, setReplacementRuntime] = useState<string>(
    attempt?.requestedRuntime ?? 'managed',
  );
  const [replacementName, setReplacementName] = useState(
    `${principal?.displayName ?? 'Agent'} replacement`,
  );
  useEffect(() => {
    setSteerText('');
    setReassigning(false);
    setReplacementRuntime(attempt?.requestedRuntime ?? 'managed');
    setReplacementName(`${principal?.displayName ?? 'Agent'} replacement`);
    setTab(requestedTab === 'session' && runtimeSession ? 'session' : 'details');
  }, [
    assignment?.id,
    attempt?.requestedRuntime,
    principal?.displayName,
    requestedTab,
    runtimeSession?.id,
  ]);

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

      <nav className="mission-inspector-tabs" aria-label="Work details">
        {(
          [
            ['details', 'Details'],
            ...(runtimeSession
              ? ([['session', `Session ${runtimeEvents.length || ''}`]] as const)
              : []),
            ['conversation', `Conversation ${relatedMessages.length || ''}`],
            ['attempts', `Attempts ${assignmentAttempts.length || ''}`],
            ['evidence', `Evidence ${artifacts.length || ''}`],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={tab === value ? 'active' : ''}
            data-testid={`mission-inspector-tab-${value}`}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'details' ? (
        <>
          <section className="mission-detail-intent">
            <h2>{task.title}</h2>
            <p>{task.goal}</p>
          </section>

          {continuation ? (
            <section className="mission-detail-update" data-testid="mission-continuation-status">
              <small>
                {continuation.state === 'ARMED'
                  ? 'Waiting durably'
                  : continuation.state === 'DELIVERED'
                    ? 'Resume delivered'
                    : 'Resume queued'}
              </small>
              <p>{continuation.reason}</p>
              <span>
                {continuationTargets.filter((target) => target.satisfiedAt).length}/
                {continuationTargets.length} conditions matched
                {continuation.deadlineAt
                  ? ` · deadline ${new Date(continuation.deadlineAt).toLocaleString()}`
                  : ''}
                {continuationIntent ? ` · delivery ${continuationIntent.state.toLowerCase()}` : ''}
              </span>
            </section>
          ) : null}

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
        </>
      ) : null}

      {tab === 'evidence' ? (
        <section
          className="mission-detail-section mission-artifacts"
          data-testid="mission-artifacts"
        >
          <h3>Evidence</h3>
          {artifacts.length > 0 ? (
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
          ) : (
            <div className="mission-inspector-empty">
              <Ic name="clipboard" size={20} />
              <strong>No evidence recorded yet</strong>
              <span>Files, reports, verification and other durable artifacts appear here.</span>
            </div>
          )}
          {task.expectedArtifacts.length > 0 ? (
            <div className="mission-expected-artifacts">
              <h3>Expected</h3>
              {task.expectedArtifacts.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {tab === 'conversation' ? (
        <section className="mission-inspector-conversation">
          {relatedMessages.length > 0 ? (
            <ol>
              {relatedMessages.map((message) => (
                <li key={message.id} className={`type-${message.type}`}>
                  <header>
                    <strong>
                      {message.fromAssignmentId === assignment.id ? 'Sent' : 'Received'} ·{' '}
                      {message.type}
                    </strong>
                    <time>
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </header>
                  <h3>{message.subject}</h3>
                  {message.body ? <p>{message.body}</p> : null}
                  <small>{message.priority} priority</small>
                </li>
              ))}
            </ol>
          ) : (
            <div className="mission-inspector-empty">
              <Ic name="at" size={20} />
              <strong>No structured communication</strong>
              <span>Questions, answers, handoffs and progress messages appear here.</span>
            </div>
          )}
        </section>
      ) : null}

      {tab === 'session' ? (
        <section className="mission-runtime-session" data-testid="mission-runtime-session">
          <header>
            <span>
              <strong>{principal?.displayName ?? 'Agent'} session</strong>
              <small>
                {runtimeSession
                  ? `${runtimeSession.provider} · ${runtimeSession.transport.toUpperCase()} · ${runtimeSession.state}`
                  : 'Runtime not started'}
              </small>
            </span>
            {runtimeSession?.externalSessionId ? (
              <code title={runtimeSession.externalSessionId}>
                {runtimeSession.externalSessionId.slice(0, 12)}
              </code>
            ) : null}
          </header>
          {runtimeEvents.length > 0 ? (
            <ol>
              {runtimeEvents.map((event) => {
                const text = runtimeEventText(event.payload);
                return (
                  <li key={event.id} className={`kind-${event.kind.replaceAll('.', '-')}`}>
                    <span className="mission-runtime-event-mark">
                      <Ic
                        name={
                          event.kind.includes('tool')
                            ? 'terminal'
                            : event.kind.includes('failed')
                              ? 'alert'
                              : 'zap'
                        }
                        size={12}
                      />
                    </span>
                    <span>
                      <strong>{runtimeEventLabel(event.kind)}</strong>
                      {text ? <p>{text}</p> : null}
                      <small>
                        {new Date(event.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </small>
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="mission-inspector-empty">
              <Ic name="zap" size={20} />
              <strong>Session is connected</strong>
              <span>Agent output and tool activity will appear here as they arrive.</span>
            </div>
          )}
        </section>
      ) : null}

      <section className="mission-detail-actions" aria-label="Work controls">
        {attempt?.runtimeSessionId && runtimeSession?.transport !== 'acp' ? (
          <button onClick={() => onOpenRuntime(assignment.id)}>
            <Ic name="external" size={12} /> Open working session
          </button>
        ) : null}
        {runtimeSession?.transport === 'acp' ? (
          <>
            <button
              type="button"
              data-testid="mission-open-agent-session"
              onClick={() => {
                setTab('session');
                onOpenAgentSession?.();
              }}
            >
              <Ic name="external" size={12} /> Open agent session
            </button>
            <span className="mission-runtime-chip">
              <Ic name="zap" size={12} /> ACP event stream
            </span>
          </>
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
              onChange={(event) => setReplacementRuntime(event.currentTarget.value)}
            >
              <option value="managed">Charter Agent</option>
              {runtimeAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                </option>
              ))}
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

      {tab === 'attempts' ? (
        <section className="mission-attempt-history">
          {assignmentAttempts.length > 0 ? (
            assignmentAttempts.map((item) => (
              <article
                key={item.id}
                className={`mission-attempt-card state-${item.state.toLowerCase()}`}
              >
                <header>
                  <strong>Attempt {item.ordinal}</strong>
                  <span>{item.state}</span>
                </header>
                <dl>
                  <div>
                    <dt>Runtime</dt>
                    <dd>{item.requestedRuntime}</dd>
                  </div>
                  <div>
                    <dt>Model</dt>
                    <dd>{item.requestedModel ?? 'Default'}</dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>
                      {item.startedAt ? new Date(item.startedAt).toLocaleString() : 'Not started'}
                    </dd>
                  </div>
                  <div>
                    <dt>Ended</dt>
                    <dd>{item.endedAt ? new Date(item.endedAt).toLocaleString() : '—'}</dd>
                  </div>
                </dl>
                {item.failureCode ? (
                  <p className="mission-attempt-failure">
                    <Ic name="alert" size={11} /> {item.failureCode}
                  </p>
                ) : null}
              </article>
            ))
          ) : (
            <div className="mission-inspector-empty">
              <Ic name="clock" size={20} />
              <strong>No attempts yet</strong>
              <span>This task has not started a runtime.</span>
            </div>
          )}
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
        </section>
      ) : null}
    </article>
  );
}
