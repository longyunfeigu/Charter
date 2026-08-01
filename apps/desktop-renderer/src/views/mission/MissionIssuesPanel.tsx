import React from 'react';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { Ic } from '../home-icons.js';
import { formatMissionTime, openIncidents, principalName } from './mission-view-model.js';

export function MissionIssuesPanel({
  snapshot,
  onSelectAssignment,
}: {
  snapshot: MissionSnapshotDto;
  onSelectAssignment: (assignmentId: string) => void;
}): React.JSX.Element | null {
  const incidents = openIncidents(snapshot);
  if (incidents.length === 0) return null;

  return (
    <section className="mission-issues" data-testid="mission-issues">
      <header>
        <span>
          <Ic name="alert" size={14} />
        </span>
        <span>
          <strong>Issues</strong>
          <small>Runtime and coordination problems, tracked separately from your actions.</small>
        </span>
        <b>{incidents.length}</b>
      </header>
      <div className="mission-issue-list">
        {incidents.map((incident) => (
          <article key={incident.id} className={`severity-${incident.severity}`}>
            <span>{incident.state === 'RECOVERING' ? 'Recovering' : incident.severity}</span>
            <div>
              <h3>{incident.summary}</h3>
              <small>
                {incident.assignmentId
                  ? principalName(snapshot, incident.assignmentId)
                  : 'Mission system'}{' '}
                · {formatMissionTime(incident.updatedAt)}
                {incident.automaticAttempts > 0
                  ? ` · ${incident.automaticAttempts} automatic recovery attempt${incident.automaticAttempts === 1 ? '' : 's'}`
                  : ''}
              </small>
            </div>
            {incident.assignmentId ? (
              <button type="button" onClick={() => onSelectAssignment(incident.assignmentId!)}>
                Inspect <Ic name="arrowRight" size={11} />
              </button>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
