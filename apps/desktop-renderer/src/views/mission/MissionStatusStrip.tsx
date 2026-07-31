import React from 'react';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { useAppStore } from '../../store/appStore.js';
import { Ic } from '../home-icons.js';
import { missionStateCopy, missionSummary } from './mission-view-model.js';

export function MissionStatusStrip({
  snapshot,
}: {
  snapshot: MissionSnapshotDto;
}): React.JSX.Element {
  const summary = missionSummary(snapshot);
  const state = missionStateCopy(snapshot.mission.state);
  const nextLabel =
    snapshot.mission.state === 'VERIFYING'
      ? 'Review results'
      : summary.attention > 0
        ? 'Resolve attention'
        : 'Open Mission';
  return (
    <button
      type="button"
      className={`mission-strip tone-${state.tone}`}
      data-testid="mission-status-strip"
      onClick={() => useAppStore.getState().openMission(snapshot.mission.id)}
    >
      <span className="mission-strip-mark" aria-hidden>
        <Ic name="compass" size={15} />
      </span>
      <span className="mission-strip-copy">
        <span className="mission-strip-kicker">
          <strong>{state.label}</strong>
          <span>
            {summary.completed} of {summary.total} work items done
          </span>
        </span>
        <span className="mission-strip-title">{snapshot.mission.title}</span>
        <span className="mission-strip-progress" aria-label={`${summary.percent}% complete`}>
          <i style={{ width: `${summary.percent}%` }} />
        </span>
      </span>
      <span className="mission-strip-presence">
        {summary.active > 0 ? <span>{summary.active} working</span> : null}
        {summary.waiting > 0 ? <span>{summary.waiting} waiting</span> : null}
        {summary.attention > 0 ? <strong>{summary.attention} need you</strong> : null}
      </span>
      <span className="mission-strip-open">
        {nextLabel}
        <Ic name="arrowRight" size={13} />
      </span>
    </button>
  );
}
