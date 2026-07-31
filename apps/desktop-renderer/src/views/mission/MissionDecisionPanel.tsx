import React, { useState } from 'react';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { Ic } from '../home-icons.js';
import {
  formatMissionTime,
  principalName,
  unresolvedDecisionMessages,
} from './mission-view-model.js';

export function MissionDecisionPanel({
  snapshot,
  onReply,
  onSelectAssignment,
}: {
  snapshot: MissionSnapshotDto;
  onReply: (messageId: string, body: string) => void;
  onSelectAssignment: (assignmentId: string) => void;
}): React.JSX.Element | null {
  const decisions = unresolvedDecisionMessages(snapshot);
  const failed = snapshot.assignments.filter((assignment) =>
    ['FAILED', 'ORPHANED'].includes(assignment.state),
  );
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');

  if (decisions.length === 0 && failed.length === 0 && snapshot.mission.state !== 'BLOCKED') {
    return null;
  }

  return (
    <section className="mission-decisions" data-testid="mission-decisions">
      <header>
        <span className="mission-decisions-icon">
          <Ic name="inbox" size={14} />
        </span>
        <span>
          <strong>Needs you</strong>
          <small>Only decisions and recovery actions that can move the Mission forward.</small>
        </span>
        <b>{decisions.length + failed.length || 1}</b>
      </header>
      <div className="mission-decision-list">
        {decisions.map((message) => (
          <article key={message.id} className={`mission-decision priority-${message.priority}`}>
            <span className="mission-decision-kind">
              {message.type === 'question' ? 'Decision' : 'Escalation'}
            </span>
            <div className="mission-decision-copy">
              <h3>{message.subject}</h3>
              {message.body ? <p>{message.body}</p> : null}
              <small>
                From {principalName(snapshot, message.fromAssignmentId)} ·{' '}
                {formatMissionTime(message.createdAt)}
              </small>
            </div>
            {replyingTo === message.id ? (
              <form
                className="mission-decision-reply"
                onSubmit={(event) => {
                  event.preventDefault();
                  const body = reply.trim();
                  if (!body) return;
                  onReply(message.id, body);
                  setReply('');
                  setReplyingTo(null);
                }}
              >
                <textarea
                  autoFocus
                  value={reply}
                  placeholder="Give the team a clear decision…"
                  onChange={(event) => setReply(event.currentTarget.value)}
                />
                <span>
                  <button type="button" onClick={() => setReplyingTo(null)}>
                    Cancel
                  </button>
                  <button className="mission-primary" type="submit" disabled={!reply.trim()}>
                    Send decision
                  </button>
                </span>
              </form>
            ) : (
              <button
                type="button"
                className="mission-decision-action"
                onClick={() => {
                  setReply('');
                  setReplyingTo(message.id);
                }}
              >
                Respond <Ic name="arrowRight" size={12} />
              </button>
            )}
          </article>
        ))}
        {failed.map((assignment) => {
          const task = snapshot.tasks.find((item) => item.id === assignment.taskId);
          return (
            <article key={assignment.id} className="mission-decision failed-work">
              <span className="mission-decision-kind">Recovery</span>
              <div className="mission-decision-copy">
                <h3>{task?.title ?? 'A work item'} needs recovery</h3>
                <p>
                  {assignment.state === 'ORPHANED'
                    ? 'Its working session was lost. Reconnect it, retry it, or choose a new owner.'
                    : 'The latest attempt failed. Review the details before retrying.'}
                </p>
                <small>{principalName(snapshot, assignment.id)}</small>
              </div>
              <button
                type="button"
                className="mission-decision-action"
                onClick={() => onSelectAssignment(assignment.id)}
              >
                Review <Ic name="arrowRight" size={12} />
              </button>
            </article>
          );
        })}
        {decisions.length === 0 && failed.length === 0 ? (
          <article className="mission-decision mission-blocked-generic">
            <span className="mission-decision-kind">Blocked</span>
            <div className="mission-decision-copy">
              <h3>The Mission cannot continue</h3>
              <p>Open the current work and guide the Lead, or recover an unavailable runtime.</p>
            </div>
          </article>
        ) : null}
      </div>
    </section>
  );
}
