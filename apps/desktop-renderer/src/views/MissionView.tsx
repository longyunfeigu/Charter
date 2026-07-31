import React, { useEffect, useMemo, useState } from 'react';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { useOrchestrationStore } from '../store/orchestrationStore.js';
import { useAppStore } from '../store/appStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { RuntimeInspector } from './mission/RuntimeInspector.js';
import { MissionWorkMap } from './mission/MissionWorkMap.js';
import { MissionGraph, type MissionGraphSelection } from './mission/MissionGraph.js';
import { MissionCollaborationInspector } from './mission/MissionCollaborationInspector.js';
import { MissionDecisionPanel } from './mission/MissionDecisionPanel.js';
import { MissionActivity } from './mission/MissionActivity.js';
import { MissionResults } from './mission/MissionResults.js';
import {
  assignmentForTask,
  missionStateCopy,
  missionSummary,
  type MissionSection,
} from './mission/mission-view-model.js';
import { ConfirmDangerButton } from './ui.js';
import { Ic } from './home-icons.js';
import { useTerminalStore } from './TerminalPanel.js';

function initialSection(snapshot: MissionSnapshotDto): MissionSection {
  return ['VERIFYING', 'COMPLETED'].includes(snapshot.mission.state) ? 'results' : 'work';
}

export function MissionView({ snapshot }: { snapshot: MissionSnapshotDto }): React.JSX.Element {
  const missionId = snapshot.mission.id;
  const requestedDestination = useAppStore((state) =>
    state.missionCenter?.missionId === missionId ? state.missionCenter : null,
  );
  const requestedAssignment = snapshot.assignments.find(
    (assignment) => assignment.id === requestedDestination?.assignmentId,
  );
  const leadTaskId = snapshot.assignments.find(
    (assignment) => assignment.id === snapshot.mission.leadAssignmentId,
  )?.taskId;
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    requestedAssignment?.taskId ?? leadTaskId ?? snapshot.tasks[0]?.id ?? null,
  );
  const [section, setSection] = useState<MissionSection>(() => initialSection(snapshot));
  const [workView, setWorkView] = useState<'graph' | 'outline'>(() => {
    try {
      return window.localStorage.getItem('charter.mission.workView') === 'outline'
        ? 'outline'
        : 'graph';
    } catch {
      return 'graph';
    }
  });
  const [graphSelection, setGraphSelection] = useState<MissionGraphSelection>(
    requestedAssignment ? { kind: 'task', taskId: requestedAssignment.taskId } : null,
  );
  const [graphDetailExpanded, setGraphDetailExpanded] = useState(
    requestedDestination?.inspectorTab === 'session',
  );
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const selectedAssignment = useMemo(
    () => (selectedTaskId ? assignmentForTask(snapshot, selectedTaskId) : null),
    [selectedTaskId, snapshot],
  );
  const summary = missionSummary(snapshot);
  const state = missionStateCopy(snapshot.mission.state);
  const originTaskId = snapshot.mission.originConversationTaskId;
  const isRunning = ['PLANNING', 'RUNNING', 'BLOCKED'].includes(snapshot.mission.state);
  const allPaused = summary.paused > 0 && summary.active === 0;

  useEffect(() => {
    if (selectedTaskId && snapshot.tasks.some((task) => task.id === selectedTaskId)) return;
    setSelectedTaskId(leadTaskId ?? snapshot.tasks[0]?.id ?? null);
  }, [leadTaskId, selectedTaskId, snapshot.tasks]);

  useEffect(() => {
    if (!requestedAssignment) return;
    setSection('work');
    setWorkView('graph');
    setSelectedTaskId(requestedAssignment.taskId);
    setGraphSelection({ kind: 'task', taskId: requestedAssignment.taskId });
    setGraphDetailExpanded(requestedDestination?.inspectorTab === 'session');
  }, [requestedAssignment?.id, requestedAssignment?.taskId, requestedDestination?.inspectorTab]);

  useEffect(() => {
    if (snapshot.mission.state === 'VERIFYING' && !requestedAssignment) setSection('results');
  }, [requestedAssignment, snapshot.mission.state]);

  useEffect(() => {
    try {
      window.localStorage.setItem('charter.mission.workView', workView);
    } catch {
      // The view still works when persistent browser storage is unavailable.
    }
  }, [workView]);

  useEffect(() => {
    if (workView !== 'graph' || !graphSelection) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setGraphSelection(null);
      setGraphDetailExpanded(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [graphSelection, workView]);

  const selectTask = (taskId: string): void => {
    setSelectedTaskId(taskId);
    setGraphSelection({ kind: 'task', taskId });
  };

  const openConversation = (): void => {
    if (!originTaskId) return;
    void useTaskStore.getState().openTask(originTaskId);
    useAppStore.getState().openTaskRoom(originTaskId);
  };

  const openRuntime = (assignmentId: string): void => {
    const assignment = snapshot.assignments.find((item) => item.id === assignmentId);
    const attempt = snapshot.attempts.find((item) => item.id === assignment?.activeAttemptId);
    if (attempt?.runtimeSessionId?.startsWith('managed-task:')) {
      const runtimeTaskId = attempt.runtimeSessionId.slice('managed-task:'.length);
      void useTaskStore.getState().openTask(runtimeTaskId);
      useAppStore.getState().openTaskRoom(runtimeTaskId);
      return;
    }
    if (attempt?.terminalId) {
      void useTerminalStore
        .getState()
        .adopt(attempt.terminalId)
        .then((adopted) => {
          if (!adopted) {
            useAppStore
              .getState()
              .pushToast('warning', 'The working terminal is no longer available.');
            return;
          }
          useTerminalStore.getState().setActive(attempt.terminalId!);
          useAppStore.getState().openTerminalSession(attempt.terminalId!);
        });
      return;
    }
    useAppStore.getState().pushToast('warning', 'This work has no session that can be opened.');
  };

  const selectAssignment = (assignmentId: string): void => {
    const assignment = snapshot.assignments.find((item) => item.id === assignmentId);
    if (!assignment) return;
    selectTask(assignment.taskId);
    setSection('work');
  };

  return (
    <main className="mission-workbench" data-testid="mission-view">
      <header className="mission-workbench-head">
        <div className="mission-head-nav">
          <button onClick={() => useAppStore.getState().openMission(null)}>
            <Ic name="chevron" size={12} /> All Missions
          </button>
          {originTaskId ? (
            <button data-testid="mission-open-conversation" onClick={openConversation}>
              Conversation <Ic name="external" size={11} />
            </button>
          ) : null}
        </div>
        <div className="mission-head-main">
          <span className={`mission-hero-mark tone-${state.tone}`}>
            <Ic name="compass" size={20} />
          </span>
          <span className="mission-head-copy">
            <span className="mission-head-eyebrow">
              <span className={`mission-state-pill tone-${state.tone}`} data-testid="mission-state">
                {state.label}
              </span>
              <small>{state.description}</small>
            </span>
            <h1>{snapshot.mission.title}</h1>
            <p>{snapshot.mission.goal}</p>
          </span>
          <div className="mission-head-actions">
            {isRunning && (summary.active > 0 || summary.paused > 0) ? (
              <button
                className="mission-head-control"
                data-testid="mission-pause-all"
                onClick={() =>
                  void useOrchestrationStore.getState().pauseMission(missionId, !allPaused)
                }
              >
                <Ic name={allPaused ? 'play' : 'pause'} size={12} />
                {allPaused ? 'Resume work' : 'Pause work'}
              </button>
            ) : null}
            {!['COMPLETED', 'FAILED', 'CANCELLED'].includes(snapshot.mission.state) ? (
              <ConfirmDangerButton
                label="Cancel…"
                confirmLabel="Cancel Mission"
                testid="mission-cancel"
                quiet
                onConfirm={() =>
                  void useOrchestrationStore
                    .getState()
                    .finishMission(missionId, 'cancelled', 'Cancelled by user')
                }
              />
            ) : null}
          </div>
        </div>
        <div className="mission-overview-row">
          <span className="mission-overview-progress">
            <span>
              <b>{summary.percent}%</b> complete
            </span>
            <i>
              <b style={{ width: `${summary.percent}%` }} />
            </i>
          </span>
          <span>
            <b>{summary.completed}</b>
            <small>done</small>
          </span>
          <span>
            <b>{summary.active}</b>
            <small>working</small>
          </span>
          <span>
            <b>{summary.waiting}</b>
            <small>waiting</small>
          </span>
          <span className={summary.attention > 0 ? 'attention' : ''}>
            <b>{summary.attention}</b>
            <small>need you</small>
          </span>
        </div>
      </header>

      <nav className="mission-workbench-tabs" aria-label="Mission views">
        <button
          className={section === 'work' ? 'active' : ''}
          data-testid="mission-tab-work"
          onClick={() => setSection('work')}
        >
          <Ic name="map" size={13} /> Work
          <span>
            {summary.completed}/{summary.total}
          </span>
        </button>
        <button
          className={section === 'activity' ? 'active' : ''}
          data-testid="mission-tab-activity"
          onClick={() => setSection('activity')}
        >
          <Ic name="clock" size={13} /> Updates
        </button>
        <button
          className={section === 'results' ? 'active' : ''}
          data-testid="mission-tab-results"
          onClick={() => setSection('results')}
        >
          <Ic name="checkCircle" size={13} /> Results
          {snapshot.mission.state === 'VERIFYING' ? <b>Review</b> : null}
        </button>
      </nav>

      <div className="mission-workbench-body">
        {section === 'work' ? (
          <>
            <MissionDecisionPanel
              snapshot={snapshot}
              onReply={(messageId, body) =>
                void useOrchestrationStore.getState().replyToMessage(missionId, messageId, body)
              }
              onSelectAssignment={selectAssignment}
            />
            <div
              className={[
                'mission-work-layout',
                workView === 'graph' ? 'mission-work-layout-graph' : '',
                graphSelection ? 'has-graph-detail' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <section className="mission-work-canvas">
                <header className="mission-section-heading">
                  <span>
                    <small>Live orchestration</small>
                    <h2>{workView === 'graph' ? 'Mission graph' : 'Work outline'}</h2>
                  </span>
                  <nav className="mission-work-view-switch" aria-label="Work presentation">
                    <button
                      className={workView === 'graph' ? 'active' : ''}
                      data-testid="mission-view-graph"
                      onClick={() => setWorkView('graph')}
                    >
                      <Ic name="branch" size={11} /> Graph
                    </button>
                    <button
                      className={workView === 'outline' ? 'active' : ''}
                      data-testid="mission-view-outline"
                      onClick={() => setWorkView('outline')}
                    >
                      <Ic name="layout" size={11} /> Outline
                    </button>
                  </nav>
                  <p>
                    {workView === 'graph'
                      ? 'Execution, delegation and real Agent communication — grounded in recorded Mission events.'
                      : 'Read goals, ownership and durable progress as a nested delegation outline.'}
                  </p>
                </header>
                {workView === 'graph' ? (
                  <MissionGraph
                    snapshot={snapshot}
                    selection={graphSelection}
                    replayAt={replayAt}
                    detailOpen={Boolean(graphSelection) && !graphDetailExpanded}
                    onSelection={(selection) => {
                      setGraphSelection(selection);
                      if (selection?.kind === 'task') setSelectedTaskId(selection.taskId);
                      if (!selection) setGraphDetailExpanded(false);
                    }}
                    onReplayAt={setReplayAt}
                  />
                ) : (
                  <MissionWorkMap
                    snapshot={snapshot}
                    selectedTaskId={selectedTaskId}
                    onSelect={selectTask}
                  />
                )}
              </section>
              {workView === 'outline' || graphSelection ? (
                <aside
                  className={[
                    'mission-detail-pane',
                    workView === 'graph' ? 'mission-graph-detail-drawer' : '',
                    graphDetailExpanded ? 'expanded' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  data-testid={
                    workView === 'graph' ? 'mission-graph-detail-drawer' : 'mission-outline-detail'
                  }
                  aria-live={workView === 'graph' ? 'polite' : undefined}
                >
                  {workView === 'graph' ? (
                    <nav className="mission-graph-drawer-actions" aria-label="Work detail controls">
                      <label>
                        <span>Selected work</span>
                        <select
                          aria-label="Select work detail"
                          value={
                            graphSelection?.kind === 'task'
                              ? graphSelection.taskId
                              : '__collaboration'
                          }
                          onChange={(event) => {
                            const taskId = event.currentTarget.value;
                            if (taskId === '__collaboration') return;
                            selectTask(taskId);
                          }}
                        >
                          {graphSelection?.kind !== 'task' ? (
                            <option value="__collaboration">Collaboration</option>
                          ) : null}
                          {snapshot.tasks.map((task) => (
                            <option key={task.id} value={task.id}>
                              {task.title}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        data-testid="mission-graph-detail-expand"
                        aria-pressed={graphDetailExpanded}
                        title={graphDetailExpanded ? 'Restore detail width' : 'Expand detail'}
                        onClick={() => setGraphDetailExpanded((value) => !value)}
                      >
                        <Ic name="layout" size={13} />
                        <span>{graphDetailExpanded ? 'Restore' : 'Expand'}</span>
                      </button>
                      <button
                        type="button"
                        data-testid="mission-graph-detail-close"
                        title="Close detail"
                        onClick={() => {
                          setGraphSelection(null);
                          setGraphDetailExpanded(false);
                        }}
                      >
                        <Ic name="x" size={13} />
                        <span>Close</span>
                      </button>
                    </nav>
                  ) : null}
                  {workView === 'graph' && graphSelection && graphSelection.kind !== 'task' ? (
                    <MissionCollaborationInspector
                      snapshot={snapshot}
                      selection={graphSelection}
                      replayAt={replayAt}
                      onReply={(messageId, body) =>
                        void useOrchestrationStore
                          .getState()
                          .replyToMessage(missionId, messageId, body)
                      }
                      onSelectTask={selectTask}
                    />
                  ) : (
                    <RuntimeInspector
                      snapshot={snapshot}
                      assignment={selectedAssignment}
                      missionId={missionId}
                      onPause={(m, a, paused) =>
                        void useOrchestrationStore.getState().pauseAssignment(m, a, paused)
                      }
                      onCancel={(m, a) =>
                        void useOrchestrationStore
                          .getState()
                          .cancelAssignment(m, a, 'Cancelled by user')
                      }
                      onRetry={(m, a) =>
                        void useOrchestrationStore.getState().retryAssignment(m, a)
                      }
                      onSteer={(m, a, text) =>
                        void useOrchestrationStore.getState().steerAssignment(m, a, text)
                      }
                      onReassign={(m, a, runtime, name) =>
                        void useOrchestrationStore
                          .getState()
                          .reassignAssignment(m, a, runtime, name)
                      }
                      onPromoteLead={(m, a) =>
                        void useOrchestrationStore.getState().promoteLead(m, a)
                      }
                      onCloseRuntime={(m, a) =>
                        void useOrchestrationStore.getState().closeRuntime(m, a)
                      }
                      onOpenRuntime={openRuntime}
                      onOpenAgentSession={() => setGraphDetailExpanded(true)}
                      requestedTab={
                        requestedAssignment?.id === selectedAssignment?.id
                          ? requestedDestination?.inspectorTab
                          : 'details'
                      }
                    />
                  )}
                </aside>
              ) : null}
            </div>
          </>
        ) : section === 'activity' ? (
          <MissionActivity
            snapshot={snapshot}
            onInspect={(message) => {
              const assignment = snapshot.assignments.find(
                (item) => item.id === message.fromAssignmentId,
              );
              if (assignment) selectTask(assignment.taskId);
              setReplayAt(Date.parse(message.createdAt));
              setWorkView('graph');
              setSection('work');
            }}
          />
        ) : (
          <MissionResults
            snapshot={snapshot}
            onAccept={() =>
              void useOrchestrationStore
                .getState()
                .finishMission(missionId, 'completed', 'Accepted by user')
            }
            onRequestChanges={(feedback) =>
              void useOrchestrationStore.getState().requestRevision(missionId, feedback)
            }
            onOpenConversation={originTaskId ? openConversation : null}
          />
        )}
      </div>
    </main>
  );
}
