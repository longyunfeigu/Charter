import React, { useMemo, useState } from 'react';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { Ic } from '../home-icons.js';
import { formatMissionTime, principalName } from './mission-view-model.js';

type Filter = 'all' | 'decisions' | 'outcomes';

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

export function MissionActivity({ snapshot }: { snapshot: MissionSnapshotDto }): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');
  const messages = useMemo(
    () =>
      snapshot.messages
        .filter((message) => {
          if (filter === 'decisions') {
            return ['question', 'answer', 'escalation'].includes(message.type);
          }
          if (filter === 'outcomes') {
            return ['completion', 'cancellation', 'handoff'].includes(message.type);
          }
          return message.type !== 'heartbeat';
        })
        .toReversed(),
    [filter, snapshot.messages],
  );

  return (
    <section className="mission-activity-view" data-testid="mission-activity-view">
      <header className="mission-section-heading">
        <span>
          <small>Mission history</small>
          <h2>Updates and decisions</h2>
        </span>
        <nav aria-label="Activity filter">
          {(['all', 'decisions', 'outcomes'] as const).map((value) => (
            <button
              key={value}
              className={filter === value ? 'active' : ''}
              onClick={() => setFilter(value)}
            >
              {value[0]!.toUpperCase() + value.slice(1)}
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
            const meta = MESSAGE_META[message.type];
            const delivery = snapshot.messageDeliveries?.find(
              (item) =>
                item.messageId === message.id && item.assignmentId === message.toAssignmentId,
            );
            return (
              <li key={message.id} className={`${message.type} priority-${message.priority}`}>
                <span className="mission-activity-marker">
                  <Ic name={meta.icon} size={13} />
                </span>
                <article>
                  <header>
                    <span className="mission-activity-type">{meta.label}</span>
                    <time dateTime={message.createdAt}>{formatMissionTime(message.createdAt)}</time>
                  </header>
                  <h3>{message.subject}</h3>
                  {message.body ? <p>{message.body}</p> : null}
                  <small>
                    {principalName(snapshot, message.fromAssignmentId)}
                    {message.toAssignmentId
                      ? ` → ${principalName(snapshot, message.toAssignmentId)}`
                      : message.type === 'escalation'
                        ? ' → You'
                        : ''}
                    {message.suppressedAt ? ' · superseded by a newer attempt' : ''}
                    {delivery ? ` · ${delivery.state}` : ''}
                  </small>
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
