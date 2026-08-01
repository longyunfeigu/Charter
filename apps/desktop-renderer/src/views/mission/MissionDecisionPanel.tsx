import React, { useState } from 'react';
import type { ActionRequestDto, MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { Ic } from '../home-icons.js';
import { formatMissionTime, principalName, userActionRequests } from './mission-view-model.js';

const KIND_LABEL: Record<ActionRequestDto['kind'], string> = {
  information: 'Input',
  review: 'Review',
  approval: 'Approval',
  choice: 'Decision',
  input: 'Input',
  recovery: 'Recovery',
  escalation: 'Escalation',
};

function optionsFor(request: ActionRequestDto): ActionRequestDto['options'] {
  if (request.options.length > 0) return request.options;
  if (request.responseType === 'approval') {
    return [
      { id: 'approved', label: 'Approve' },
      { id: 'rejected', label: 'Reject' },
    ];
  }
  if (request.responseType === 'review') {
    return [
      { id: 'approved', label: 'Accept review' },
      { id: 'changes_requested', label: 'Request changes' },
    ];
  }
  if (request.responseType === 'recovery') {
    return [
      { id: 'retry', label: 'Retry' },
      { id: 'cancel', label: 'Cancel work' },
    ];
  }
  return [];
}

export function MissionDecisionPanel({
  snapshot,
  onResolve,
  onSelectAssignment,
}: {
  snapshot: MissionSnapshotDto;
  onResolve: (requestId: string, outcome: string, body?: string, rationale?: string) => void;
  onSelectAssignment: (assignmentId: string) => void;
}): React.JSX.Element | null {
  const actions = userActionRequests(snapshot);
  const [respondingTo, setRespondingTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');

  if (actions.length === 0) return null;

  return (
    <section className="mission-decisions mission-user-actions" data-testid="mission-user-actions">
      <header>
        <span className="mission-decisions-icon">
          <Ic name="inbox" size={14} />
        </span>
        <span>
          <strong>Your actions</strong>
          <small>Only explicit decisions assigned to you appear here.</small>
        </span>
        <b>{actions.length}</b>
      </header>
      <div className="mission-decision-list">
        {actions.map((request) => {
          const options = optionsFor(request);
          return (
            <article
              key={request.id}
              className={`mission-decision priority-${request.priority}`}
              data-testid={`mission-user-action-${request.id}`}
            >
              <span className="mission-decision-kind">{KIND_LABEL[request.kind]}</span>
              <div className="mission-decision-copy">
                <h3>{request.title}</h3>
                {request.context ? <p>{request.context}</p> : null}
                {request.impact ? (
                  <p className="mission-action-impact">
                    <b>Why it matters</b> {request.impact}
                  </p>
                ) : null}
                {request.recommendation ? (
                  <p className="mission-action-recommendation">
                    <b>Team recommendation</b> {request.recommendation}
                  </p>
                ) : null}
                <small>
                  From {principalName(snapshot, request.createdByAssignmentId)} ·{' '}
                  {formatMissionTime(request.createdAt)}
                </small>
                {request.createdByAssignmentId ? (
                  <button
                    type="button"
                    className="mission-action-view-work"
                    onClick={() => onSelectAssignment(request.createdByAssignmentId!)}
                  >
                    View related work
                  </button>
                ) : null}
              </div>
              {options.length > 0 ? (
                <div className="mission-action-options" aria-label={`Resolve ${request.title}`}>
                  {options.map((option, index) => (
                    <button
                      key={option.id}
                      type="button"
                      className={index === 0 ? 'mission-primary' : ''}
                      title={option.description}
                      onClick={() => onResolve(request.id, option.id, option.label)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : respondingTo === request.id ? (
                <form
                  className="mission-decision-reply"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const body = reply.trim();
                    if (!body) return;
                    onResolve(request.id, 'answered', body);
                    setReply('');
                    setRespondingTo(null);
                  }}
                >
                  <textarea
                    autoFocus
                    value={reply}
                    placeholder="Give the team a clear answer…"
                    onChange={(event) => setReply(event.currentTarget.value)}
                  />
                  <span>
                    <button type="button" onClick={() => setRespondingTo(null)}>
                      Cancel
                    </button>
                    <button className="mission-primary" type="submit" disabled={!reply.trim()}>
                      Send answer
                    </button>
                  </span>
                </form>
              ) : (
                <button
                  type="button"
                  className="mission-decision-action"
                  onClick={() => {
                    setReply('');
                    setRespondingTo(request.id);
                  }}
                >
                  Respond <Ic name="arrowRight" size={12} />
                </button>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
