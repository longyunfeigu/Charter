import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore.js';
import { useOrchestrationStore } from '../store/orchestrationStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { Ic } from './home-icons.js';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { MissionView } from './MissionView.js';
import {
  formatMissionTime,
  missionStateCopy,
  missionSummary,
  TERMINAL_MISSION_STATES,
} from './mission/mission-view-model.js';
import { MissionDeleteDialog } from './mission/MissionDeleteDialog.js';

export function MissionCenterView(): React.JSX.Element {
  const selectedId = useAppStore((state) => state.missionCenter?.missionId ?? null);
  const byId = useOrchestrationStore((state) => state.missionsById);
  const order = useOrchestrationStore((state) => state.missionOrder);
  const loading = useOrchestrationStore((state) => state.loading);
  const tasks = useTaskStore((state) => state.tasks);
  const [deleteTarget, setDeleteTarget] = useState<MissionSnapshotDto | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    useOrchestrationStore.getState().init();
    void useOrchestrationStore.getState().refreshMissions();
    void useOrchestrationStore.getState().refreshDeletedMissions();
  }, []);

  const selected = selectedId ? byId[selectedId] : null;
  const missions = useMemo<MissionSnapshotDto[]>(
    () =>
      order.flatMap((id) => {
        const snapshot = byId[id];
        return snapshot ? [snapshot] : [];
      }),
    [byId, order],
  );
  if (selected) return <MissionView snapshot={selected} />;

  const active = missions.filter(
    (snapshot) => !TERMINAL_MISSION_STATES.has(snapshot.mission.state),
  );
  const attention = active.filter((snapshot) => missionSummary(snapshot).attention > 0);
  const humanActionCount = active.reduce(
    (total, snapshot) => total + missionSummary(snapshot).attention,
    0,
  );
  const issueCount = active.reduce((total, snapshot) => total + missionSummary(snapshot).issues, 0);
  const review = active.filter((snapshot) => snapshot.mission.state === 'VERIFYING');
  const recent = missions.filter((snapshot) => TERMINAL_MISSION_STATES.has(snapshot.mission.state));

  const trashSelected = async (): Promise<void> => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    const ok = await useOrchestrationStore.getState().trashMission(deleteTarget.mission.id);
    setDeleting(false);
    if (ok) setDeleteTarget(null);
  };

  return (
    <main className="mission-center" data-testid="mission-center">
      <header className="mission-center-head">
        <span className="mission-center-mark">
          <Ic name="compass" size={22} />
        </span>
        <span>
          <small>Mission Center</small>
          <h1>Outcome-driven work, in one place.</h1>
          <p>
            Follow work, handle actions explicitly assigned to you, and review evidence without
            managing Agent terminals.
          </p>
        </span>
      </header>
      <section className="mission-center-metrics">
        <article>
          <b>{active.length}</b>
          <span>Active Missions</span>
          <small>moving toward a goal</small>
        </article>
        <article className={attention.length > 0 ? 'attention' : ''}>
          <b>{humanActionCount}</b>
          <span>Your actions</span>
          <small>explicit requests from Mission Leads</small>
        </article>
        <article className={issueCount > 0 ? 'issues' : ''}>
          <b>{issueCount}</b>
          <span>Issues</span>
          <small>runtime or coordination problems</small>
        </article>
        <article className={review.length > 0 ? 'review' : ''}>
          <b>{review.length}</b>
          <span>Ready to review</span>
          <small>waiting for acceptance</small>
        </article>
      </section>

      {loading && missions.length === 0 ? (
        <div className="mission-center-empty">Loading Missions…</div>
      ) : active.length === 0 ? (
        <section className="mission-center-empty">
          <span>
            <Ic name="compass" size={28} />
          </span>
          <h2>No active Missions</h2>
          <p>
            Start normally in Charter, Claude or Codex. When an Agent delegates work, Charter turns
            that conversation into a Mission automatically.
          </p>
          <button
            onClick={() => {
              useAppStore.getState().closeMission();
              useAppStore.getState().setRailView('sessions');
              useAppStore.getState().focusComposer();
            }}
          >
            Start a conversation
          </button>
        </section>
      ) : (
        <section className="mission-center-section">
          <header>
            <span>
              <small>Right now</small>
              <h2>Active Missions</h2>
            </span>
          </header>
          <div className="mission-center-grid">
            {active.map((snapshot) => {
              const summary = missionSummary(snapshot);
              const state = missionStateCopy(snapshot.mission.state);
              const origin = tasks.find(
                (task) => task.id === snapshot.mission.originConversationTaskId,
              );
              return (
                <button
                  key={snapshot.mission.id}
                  className={`mission-center-card tone-${state.tone}`}
                  data-testid={`mission-center-card-${snapshot.mission.id}`}
                  onClick={() => useAppStore.getState().openMission(snapshot.mission.id)}
                >
                  <span className="mission-center-card-top">
                    <span className={`mission-state-pill tone-${state.tone}`}>{state.label}</span>
                    <time dateTime={snapshot.mission.updatedAt}>
                      {formatMissionTime(snapshot.mission.updatedAt)}
                    </time>
                  </span>
                  <strong>{snapshot.mission.title}</strong>
                  <p>{snapshot.mission.goal}</p>
                  <span className="mission-center-card-progress">
                    <i style={{ width: `${summary.percent}%` }} />
                  </span>
                  <span className="mission-center-card-foot">
                    <span>
                      {summary.completed}/{summary.total} done
                    </span>
                    {summary.active > 0 ? <span>{summary.active} working</span> : null}
                    {summary.attention > 0 ? <b>{summary.attention} for you</b> : null}
                    {summary.issues > 0 ? <b>{summary.issues} issues</b> : null}
                    <small>{origin?.projectName ?? 'Current workspace'}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {recent.length > 0 ? (
        <section className="mission-center-section recent">
          <header>
            <span>
              <small>Durable record</small>
              <h2>Recent results</h2>
            </span>
          </header>
          <div className="mission-center-recent">
            {recent.slice(0, 6).map((snapshot) => {
              const state = missionStateCopy(snapshot.mission.state);
              return (
                <div key={snapshot.mission.id} className="mission-center-recent-row">
                  <button
                    type="button"
                    data-testid={`mission-center-recent-${snapshot.mission.id}`}
                    onClick={() => useAppStore.getState().openMission(snapshot.mission.id)}
                  >
                    <span className={`mission-rail-state tone-${state.tone}`} />
                    <span>
                      <strong>{snapshot.mission.title}</strong>
                      <small>{state.label}</small>
                    </span>
                    <time>{formatMissionTime(snapshot.mission.updatedAt)}</time>
                    <Ic name="arrowRight" size={12} />
                  </button>
                  <button
                    type="button"
                    className="mission-center-recent-delete"
                    data-testid={`mission-center-trash-${snapshot.mission.id}`}
                    aria-label={`Delete Mission ${snapshot.mission.title}`}
                    title="Move to Recently Deleted"
                    onClick={() => setDeleteTarget(snapshot)}
                  >
                    <Ic name="trash" size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      {deleteTarget ? (
        <MissionDeleteDialog
          snapshot={deleteTarget}
          busy={deleting}
          onClose={() => {
            if (!deleting) setDeleteTarget(null);
          }}
          onConfirm={() => void trashSelected()}
        />
      ) : null}
    </main>
  );
}
