import React, { useEffect, useMemo, useRef, useState } from 'react';
import { rpcResult } from '../bridge.js';
import { useTaskStore, RUNNING_TASK_STATES, titleFromIntent } from '../store/taskStore.js';
import { useActivityStore, currentActionLine } from '../store/activityStore.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { StateBadge } from './AgentPanel.js';
import { RoomTimeline } from './RoomTimeline.js';
import { Markdown } from './Markdown.js';
import { LiveBoard } from './LiveBoard.js';
import { FilePeek } from './FilePeek.js';
import { ConfirmDangerButton, ModelEffortControl } from './ui.js';
import { Ic } from './home-icons.js';
import {
  MODE_META,
  type ThinkingLevelId,
  canArchiveTask,
  isAnswered,
  modeLabel,
  presentedMeta,
} from './labels.js';
import { hasDragRef, readDragRef } from './dragRefs.js';
import { useSkillSlash } from './SkillSlashPicker.js';
import { useDraftStore, type TerminalOutputRef } from '../store/draftStore.js';
import { PreviewBadge, RoomPreviewRail } from './RoomPreviewRail.js';
import { buildPreviewFeedbackText } from './LivePreview.js';
import { openTaskInEditor } from './openInEditor.js';
import { ExternalTerminalColumn, useExternalFiles } from './ExternalRoom.js';
import { useExternalStore } from '../store/externalStore.js';
import { roomCopyFor } from './roomCopy.js';

const EMPTY_TERMINAL_REFS: TerminalOutputRef[] = [];

/**
 * Task Room v2 (ADR-0008/0009, PIVOT-021/028): the per-task page rendered in
 * the persistent shell's content area — the sidebar stays alive next to it.
 * Approvals, observation, the live focus board and the final decision live
 * here; the Editor is an optional deep-dive, never a required passage.
 */
export function TaskRoomView(): React.JSX.Element {
  const store = useTaskStore();
  const app = useAppStore();
  const editor = useEditorStore();
  const workspace = useWorkspaceStore((s) => s.workspace);
  const workspaceStore = useWorkspaceStore();
  const taskId = useAppStore((s) => s.taskRoomTaskId);
  const task = store.tasks.find((t) => t.id === taskId) ?? null;
  const resumingExternalTaskId = useExternalStore((s) => s.resumingTaskId);
  const activity = useActivityStore((s) => (taskId ? s.perTask[taskId] : undefined));

  useEffect(() => {
    store.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Some external-session entry points (terminal bar / promoted panel) route
  // directly to a room. Keep the task store aligned with the room URL/state so
  // decision actions can never target an empty or previously active task.
  useEffect(() => {
    if (!taskId || useTaskStore.getState().activeTaskId === taskId) return;
    void useTaskStore.getState().openTask(taskId);
  }, [taskId]);

  // Verification evidence: latest run per label from the recorded events.
  const verifications = useMemo(() => {
    const byLabel = new Map<string, { label: string; state: string }>();
    for (const event of store.timeline) {
      if (event.type !== 'verification.completed') continue;
      const run = (event.payload as { run?: { label?: unknown; state?: unknown } }).run;
      if (run && typeof run.label === 'string') {
        byLabel.set(run.label, { label: run.label, state: String(run.state ?? '') });
      }
    }
    return [...byLabel.values()].slice(-8);
  }, [store.timeline]);

  if (!task) {
    return (
      <div className="tr-root" data-testid="task-room">
        <div className="tr-head">
          <button className="tr-back" data-testid="task-room-back" onClick={app.closeTaskRoom}>
            <Ic name="chevron" size={13} className="tr-back-ic" />
            Sessions
          </button>
        </div>
        <div className="empty-state">
          <div>This task is not available anymore.</div>
        </div>
      </div>
    );
  }

  const running = RUNNING_TASK_STATES.has(task.state);
  const answered = isAnswered(task);
  const externalCanResume =
    task.external?.status === 'ended' &&
    (task.external.cli === 'claude' || task.external.cli === 'codex') &&
    ['REVIEW_READY', 'INTERRUPTED', 'FAILED'].includes(task.state);
  const externalResuming = resumingExternalTaskId === task.id;
  // ADR-0017: an external session's rail is fed by watcher accounting, not by
  // agent tool events (there are none). Same rows, same peek behavior.
  const externalFiles = useExternalFiles(task);
  const files = task.external
    ? externalFiles.filter((f) => f.status !== 'deleted').map((f) => f.path)
    : (activity?.filesTouched ?? []);
  const sameProject = workspace?.path === task.projectPath;
  const peek = useAppStore((s) => s.peek);
  const peeking = peek !== null && peek.taskId === task.id;
  // ADR-0022 am.2: the live-preview column shares the peek's side slot.
  const previewing = useAppStore((s) => s.previewRailTaskId === task.id);

  // ADR-0009/0014: shared with the room-aware ⌘E toggle (PIVOT-006r).
  const openInEditor = (): void => openTaskInEditor(task);

  // Full-workspace escape hatch remains available, but the normal edit path is
  // now the resident Session pane opened by task-room-edit-file / FilePeek.
  const openFileInEditor = (path: string): void => {
    void editor.openFile(path);
    openInEditor();
  };

  return (
    <div className="tr-root" data-testid="task-room">
      <div className="tr-head">
        <div className="tr-head-drag" />
        <button className="tr-back" data-testid="task-room-back" onClick={app.closeTaskRoom}>
          <Ic name="chevron" size={13} className="tr-back-ic" />
          Sessions
        </button>
        <span className="tr-title" title={task.title}>
          {task.title}
        </span>
        {/* PIVOT-031: an answered task presents as such; data-state stays honest. */}
        <StateBadge
          state={task.state}
          {...(answered ? { label: 'Answered', tone: 'ok' as const } : {})}
        />
        <span className="tr-proj" data-testid="task-room-project" title={task.projectPath}>
          <Ic name="folder" size={11} />
          {task.projectName}
        </span>
        {task.worktree ? <WorktreeChip task={task} /> : null}
        <PreviewBadge task={task} />
        {task.external ? (
          <span
            className="tr-extchip"
            data-testid="task-room-external-chip"
            title="External CLI session — runs outside the Tool Gateway. Entry snapshot taken; changes tracked and reviewable."
          >
            EXT · {task.external.cli}
          </span>
        ) : null}
        <span className="tr-sp" />
        {running && !task.external ? (
          <button className="btn danger" data-testid="agent-stop" onClick={() => void store.stop()}>
            Stop
          </button>
        ) : null}
        {files[0] && sameProject && !task.worktree ? (
          <button
            className="ghostbtn"
            data-testid="task-room-edit-file"
            title={`Edit ${files[0]} beside this Session`}
            onClick={() => app.openPeek(task.id, files[0]!, 'edit')}
          >
            <Ic name="pencil" size={12} />
            Edit file
          </button>
        ) : null}
        <button
          className="ghostbtn"
          data-testid="replay-open"
          title={
            task.external
              ? 'Replay the observed terminal, file versions and structured provider events'
              : 'Replay what the agent did, step by step'
          }
          onClick={() => store.openReplay()}
        >
          <Ic name="play" size={12} />
          Replay
        </button>
        <button
          className="ghostbtn"
          data-testid="task-room-open-editor"
          title="Open the full workspace with this task's context"
          onClick={openInEditor}
        >
          <Ic name="layout" size={12} />
          Full workspace
        </button>
        {canArchiveTask(task) ? (
          <ConfirmDangerButton
            label="Archive…"
            confirmLabel="Confirm — archive"
            testid="task-archive"
            quiet
            title={
              isAnswered(task)
                ? 'Close out this answered task and hide it from the task list'
                : 'Hide this finished task from the task list'
            }
            onConfirm={() => void store.archiveTask(task.id)}
          />
        ) : null}
      </div>

      <div className={`tr-body ${peeking || previewing ? 'peeking' : ''}`}>
        <div className="tr-main">
          {task.external ? (
            /* ADR-0017: the conversation with an external agent IS its terminal —
               it takes the timeline+composer's place; everything else is the
               same room (rail, peek, review bar). */
            <ExternalTerminalColumn task={task} />
          ) : (
            <>
              {/* Mockup A (ADR-0014): mode/model/effort live in the composer foot. */}
              <RoomTimeline task={task} />
            </>
          )}
          {/* ADR-0016 (direction B): the completion report is STATE — a review
              bar docked above the composer while the decision is pending. */}
          {task.state === 'REVIEW_READY' && !answered ? <ReviewBar task={task} /> : null}
          {running && !task.external ? (
            <ActivityStrip taskId={task.id} taskText={`${task.title}\n${task.goalMd}`} />
          ) : null}
          {task.external ? null : <RoomComposer key={task.id} task={task} running={running} />}
        </div>

        {peeking ? (
          <FilePeek
            taskId={task.id}
            worktree={task.worktree !== null}
            editableInWorkspace={sameProject && task.worktree === null}
            onOpenInEditor={openFileInEditor}
          />
        ) : null}
        {previewing ? <RoomPreviewRail task={task} /> : null}
        {peeking || previewing ? (
          <button
            className="tr-rail-tab"
            data-testid="peek-rail-restore"
            title={
              previewing
                ? 'Close the preview and show the task rail'
                : 'Close the peek and show the task rail'
            }
            onClick={previewing ? app.closePreviewRail : app.closePeek}
          >
            Changes{files.length > 0 ? ` · ${files.length}` : ''}
          </button>
        ) : null}

        <aside className="tr-rail">
          {task.worktree?.missing ? (
            <div className="tr-note warn" data-testid="task-room-worktree-missing">
              The isolated worktree folder for this task no longer exists on disk (it was removed
              outside the app). Recorded changes and the timeline stay available; resuming the agent
              or merging files is not possible — archive or roll back to close out.
            </div>
          ) : null}
          {running ? (
            <>
              <h4 className="tr-rail-h">
                This task <span className="tr-livechip">LIVE</span>
              </h4>
              <LiveBoard
                taskId={task.id}
                variant="rail"
                // ADR-0014: in-room tiles open the resident peek, not the modal lens.
                onOpenLens={(path) => app.openPeek(task.id, path, 'diff')}
              />
            </>
          ) : null}

          <h4 className="tr-rail-h">
            Changes
            {files.length > 0 ? ` · ${files.length} file${files.length === 1 ? '' : 's'}` : ''}
          </h4>
          {files.length === 0 ? (
            <div className="tr-none">Nothing touched yet.</div>
          ) : (
            files.slice(-12).map((path) => (
              <button
                key={path}
                className="tr-frow"
                data-testid={`task-room-file-${path}`}
                title={`Peek at what changed in ${path} — the conversation stays put`}
                onClick={(e) => {
                  // PIVOT-035: plain click peeks; ⌘/alt-click is the explicit
                  // Editor jump (not offered for worktree tasks — the main tree
                  // does not contain those changes).
                  if ((e.metaKey || e.altKey || e.ctrlKey) && !task.worktree) {
                    void editor.openFile(path);
                    openInEditor();
                  } else {
                    app.openPeek(task.id, path, 'diff');
                  }
                }}
              >
                <Ic name="file" size={11} />
                <span className="tr-fpath">{path}</span>
                {task.external
                  ? (() => {
                      const f = externalFiles.find((x) => x.path === path);
                      return f ? (
                        <span className="tr-fstat">
                          <span className="tr-fadd">+{f.additions}</span>{' '}
                          <span className="tr-fdel">−{f.deletions}</span>
                        </span>
                      ) : null;
                    })()
                  : null}
                <span
                  className="tr-freplay"
                  role="button"
                  tabIndex={0}
                  data-testid={`task-room-file-replay-${path}`}
                  title="Replay this change — seek straight to the moment it happened"
                  onClick={(e) => {
                    e.stopPropagation();
                    store.openReplay({ taskId: task.id, anchor: { type: 'path', path } });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      store.openReplay({ taskId: task.id, anchor: { type: 'path', path } });
                    }
                  }}
                >
                  <Ic name="play" size={10} />
                </span>
              </button>
            ))
          )}

          <h4 className="tr-rail-h">Verification</h4>
          {verifications.length === 0 ? (
            <div className="tr-none">No verification runs yet.</div>
          ) : (
            verifications.map((v) => (
              <div key={v.label} className="tr-vrow">
                <span className="tr-fpath">{v.label}</span>
                <span className={`tr-vstate ${v.state === 'passed' ? 'ok' : 'bad'}`}>
                  {v.state === 'passed' ? '✓ passed' : v.state}
                </span>
              </div>
            ))
          )}

          <h4 className="tr-rail-h">Your decision</h4>
          <div className="tr-decision">
            {task.state === 'REVIEW_READY' && answered ? (
              <>
                <div className="tr-note" data-testid="task-room-answered">
                  {task.external
                    ? `The ${task.external.cli} session ended with no tracked file changes.`
                    : 'The agent answered — nothing changed on disk, so there is nothing to review.'}
                </div>
                {externalCanResume ? (
                  <button
                    className="btn primary tr-wide"
                    data-testid="task-resume"
                    disabled={externalResuming}
                    title={`Continue the previous ${task.external!.cli} conversation in its terminal`}
                    onClick={() => void store.resumeTask(task.id)}
                  >
                    {externalResuming
                      ? 'Resuming…'
                      : `Resume ${task.external!.cli === 'claude' ? 'Claude' : 'Codex'} session`}
                  </button>
                ) : null}
                <button
                  className="btn tr-wide"
                  data-testid="task-done"
                  title="Close out this task"
                  onClick={() => void store.acceptTask()}
                >
                  Done
                </button>
              </>
            ) : task.state === 'REVIEW_READY' ? (
              <>
                {externalCanResume ? (
                  <button
                    className="btn primary tr-wide"
                    data-testid="task-resume"
                    disabled={externalResuming}
                    title={`Continue the previous ${task.external!.cli} conversation in its terminal`}
                    onClick={() => void store.resumeTask(task.id)}
                  >
                    {externalResuming
                      ? 'Resuming…'
                      : `Resume ${task.external!.cli === 'claude' ? 'Claude' : 'Codex'} session`}
                  </button>
                ) : null}
                <button
                  className={`btn ${externalCanResume ? '' : 'primary'} tr-wide`}
                  data-testid="review-open"
                  onClick={() => void store.openReview()}
                >
                  Review changes
                </button>
                <div className="tr-note">
                  {task.worktree
                    ? 'This task ran in its own worktree. Accepting merges its changes back into the project.'
                    : 'Walk through each diff, then accept. A snapshot is kept — you can restore any time.'}
                </div>
                <hr />
                <ConfirmDangerButton
                  label={task.worktree ? 'Discard worktree…' : 'Roll back everything…'}
                  confirmLabel={task.worktree ? 'Confirm — discard' : 'Confirm — restore all files'}
                  testid="task-rollback"
                  quiet
                  title={
                    task.worktree
                      ? 'Throw away the isolated worktree; the project was never touched'
                      : 'Restore every touched file to its pre-task state'
                  }
                  onConfirm={() => void store.rollbackTask()}
                />
              </>
            ) : task.state === 'ACCEPTED' && !task.worktree ? (
              <>
                <div className="tr-note" data-testid="task-room-accepted">
                  {task.mode === 'full'
                    ? 'Completed & applied automatically (Full auto). Snapshots are kept — you can restore the pre-task state.'
                    : 'Accepted. Snapshots are kept — you can still restore the pre-task state.'}
                </div>
                <ConfirmDangerButton
                  label="Roll back…"
                  confirmLabel="Confirm — restore all files"
                  testid="task-rollback"
                  quiet
                  title="Restore every touched file to its pre-task state (drift-checked)"
                  onConfirm={() => void store.rollbackTask()}
                />
              </>
            ) : task.state === 'INTERRUPTED' || task.state === 'FAILED' ? (
              <>
                <button
                  className="btn primary tr-wide"
                  data-testid="task-resume"
                  disabled={externalResuming}
                  title={
                    externalCanResume
                      ? `Continue the previous ${task.external!.cli} conversation in its terminal`
                      : 'Start a new run for this task'
                  }
                  onClick={() => void store.resumeTask(task.id)}
                >
                  {externalResuming
                    ? 'Resuming…'
                    : externalCanResume
                      ? `Resume ${task.external!.cli === 'claude' ? 'Claude' : 'Codex'} session`
                      : 'Resume'}
                </button>
                <button
                  className="btn tr-wide"
                  data-testid="review-open"
                  title="Inspect what changed before deciding"
                  onClick={() => void store.openReview()}
                >
                  Review changes
                </button>
                <hr />
                <ConfirmDangerButton
                  label="Roll back…"
                  confirmLabel="Confirm — roll back"
                  testid="task-rollback"
                  quiet
                  title="Restore every touched file to its pre-task state"
                  onConfirm={() => void store.rollbackTask()}
                />
              </>
            ) : task.state === 'AWAITING_PLAN_APPROVAL' ? (
              <div className="tr-note">
                A plan is waiting for you in the timeline. Approve it, edit it — or type below to
                request changes.
              </div>
            ) : running && task.external ? (
              <div className="tr-note" data-testid="task-room-external-running">
                The session is live — talk to {task.external.cli} in its terminal. When it ends, the
                changes land here for review.
              </div>
            ) : running ? (
              <div className="tr-note">
                The agent is working. You'll be asked here when a plan, permission or review needs
                you.
              </div>
            ) : (
              <div className="tr-note">{presentedMeta(task).label}.</div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function actionLine(kind: string, label: string): string {
  void kind;
  return label.length > 90 ? `${label.slice(0, 87)}…` : label;
}

/**
 * Review bar (ADR-0016, direction B): the completion report presented as
 * state, docked above the composer while the task is REVIEW_READY. Headline
 * evidence + the primary Review action inline; agent summary and rollback in
 * the overflow. Disappears the moment the state moves on — like the plan gate.
 * Data source is the recorded `report.final` event (never the agent's word).
 */
function ReviewBar({
  task,
}: {
  task: {
    id: string;
    goalMd: string;
    worktree: { branch: string } | null;
    verification: Array<{ label: string }>;
  };
}): React.JSX.Element | null {
  const store = useTaskStore();
  const copy = roomCopyFor(task.goalMd);
  const [menuOpen, setMenuOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Latest recorded report for this task (loading → bar renders actions only).
  const report = useMemo(() => {
    for (let i = store.timeline.length - 1; i >= 0; i--) {
      const event = store.timeline[i]!;
      if (event.type === 'report.final') return event.payload as Record<string, unknown>;
    }
    return null;
  }, [store.timeline]);

  const changed = report?.changed as
    { files: number; additions: number; deletions: number } | undefined;
  const verification = report?.verification as
    | {
        runs: Array<{ label: string; state: string; stale?: boolean; superseded?: boolean }>;
        passed: number;
        failed: number;
      }
    | undefined;
  const unverified = report?.unverified === true;
  const risks = (report?.unresolvedRisks ?? []) as string[];
  const agentSummary = typeof report?.agentSummary === 'string' ? report.agentSummary : null;
  const superseded = verification?.runs.filter((r) => r.superseded).length ?? 0;
  const stale = verification?.runs.some((r) => r.stale) === true;
  const latestRuns = useMemo(() => {
    const byLabel = new Map<string, { label: string; state: string }>();
    for (const event of store.timeline) {
      if (event.type !== 'verification.completed') continue;
      const run = (event.payload as { run?: { label?: unknown; state?: unknown } }).run;
      if (run && typeof run.label === 'string') {
        byLabel.set(run.label, { label: run.label, state: String(run.state ?? '') });
      }
    }
    return [...byLabel.values()];
  }, [store.timeline]);
  const effectiveVerification =
    verification && verification.runs.length > 0
      ? verification
      : latestRuns.length > 0
        ? {
            runs: latestRuns,
            passed: latestRuns.filter((run) => run.state === 'passed').length,
            failed: latestRuns.filter((run) => run.state !== 'passed').length,
          }
        : verification;
  const effectivelyUnverified = unverified && latestRuns.length === 0;

  return (
    <div className="tr-reviewbar" data-testid="review-bar">
      <div className="tr-rb-main">
        <span className="tr-rb-dot" aria-hidden />
        <b>{copy.reviewReady}</b>
        {changed && changed.files > 0 ? (
          <span className="tr-rb-meta" data-testid="report-changed">
            {changed.files} file{changed.files === 1 ? '' : 's'}{' '}
            <span className="mono">
              <i className="plus">+{changed.additions}</i>{' '}
              <i className="minus">−{changed.deletions}</i>
            </span>
          </span>
        ) : null}
        {effectiveVerification && effectiveVerification.runs.length > 0 ? (
          <span className="tr-rb-meta" data-testid="report-verification">
            {copy.checks}: {effectiveVerification.passed} {copy.passed}
            {effectiveVerification.failed > 0
              ? `, ${effectiveVerification.failed} ${copy.failed}`
              : ''}
            {superseded > 0 ? ` · ${superseded} superseded${stale ? ' (stale)' : ''}` : ''}
          </span>
        ) : null}
        <span className="tr-rb-sp" />
        <button
          className="btn primary"
          data-testid="review-bar-open"
          onClick={() => void store.openReview()}
        >
          {copy.reviewChanges}
        </button>
        <button
          className="btn"
          data-testid="review-bar-accept"
          onClick={() => void store.acceptTask()}
        >
          {copy.accept}
        </button>
        <div className="tr-rb-morewrap" ref={menuRef}>
          <button
            className="tr-rb-more"
            data-testid="review-bar-more"
            title={`${copy.agentSummary} · ${task.worktree ? copy.discardWorktree : copy.rollbackAll}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="tr-rb-menu" data-testid="review-bar-menu" role="menu">
              {agentSummary ? (
                <button
                  className="tr-rb-menurow"
                  data-testid="review-bar-summary-toggle"
                  onClick={() => {
                    setSummaryOpen(!summaryOpen);
                    setMenuOpen(false);
                  }}
                >
                  {summaryOpen ? copy.hideAgentSummary : copy.agentSummary}
                </button>
              ) : null}
              <div className="tr-rb-menucap">{copy.evidenceNote}</div>
              <hr />
              <ConfirmDangerButton
                label={task.worktree ? copy.discardWorktree : copy.rollbackAll}
                confirmLabel={task.worktree ? 'Confirm — discard' : 'Confirm — roll back all'}
                testid="report-rollback"
                quiet
                title={
                  task.worktree
                    ? 'Throw away the isolated worktree; the project was never touched'
                    : 'Restore every touched file to its pre-task state'
                }
                onConfirm={() => void store.rollbackTask()}
              />
            </div>
          ) : null}
        </div>
      </div>
      {effectivelyUnverified ? (
        <div className="tr-rb-warn" data-testid="report-unverified">
          <span>
            {task.verification.length > 0
              ? copy.configuredChecksNotRun(task.verification.length)
              : copy.noVerification}
          </span>
          {task.verification.length > 0 ? (
            <button
              className="btn"
              data-testid="review-bar-run-verification"
              onClick={() => void store.runVerification()}
            >
              {copy.runChecks}
            </button>
          ) : null}
        </div>
      ) : null}
      {risks.length > 0 ? (
        <div className="tr-rb-warn">
          {copy.risks}: {risks.join('; ')}
        </div>
      ) : null}
      {summaryOpen && agentSummary ? (
        <div className="tr-rb-summary" data-testid="review-bar-summary">
          <div className="tr-rb-menucap">{copy.agentSummary}</div>
          <Markdown text={agentSummary} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Live activity strip (ADR-0011): what the agent is DOING right now — current
 * tool + target and elapsed time — usage totals live in the run-details fold.
 */
function ActivityStrip({
  taskId,
  taskText,
}: {
  taskId: string;
  taskText: string;
}): React.JSX.Element {
  const store = useTaskStore();
  const copy = roomCopyFor(taskText);
  const activity = useActivityStore((s) => s.perTask[taskId]);
  const streamingThinking = useTaskStore((s) => s.streamingThinking);
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const action = currentActionLine(activity);
  const current = activity?.current ?? null;
  const elapsed = current
    ? Math.max(0, Math.round((Date.now() - Date.parse(current.at)) / 1000))
    : null;

  const label = streamingThinking
    ? `${copy.thinking}…`
    : store.streaming
      ? copy.locale === 'zh'
        ? '正在回复…'
        : 'Writing a reply…'
      : action
        ? actionLine(action.kind, action.label)
        : copy.locale === 'zh'
          ? '处理中…'
          : 'Working…';

  return (
    <div className="tr-activity" data-testid="task-room-activity">
      <span className="tr-activity-dot" aria-hidden />
      <span className="tr-activity-label" data-testid="task-room-action">
        {label}
      </span>
      <span className="tr-activity-meta">
        {current && elapsed !== null && elapsed > 1 ? <span>{elapsed}s</span> : null}
      </span>
    </div>
  );
}

/** Worktree chip — branch identity + escape hatches (terminal / Finder). */
function WorktreeChip({
  task,
}: {
  task: { id: string; worktree: { branch: string; path: string; missing?: boolean } | null };
}): React.JSX.Element | null {
  const app = useAppStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const wt = task.worktree;
  if (!wt) return null;
  const missing = wt.missing === true;
  return (
    <div className="tr-wtchip" ref={ref}>
      <button
        className={`tr-proj tr-wtbtn ${missing ? 'warn' : ''}`}
        data-testid="task-room-worktree"
        title="This task runs in an isolated worktree — changes reach the project only when you accept"
        onClick={() => setOpen(!open)}
      >
        <Ic name="branch" size={11} />
        <span className="mono">{wt.branch}</span>
        {missing ? <span>· missing</span> : null}
        <Ic name="chevron" size={10} />
      </button>
      {open ? (
        <div className="tr-wtmenu" data-testid="worktree-menu">
          <div className="tr-wtmenu-cap">
            Isolated worktree — the agent works on a separate checkout; accepting merges the result
            into the project.
          </div>
          <button
            className="tr-wtmenu-row"
            data-testid="worktree-open-terminal"
            disabled={missing}
            onClick={() => {
              setOpen(false);
              void import('./TerminalPanel.js').then(({ useTerminalStore }) => {
                void useTerminalStore.getState().create({ taskId: task.id, title: wt.branch });
              });
              app.setSurface('workspace');
            }}
          >
            <Ic name="play" size={11} /> Open in terminal
          </button>
          <button
            className="tr-wtmenu-row"
            data-testid="worktree-reveal"
            disabled={missing}
            onClick={() => {
              setOpen(false);
              void rpcResult('app.revealPath', { path: wt.path });
            }}
          >
            <Ic name="folder" size={11} /> Reveal in Finder
          </button>
          {missing ? (
            <div className="tr-wtmenu-cap warn">The worktree folder no longer exists on disk.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Room reply — plan-aware: while a plan awaits approval, typing here IS
 * "Request changes" (ADR-0009; no extra button). On a closed task (accepted /
 * rolled back / cancelled) a reply starts a FOLLOW-UP task in the same project
 * — closed tasks cannot restart (§6.1). The follow-up gets the SAME composer
 * chrome as Home (project chip, @-attach, trust level, merged model·effort),
 * seeded from the finished task but fully editable, since it really is a new
 * task. Mid-run / plan-awaiting states keep the bare reply pill — there is no
 * mode or model to re-pick on a task that is already running. */
function RoomComposer({
  task,
  running,
}: {
  task: {
    id: string;
    state: string;
    title: string;
    projectPath: string;
    projectName: string;
    mode: 'ask' | 'edit' | 'auto' | 'full';
    model: {
      providerId: string;
      modelId: string;
      thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    };
  };
  running: boolean;
}): React.JSX.Element {
  const store = useTaskStore();
  const app = useAppStore();
  const workspacePath = useWorkspaceStore((s) => s.workspace?.path);
  // PIVOT-036: the draft is per-task, session-scoped and shared with the
  // Editor agent panel — it survives ⌘E round-trips.
  const input = useDraftStore((s) => s.drafts[task.id] ?? '');
  const terminalRefs = useDraftStore((s) => s.terminalRefs[task.id] ?? EMPTY_TERMINAL_REFS);
  // ADR-0022 am.2: a picked element / drawn region waiting to ride this reply.
  const previewRef = useDraftStore((s) => s.previewRefs[task.id] ?? null);
  const setInput = (text: string): void => useDraftStore.getState().setDraft(task.id, text);
  const [dropActive, setDropActive] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composerFocusSeq = useAppStore((s) => s.composerFocusSeq);
  const planOpen = task.state === 'AWAITING_PLAN_APPROVAL';
  const closed = ['ACCEPTED', 'ROLLED_BACK', 'CANCELLED', 'ARCHIVED'].includes(task.state);

  // A follow-up is a NEW task: its own mode / model / effort, seeded from the
  // finished task but freely editable (state reseeds per task via key=).
  const configuredModels = useMemo(() => store.models.filter((m) => m.configured), [store.models]);
  const [mode, setMode] = useState(task.mode);
  const [modelKey, setModelKey] = useState(`${task.model.providerId}::${task.model.modelId}`);
  const [thinking, setThinking] = useState<ThinkingLevelId>(task.model.thinkingLevel ?? 'medium');
  // ADR-0016: a reply may override the task's model/effort for the next turn.
  // Only a touched control sends an override — untouched replies stay silent.
  const [modelDirty, setModelDirty] = useState(false);
  const sameProject = workspacePath === task.projectPath;

  useEffect(() => {
    if (composerFocusSeq > 0) ref.current?.focus();
  }, [composerFocusSeq]);

  // @ file picker (only meaningful when the task's project is the focused one —
  // search.files is scoped to the focused workspace).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerItems, setPickerItems] = useState<string[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);
  const pickerInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const handle = setTimeout(() => {
      void rpcResult('search.files', { query: pickerQuery }).then((res) => {
        if (res.ok) {
          setPickerItems(res.data.items.slice(0, 12).map((i) => i.path));
          setPickerIndex(0);
        }
      });
    }, 80);
    return () => clearTimeout(handle);
  }, [pickerOpen, pickerQuery]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest('.hm-menu') && !t.closest('[data-testid="room-attach"]')) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pickerOpen]);

  const startFollowUp = async (text: string): Promise<void> => {
    const [providerId, modelId] = modelKey.split('::');
    if (!providerId || !modelId) {
      app.pushToast('warning', 'No model available — add a provider key in Settings.');
      return;
    }
    // ADR-0022 am.2: a preview selection made after the task closed seeds the
    // follow-up — the screenshot rides the new task's first run.
    const seed = previewRef;
    const goal = seed ? buildPreviewFeedbackText(seed, text) : text;
    const ok = await store.createAndStart({
      title: titleFromIntent(
        text || (seed?.selector ? `Fix ${seed.selector}` : 'Preview feedback'),
      ),
      goalMd: goal,
      acceptance: [],
      mode,
      model: { providerId, modelId, thinkingLevel: thinking },
      projectPath: task.projectPath,
      isolation: 'none',
      // Carry the prior task as structured context instead of appending a
      // system-authored sentence to the user's visible message.
      conversationRefTaskIds: [task.id],
      ...(seed?.dataBase64
        ? {
            preview: {
              dataBase64: seed.dataBase64,
              mimeType: 'image/png' as const,
              pageUrl: seed.pageUrl,
              rect: seed.rect,
              ...(seed.selector ? { selector: seed.selector } : {}),
              ...(text.trim() ? { note: text.trim() } : {}),
            },
          }
        : {}),
    });
    if (ok) {
      useDraftStore.getState().clearPreviewRef(task.id);
      const newId = useTaskStore.getState().activeTaskId;
      if (newId) app.openTaskRoom(newId);
    }
  };

  const send = (): void => {
    const typed = input.trim();
    const terminalContext = terminalRefs
      .map(
        (terminalRef) =>
          `终端输出引用：${terminalRef.contextLabel} · ${terminalRef.cwd}\n\n\`\`\`text\n${terminalRef.text}\n\`\`\``,
      )
      .join('\n\n');
    const text = [typed, terminalContext].filter(Boolean).join('\n\n');
    if (!text && !previewRef) return;
    if (planOpen) {
      void store.decidePlan({ decision: 'request_changes', reason: text || 'See the attachment.' });
    } else if (closed) {
      void startFollowUp(text);
    } else if (previewRef) {
      // ADR-0022 am.2: the reply carries the preview selection — same steer
      // loop, one conversation; the model sees the screenshot.
      const structured = buildPreviewFeedbackText(previewRef, text);
      if (previewRef.dataBase64) {
        void store.sendPreviewFeedback(structured, {
          dataBase64: previewRef.dataBase64,
          mimeType: 'image/png',
          pageUrl: previewRef.pageUrl,
          rect: previewRef.rect,
          ...(previewRef.selector ? { selector: previewRef.selector } : {}),
          ...(text.trim() ? { note: text.trim() } : {}),
        });
      } else {
        void store.send(`${structured}\n(Screenshot capture failed — none attached.)`, 'steer');
      }
      useDraftStore.getState().clearPreviewRef(task.id);
    } else {
      const [providerId, modelId] = modelKey.split('::');
      const override =
        modelDirty && providerId && modelId
          ? { providerId, modelId, thinkingLevel: thinking }
          : undefined;
      void store.send(text, 'steer', override);
      setModelDirty(false);
    }
    setInput('');
    useDraftStore.getState().clearTerminalRefs(task.id);
  };

  // Sidebar tree drag / picker → inline "@path" at the caret (context feeding;
  // the reply is plain text, so refs travel inside the message itself).
  const insertRef = (rel: string): void => {
    const el = ref.current;
    const token = `@${rel}`;
    const start = el?.selectionStart ?? input.length;
    const end = el?.selectionEnd ?? input.length;
    const before = input.slice(0, start);
    const after = input.slice(end);
    const sep = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const caret = start + sep.length + token.length + 1;
    setInput(`${before}${sep}${token} ${after}`);
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    }, 0);
  };

  const pickFile = (path: string): void => {
    setPickerOpen(false);
    insertRef(path);
  };

  const dragHandlers = {
    onDragOver: (e: React.DragEvent): void => {
      if (!hasDragRef(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDropActive(true);
    },
    onDragLeave: (): void => setDropActive(false),
    onDrop: (e: React.DragEvent): void => {
      const rel = readDragRef(e);
      if (!rel) return;
      e.preventDefault();
      setDropActive(false);
      insertRef(rel);
    },
  };

  const placeholder = planOpen
    ? 'Request changes to the plan — the agent will revise it…'
    : running
      ? 'Reply — steer the agent or add context…'
      : closed
        ? 'Follow up — starts a new task in this project…'
        : 'Reply — starts a new run…';

  // "/" in the empty reply → enabled-skills picker (ADR-0015); works for
  // steers, new runs and follow-ups alike (expansion happens product-side).
  const slash = useSkillSlash({
    value: input,
    setValue: setInput,
    testid: 'room',
    focus: () => ref.current?.focus(),
  });

  const textarea = (className: string): React.JSX.Element => (
    <textarea
      ref={ref}
      className={className}
      data-testid="agent-input"
      rows={1}
      placeholder={placeholder}
      value={input}
      onChange={(e) => {
        setInput(e.target.value);
        slash.handleChange(e.target.value);
      }}
      onKeyDown={(e) => {
        if (slash.handleKeyDown(e)) {
          e.preventDefault();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      }}
    />
  );

  const sendButton = (
    <button
      className={`hm-send ${input.trim() || terminalRefs.length > 0 || previewRef ? 'ready' : ''}`}
      data-testid="agent-send"
      disabled={!input.trim() && terminalRefs.length === 0 && !previewRef}
      aria-label={planOpen ? 'Request plan changes' : 'Send'}
      onClick={send}
    >
      <Ic name="arrowUp" size={15} strokeWidth={2} />
    </button>
  );

  // ADR-0022 am.2: the pending preview selection as a composer attachment chip.
  const previewChip = previewRef ? (
    <div className="tr-preview-ref" data-testid="room-preview-ref">
      {previewRef.thumbDataUrl ? (
        <img src={previewRef.thumbDataUrl} alt="Preview selection" />
      ) : null}
      <span className="tr-preview-ref-meta">
        <span className="mono">{previewRef.selector ?? 'region'}</span>
        <span className="tr-preview-ref-dim">
          {previewRef.rect.width}×{previewRef.rect.height} · {previewRef.pageUrl}
        </span>
      </span>
      <button
        className="tr-preview-ref-x"
        data-testid="room-preview-ref-remove"
        aria-label="Remove the preview attachment"
        onClick={() => useDraftStore.getState().clearPreviewRef(task.id)}
      >
        ✕
      </button>
    </div>
  ) : null;

  const terminalRefChips =
    terminalRefs.length > 0 ? (
      <div className="tr-terminal-refs" data-testid="room-terminal-refs">
        {terminalRefs.map((terminalRef) => (
          <span key={terminalRef.id} className="tr-terminal-ref">
            <Ic name="terminal" size={12} />
            <span>
              {terminalRef.title} · {terminalRef.contextLabel}
            </span>
            <button
              aria-label={`移除 ${terminalRef.title}`}
              onClick={() => useDraftStore.getState().removeTerminalRef(task.id, terminalRef.id)}
            >
              <Ic name="x" size={11} />
            </button>
          </span>
        ))}
      </div>
    ) : null;

  // Mid-run / plan-awaiting: the mockup-A reply card (ADR-0014) — textarea on
  // top, trust level (fixed for the session) and the model·effort control in
  // the foot. ADR-0016: replies can re-pick model/effort for the next turn;
  // a plan-change reply revises within the current turn, so it keeps the
  // read-only meta (the override rides on task.message only).
  if (!closed) {
    return (
      <div
        className={`tr-composer ${dropActive ? 'drop' : ''}`}
        data-testid="room-composer"
        {...dragHandlers}
      >
        <div className="tr-ccard">
          {previewChip}
          {terminalRefChips}
          {textarea('tr-cinput')}
          {slash.menu}
          <div className="tr-cfoot">
            <span className="tr-mode" title="The trust level is fixed for this task's session">
              {modeLabel(task.mode)}
            </span>
            <span className="tr-rb-sp" />
            {planOpen ? (
              <span className="tr-mode" title="A plan-change reply revises within the current turn">
                {task.model.providerId}/{task.model.modelId}
                {task.model.thinkingLevel ? ` · effort ${task.model.thinkingLevel}` : ''}
              </span>
            ) : (
              <ModelEffortControl
                models={configuredModels}
                modelKey={modelKey}
                onModelKey={(key) => {
                  setModelKey(key);
                  setModelDirty(true);
                }}
                thinking={thinking}
                onThinking={(level) => {
                  setThinking(level);
                  setModelDirty(true);
                }}
                onConfigureModels={() => app.openSettings('models')}
                testid="reply"
              />
            )}
            {sendButton}
          </div>
        </div>
      </div>
    );
  }

  // Closed → follow-up: full composer parity with Home.
  return (
    <div
      className={`tr-composer follow ${dropActive ? 'drop' : ''}`}
      data-testid="room-composer"
      {...dragHandlers}
    >
      <div className="tr-fcard">
        <div className="hm-card">
          {previewChip}
          {terminalRefChips}
          <div className="hm-chiprow">
            <span
              className="hm-chip"
              style={{ cursor: 'default' }}
              title={task.projectPath}
              data-testid="room-project"
            >
              <Ic name="folder" size={14} />
              <span>{task.projectName}</span>
            </span>

            {pickerOpen ? (
              <div className="hm-menu" data-testid="room-file-picker">
                <input
                  ref={pickerInputRef}
                  data-testid="room-file-input"
                  placeholder="Reference a project file…"
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setPickerOpen(false);
                      ref.current?.focus();
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setPickerIndex(Math.min(pickerIndex + 1, pickerItems.length - 1));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setPickerIndex(Math.max(pickerIndex - 1, 0));
                    } else if (e.key === 'Enter' && pickerItems[pickerIndex]) {
                      e.preventDefault();
                      pickFile(pickerItems[pickerIndex]!);
                    }
                  }}
                />
                {pickerItems.map((path, i) => (
                  <button
                    key={path}
                    className={`hm-row ${i === pickerIndex ? 'active' : ''}`}
                    data-testid={`room-file-item-${path}`}
                    onClick={() => pickFile(path)}
                  >
                    <Ic name="file" size={13} />
                    <span className="hm-tt">{path}</span>
                  </button>
                ))}
                {pickerItems.length === 0 ? (
                  <div className="hm-sec" style={{ padding: '8px 10px' }}>
                    Type to search files in {task.projectName}.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {textarea('hm-ta tr-fta')}
          {slash.menu}

          <div className="hm-btmrow">
            <button
              className="hm-iconbtn"
              data-testid="room-attach"
              disabled={!sameProject}
              title={
                sameProject
                  ? 'Attach project files (or drop them here)'
                  : 'Open this project to attach files by name'
              }
              onClick={() => {
                if (!sameProject) return;
                setPickerOpen((v) => !v);
                setPickerQuery('');
                setPickerItems([]);
                setTimeout(() => pickerInputRef.current?.focus(), 0);
              }}
            >
              <Ic name="at" size={15} />
            </button>
            <div
              className="hm-seg"
              data-testid="room-mode"
              data-mode={mode}
              role="radiogroup"
              aria-label="Trust level"
            >
              {MODE_META.map((m) => (
                <button
                  key={m.id}
                  className={`${mode === m.id ? 'on' : ''} ${m.danger ? 'danger' : ''}`}
                  data-testid={`room-mode-${m.id}`}
                  role="radio"
                  aria-checked={mode === m.id}
                  title={`${m.label} — ${m.hint}`}
                  onClick={() => setMode(m.id)}
                >
                  {m.seg}
                </button>
              ))}
            </div>
            <span className="hm-spacer" />
            <ModelEffortControl
              models={configuredModels}
              modelKey={modelKey}
              onModelKey={setModelKey}
              thinking={thinking}
              onThinking={setThinking}
              onConfigureModels={() => app.openSettings('models')}
              testid="room"
            />
            {sendButton}
          </div>
        </div>
        <div className="tr-fhint">
          Follow-up — a new task in <b>{task.projectName}</b>, seeded from this one. ⏎ to start.
        </div>
      </div>
    </div>
  );
}
