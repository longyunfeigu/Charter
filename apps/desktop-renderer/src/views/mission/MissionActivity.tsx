import React, { useMemo, useState } from 'react';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { Ic } from '../home-icons.js';
import {
  formatMissionTime,
  missionActivityCounts,
  missionActivityMessages,
  principalName,
  type MissionActivityFilter,
} from './mission-view-model.js';

const FILTERS: Array<{ value: MissionActivityFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'requests', label: 'Requests' },
  { value: 'progress', label: 'Progress' },
  { value: 'outcomes', label: 'Outcomes' },
];

const MESSAGE_META: Record<
  MissionSnapshotDto['messages'][number]['type'],
  { label: string; icon: string }
> = {
  assignment: { label: 'Delegated', icon: 'branch' },
  progress: { label: 'Progress', icon: 'zap' },
  question: { label: 'Question', icon: 'help' },
  answer: { label: 'Decision', icon: 'checkCircle' },
  escalation: { label: 'Escalation', icon: 'alert' },
  completion: { label: 'Completed', icon: 'checkCircle' },
  cancellation: { label: 'Cancelled', icon: 'ban' },
  handoff: { label: 'Handoff', icon: 'user' },
  heartbeat: { label: 'Heartbeat', icon: 'clock' },
};

export function MissionActivity({
  snapshot,
  onInspect,
}: {
  snapshot: MissionSnapshotDto;
  onInspect?: (message: MissionSnapshotDto['messages'][number]) => void;
}): React.JSX.Element {
  const [filter, setFilter] = useState<MissionActivityFilter>('all');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const counts = useMemo(() => missionActivityCounts(snapshot), [snapshot]);
  const messages = useMemo(
    () => missionActivityMessages(snapshot, filter).toReversed(),
    [filter, snapshot],
  );

  const toggleDetails = (messageId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  return (
    <section className="mission-activity-view" data-testid="mission-activity-view">
      <header className="mission-section-heading">
        <span>
          <small>Durable collaboration</small>
          <h2>Team activity</h2>
        </span>
        <nav aria-label="Activity filter">
          {FILTERS.map(({ value, label }) => (
            <button
              key={value}
              className={filter === value ? 'active' : ''}
              data-testid={`mission-activity-filter-${value}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              <span>{label}</span>
              <b>{counts[value]}</b>
            </button>
          ))}
        </nav>
      </header>
      {messages.length === 0 ? (
        <div className="mission-activity-empty">
          <Ic name="clock" size={22} />
          <strong>No matching updates yet</strong>
          <span>Structured Agent updates will appear here as the Mission progresses.</span>
        </div>
      ) : (
        <ol className="mission-activity" data-testid="mission-activity">
          {messages.map((message) => {
            const isExpanded = expanded.has(message.id);
            const request = (snapshot.actionRequests ?? []).find(
              (item) => item.id === message.actionRequestId,
            );
            const meta = request
              ? message.type === 'answer'
                ? { label: 'Request resolved', icon: 'checkCircle' }
                : { label: 'Action request', icon: 'help' }
              : MESSAGE_META[message.type];
            const delivery = snapshot.messageDeliveries?.find(
              (item) =>
                item.messageId === message.id && item.assignmentId === message.toAssignmentId,
            );
            return (
              <li
                key={message.id}
                className={`${message.type} priority-${message.priority} ${isExpanded ? 'expanded' : ''}`}
                data-testid={`mission-activity-item-${message.id}`}
              >
                <span className="mission-activity-marker">
                  <Ic name={meta.icon} size={13} />
                </span>
                <article>
                  <header>
                    <span className="mission-activity-type">{meta.label}</span>
                    <time dateTime={message.createdAt}>{formatMissionTime(message.createdAt)}</time>
                  </header>
                  <h3>{message.subject}</h3>
                  {message.body ? (
                    <p className={isExpanded ? 'expanded' : ''}>{message.body}</p>
                  ) : null}
                  <small>
                    {principalName(snapshot, message.fromAssignmentId)}
                    {message.toAssignmentId
                      ? ` → ${principalName(snapshot, message.toAssignmentId)}`
                      : message.type === 'escalation'
                        ? ' → You'
                        : ''}
                    {message.suppressedAt ? ' · superseded by a newer attempt' : ''}
                    {delivery ? ` · ${delivery.state}` : ''}
                    {request ? ` · ${request.status.toLowerCase()}` : ''}
                  </small>
                  {isExpanded ? (
                    <dl className="mission-activity-detail">
                      <div>
                        <dt>Priority</dt>
                        <dd>{message.priority}</dd>
                      </div>
                      <div>
                        <dt>Record</dt>
                        <dd>Event {message.sequence}</dd>
                      </div>
                      {request ? (
                        <div>
                          <dt>Request</dt>
                          <dd>
                            {request.kind} · {request.status.toLowerCase()}
                          </dd>
                        </div>
                      ) : null}
                      {message.threadId ? (
                        <div>
                          <dt>Thread</dt>
                          <dd>{message.threadId.slice(0, 12)}</dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}
                  <span className="mission-activity-actions">
                    <button
                      type="button"
                      className="mission-activity-toggle"
                      data-testid={`mission-activity-toggle-${message.id}`}
                      aria-expanded={isExpanded}
                      onClick={() => toggleDetails(message.id)}
                    >
                      {isExpanded ? 'Hide details' : 'Show details'}
                      <Ic name="chevron" size={9} />
                    </button>
                    {onInspect ? (
                      <button
                        type="button"
                        className="mission-activity-inspect"
                        onClick={() => onInspect(message)}
                      >
                        Inspect in graph <Ic name="arrowRight" size={10} />
                      </button>
                    ) : null}
                  </span>
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
