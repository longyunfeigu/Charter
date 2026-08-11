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
import { MissionDeleteDialog } from './MissionDeleteDialog.js';

type MissionScope = 'active' | 'history' | 'deleted';

export function MissionRailPanel(): React.JSX.Element {
  const app = useAppStore();
  const byId = useOrchestrationStore((state) => state.missionsById);
  const order = useOrchestrationStore((state) => state.missionOrder);
  const deletedById = useOrchestrationStore((state) => state.deletedMissionsById);
  const deletedOrder = useOrchestrationStore((state) => state.deletedMissionOrder);
  const selectedId = app.missionCenter?.missionId ?? null;
  const [scope, setScope] = useState<MissionScope>('active');
  const [query, setQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{
    snapshot: MissionSnapshotDto;
    permanent: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const selected = selectedId ? byId[selectedId] : null;
    if (selected && TERMINAL_MISSION_STATES.has(selected.mission.state)) setScope('history');
  }, [byId, selectedId]);
  const missions = useMemo<MissionSnapshotDto[]>(
    () =>
      (scope === 'deleted' ? deletedOrder : order)
        .flatMap((id) => {
          const snapshot = scope === 'deleted' ? deletedById[id] : byId[id];
          return snapshot ? [snapshot] : [];
        })
        .filter((snapshot) => {
          if (scope === 'deleted') {
            const normalized = query.trim().toLowerCase();
            return (
              !normalized ||
              `${snapshot.mission.title} ${snapshot.mission.goal}`
                .toLowerCase()
                .includes(normalized)
            );
          }
          const terminal = TERMINAL_MISSION_STATES.has(snapshot.mission.state);
          if ((scope === 'active' && terminal) || (scope === 'history' && !terminal)) return false;
          const normalized = query.trim().toLowerCase();
          return (
            !normalized ||
            `${snapshot.mission.title} ${snapshot.mission.goal}`.toLowerCase().includes(normalized)
          );
        }),
    [byId, deletedById, deletedOrder, order, query, scope],
  );
  const activeCount = order.filter((id) => {
    const snapshot = byId[id];
    return snapshot && !TERMINAL_MISSION_STATES.has(snapshot.mission.state);
  }).length;
  const historyCount = order.length - activeCount;
  const deletedCount = deletedOrder.length;

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget || busy) return;
    setBusy(true);
    const store = useOrchestrationStore.getState();
    const ok = deleteTarget.permanent
      ? await store.deleteMissionPermanently(deleteTarget.snapshot.mission.id)
      : await store.trashMission(deleteTarget.snapshot.mission.id);
    setBusy(false);
    if (ok) setDeleteTarget(null);
  };

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
          <button
            role="tab"
            aria-selected={scope === 'deleted'}
            className={scope === 'deleted' ? 'active' : ''}
            data-testid="mission-scope-deleted"
            onClick={() => setScope('deleted')}
          >
            Deleted <span>{deletedCount}</span>
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
        {scope === 'deleted' ? (
          <div className="mission-rail-trash-note">
            <Ic name="clock" size={14} />
            <span>
              <strong>Recently Deleted</strong>
              <small>Recoverable for 30 days</small>
            </span>
          </div>
        ) : (
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
        )}
        {missions.length === 0 ? (
          <div className="mission-rail-empty">
            <Ic
              name={scope === 'active' ? 'compass' : scope === 'history' ? 'clock' : 'trash'}
              size={20}
            />
            <strong>{query ? 'No matching Missions' : `No ${scope} Missions`}</strong>
            <span>
              {scope === 'active'
                ? 'When an Agent coordinates work, its Mission will appear here.'
                : scope === 'history'
                  ? 'Accepted and stopped Missions remain available here.'
                  : 'Deleted Missions remain recoverable here for 30 days.'}
            </span>
          </div>
        ) : (
          <div className="mission-rail-list">
            {missions.map((snapshot) => {
              const summary = missionSummary(snapshot);
              const state = missionStateCopy(snapshot.mission.state);
              const historyStateIcon =
                snapshot.mission.state === 'COMPLETED'
                  ? 'check'
                  : snapshot.mission.state === 'CANCELLED'
                    ? 'ban'
                    : 'alert';
              return (
                <div
                  key={snapshot.mission.id}
                  className={`mission-rail-card-row ${selectedId === snapshot.mission.id ? 'selected' : ''}`}
                >
                  <button
                    type="button"
                    className="mission-rail-card"
                    data-testid={`mission-rail-${snapshot.mission.id}`}
                    disabled={scope === 'deleted'}
                    onClick={() => app.openMission(snapshot.mission.id)}
                  >
                    <span className={`mission-rail-state tone-${state.tone}`} aria-hidden />
                    <span className="mission-rail-card-copy">
                      <span className="mission-rail-card-top">
                        <strong>{snapshot.mission.title}</strong>
                        <time dateTime={snapshot.mission.deletedAt ?? snapshot.mission.updatedAt}>
                          {formatMissionTime(
                            snapshot.mission.deletedAt ?? snapshot.mission.updatedAt,
                          )}
                        </time>
                      </span>
                      {scope === 'history' ? (
                        <span className="mission-rail-card-meta mission-rail-card-outcome">
                          <span
                            className={`mission-state-pill mission-rail-outcome-status tone-${state.tone}`}
                            data-testid={`mission-history-status-${snapshot.mission.id}`}
                          >
                            <Ic name={historyStateIcon} size={9} strokeWidth={2.2} />
                            {state.label}
                          </span>
                          <span className="mission-rail-outcome-progress">
                            {summary.completed}/{summary.total} done
                          </span>
                        </span>
                      ) : (
                        <span className="mission-rail-card-meta">
                          {scope === 'deleted'
                            ? snapshot.mission.originConversationTaskId
                              ? 'Recently deleted · original Session kept'
                              : 'Recently deleted · Session tree removed'
                            : `${state.label} · ${summary.completed}/${summary.total} done`}
                        </span>
                      )}
                      {scope !== 'deleted' ? (
                        <span className="mission-rail-card-progress">
                          <i style={{ width: `${summary.percent}%` }} />
                        </span>
                      ) : null}
                    </span>
                    {scope !== 'deleted' && summary.attention > 0 ? (
                      <b className="mission-rail-attention">{summary.attention}</b>
                    ) : null}
                  </button>
                  {scope === 'history' ? (
                    <button
                      type="button"
                      className="mission-rail-row-action danger"
                      data-testid={`mission-trash-${snapshot.mission.id}`}
                      aria-label={`Delete Mission ${snapshot.mission.title}`}
                      title="Move to Recently Deleted"
                      onClick={() => setDeleteTarget({ snapshot, permanent: false })}
                    >
                      <Ic name="trash" size={13} />
                    </button>
                  ) : null}
                  {scope === 'deleted' ? (
                    <span className="mission-rail-row-actions">
                      <button
                        type="button"
                        className="mission-rail-row-action"
                        data-testid={`mission-restore-${snapshot.mission.id}`}
                        aria-label={`Restore Mission ${snapshot.mission.title}`}
                        title="Restore to History"
                        onClick={() =>
                          void useOrchestrationStore.getState().restoreMission(snapshot.mission.id)
                        }
                      >
                        <Ic name="undo" size={13} />
                      </button>
                      <button
                        type="button"
                        className="mission-rail-row-action danger"
                        data-testid={`mission-delete-permanent-${snapshot.mission.id}`}
                        aria-label={`Permanently delete Mission ${snapshot.mission.title}`}
                        title="Delete permanently"
                        onClick={() => setDeleteTarget({ snapshot, permanent: true })}
                      >
                        <Ic name="trash" size={13} />
                      </button>
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {deleteTarget ? (
        <MissionDeleteDialog
          snapshot={deleteTarget.snapshot}
          permanent={deleteTarget.permanent}
          busy={busy}
          onClose={() => {
            if (!busy) setDeleteTarget(null);
          }}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </>
  );
}
