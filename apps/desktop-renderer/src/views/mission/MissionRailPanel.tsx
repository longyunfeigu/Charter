import React, { useEffect, useMemo, useState } from 'react';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { useAppStore } from '../../store/appStore.js';
import { useOrchestrationStore } from '../../store/orchestrationStore.js';
import { Ic } from '../home-icons.js';
import {
  formatMissionTime,
  missionStateCopy,
  missionSummary,
  TERMINAL_MISSION_STATES,
} from './mission-view-model.js';

export function MissionRailPanel(): React.JSX.Element {
  const app = useAppStore();
  const byId = useOrchestrationStore((state) => state.missionsById);
  const order = useOrchestrationStore((state) => state.missionOrder);
  const selectedId = app.missionCenter?.missionId ?? null;
  const [scope, setScope] = useState<'active' | 'history'>('active');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const selected = selectedId ? byId[selectedId] : null;
    if (selected && TERMINAL_MISSION_STATES.has(selected.mission.state)) setScope('history');
  }, [byId, selectedId]);
  const missions = useMemo<MissionSnapshotDto[]>(
    () =>
      order
        .flatMap((id) => {
          const snapshot = byId[id];
          return snapshot ? [snapshot] : [];
        })
        .filter((snapshot) => {
          const terminal = TERMINAL_MISSION_STATES.has(snapshot.mission.state);
          if ((scope === 'active' && terminal) || (scope === 'history' && !terminal)) return false;
          const normalized = query.trim().toLowerCase();
          return (
            !normalized ||
            `${snapshot.mission.title} ${snapshot.mission.goal}`.toLowerCase().includes(normalized)
          );
        }),
    [byId, order, query, scope],
  );
  const activeCount = order.filter((id) => {
    const snapshot = byId[id];
    return snapshot && !TERMINAL_MISSION_STATES.has(snapshot.mission.state);
  }).length;
  const historyCount = order.length - activeCount;

  return (
    <>
      <header className="sr-head mission-rail-head">
        <div className="sr-heading-row">
          <strong>Missions</strong>
          <small>{activeCount} active</small>
        </div>
        <div className="mission-rail-scope" role="tablist" aria-label="Mission scope">
          <button
            role="tab"
            aria-selected={scope === 'active'}
            className={scope === 'active' ? 'active' : ''}
            onClick={() => setScope('active')}
          >
            Active <span>{activeCount}</span>
          </button>
          <button
            role="tab"
            aria-selected={scope === 'history'}
            className={scope === 'history' ? 'active' : ''}
            onClick={() => setScope('history')}
          >
            History <span>{historyCount}</span>
          </button>
        </div>
        <label className="sr-search-box mission-rail-search">
          <Ic name="search" size={13} />
          <input
            data-testid="mission-search"
            value={query}
            placeholder="Search missions…"
            aria-label="Search Missions"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </header>
      <div className="sr-scroll mission-rail-scroll" data-testid="mission-rail-panel">
        <button
          type="button"
          className={`mission-rail-overview ${selectedId === null ? 'selected' : ''}`}
          data-testid="mission-overview-link"
          onClick={() => app.openMission(null)}
        >
          <span className="mission-rail-overview-icon">
            <Ic name="compass" size={14} />
          </span>
          <span>
            <strong>Mission overview</strong>
            <small>Progress and decisions across all work</small>
          </span>
        </button>
        {missions.length === 0 ? (
          <div className="mission-rail-empty">
            <Ic name={scope === 'active' ? 'compass' : 'clock'} size={20} />
            <strong>{query ? 'No matching Missions' : `No ${scope} Missions`}</strong>
            <span>
              {scope === 'active'
                ? 'When an Agent coordinates work, its Mission will appear here.'
                : 'Accepted and stopped Missions remain available here.'}
            </span>
          </div>
        ) : (
          <div className="mission-rail-list">
            {missions.map((snapshot) => {
              const summary = missionSummary(snapshot);
              const state = missionStateCopy(snapshot.mission.state);
              return (
                <button
                  type="button"
                  key={snapshot.mission.id}
                  className={`mission-rail-card ${selectedId === snapshot.mission.id ? 'selected' : ''}`}
                  data-testid={`mission-rail-${snapshot.mission.id}`}
                  onClick={() => app.openMission(snapshot.mission.id)}
                >
                  <span className={`mission-rail-state tone-${state.tone}`} aria-hidden />
                  <span className="mission-rail-card-copy">
                    <span className="mission-rail-card-top">
                      <strong>{snapshot.mission.title}</strong>
                      <time dateTime={snapshot.mission.updatedAt}>
                        {formatMissionTime(snapshot.mission.updatedAt)}
                      </time>
                    </span>
                    <span className="mission-rail-card-meta">
                      {state.label} · {summary.completed}/{summary.total} done
                    </span>
                    <span className="mission-rail-card-progress">
                      <i style={{ width: `${summary.percent}%` }} />
                    </span>
                  </span>
                  {summary.attention > 0 ? (
                    <b className="mission-rail-attention">{summary.attention}</b>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
