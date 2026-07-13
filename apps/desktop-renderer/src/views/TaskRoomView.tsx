import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTaskStore, RUNNING_TASK_STATES } from '../store/taskStore.js';
import { useActivityStore, currentActionLine } from '../store/activityStore.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { StateBadge } from './AgentPanel.js';
import { RoomTimeline } from './RoomTimeline.js';
import { LiveBoard } from './LiveBoard.js';
import { ConfirmDangerButton } from './ui.js';
import { Ic } from './home-icons.js';
import { isAnswered, modeLabel, presentedMeta } from './labels.js';

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
  const activity = useActivityStore((s) => (taskId ? s.perTask[taskId] : undefined));

  useEffect(() => {
    store.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            Home
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
  const action = currentActionLine(activity);
  const files = activity?.filesTouched ?? [];
  const sameProject = workspace?.path === task.projectPath;

  const openInEditor = (): void => {
    // ADR-0009: the room may belong to a non-focused project — focus it first.
    const go = (): void => {
      app.setLayout({ agentPanelVisible: true });
      app.setSurface('workspace');
    };
    if (!sameProject) {
      app.setHomePick(true);
      void workspaceStore.openPath(task.projectPath).then(go);
    } else {
      go();
    }
  };

  return (
    <div className="tr-root" data-testid="task-room">
      <div className="tr-head">
        <div className="tr-head-drag" />
        <button className="tr-back" data-testid="task-room-back" onClick={app.closeTaskRoom}>
          <Ic name="chevron" size={13} className="tr-back-ic" />
          Home
        </button>
        <span className="tr-title" title={task.title}>
          {task.title}
        </span>
        <StateBadge state={task.state} />
        <span className="tr-proj" data-testid="task-room-project" title={task.projectPath}>
          <Ic name="folder" size={11} />
          {task.projectName}
          {task.worktree ? (
            <>
              <span className="tr-proj-sep">·</span>
              <Ic name="branch" size={11} />
              <span className="mono">{task.worktree.branch}</span>
            </>
          ) : null}
        </span>
        <span className="tr-sp" />
        {running ? (
          <button className="btn danger" data-testid="agent-stop" onClick={() => void store.stop()}>
            Stop
          </button>
        ) : null}
        <button
          className="ghostbtn"
          data-testid="replay-open"
          title="Replay what the agent did, step by step"
          onClick={() => store.openReplay()}
        >
          <Ic name="play" size={12} />
          Replay
        </button>
        <button
          className="ghostbtn"
          data-testid="task-room-open-editor"
          title="Open the full editor with this task's context"
          onClick={openInEditor}
        >
          <Ic name="layout" size={12} />
          Open in editor
        </button>
      </div>

      <div className="tr-body">
        <div className="tr-main">
          <div className="tr-mode text-muted">
            <span className="tr-mode-fixed">
              {modeLabel(task.mode)} · {task.model.providerId}/{task.model.modelId}
            </span>
            {action && running ? (
              <span className="tr-action" data-testid="task-room-action">
                — {actionLine(action.kind, action.label)}
              </span>
            ) : null}
          </div>
          <RoomTimeline task={task} />
          <RoomComposer task={task} running={running} />
        </div>

        <aside className="tr-rail">
          {running ? (
            <>
              <h4 className="tr-rail-h">
                This task <span className="tr-livechip">LIVE</span>
              </h4>
              <LiveBoard
                taskId={task.id}
                variant="rail"
                onOpenLens={(path) => app.setLens({ taskId: task.id, path })}
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
                title={`Open ${path} in the editor`}
                onClick={() => {
                  void editor.openFile(path);
                  openInEditor();
                }}
              >
                <Ic name="file" size={11} />
                <span className="tr-fpath">{path}</span>
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
                  The agent answered — nothing changed on disk, so there is nothing to review.
                </div>
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
                <button
                  className="btn primary tr-wide"
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
            ) : task.state === 'INTERRUPTED' || task.state === 'FAILED' ? (
              <>
                <button
                  className="btn primary tr-wide"
                  data-testid="task-resume"
                  title="Start a new run for this task"
                  onClick={() => void store.resumeTask()}
                >
                  Resume
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

/** Room reply pill — plan-aware: while a plan awaits approval, typing here IS
 * "Request changes" (ADR-0009; no extra button). */
function RoomComposer({
  task,
  running,
}: {
  task: { id: string; state: string };
  running: boolean;
}): React.JSX.Element {
  const store = useTaskStore();
  const [input, setInput] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const planOpen = task.state === 'AWAITING_PLAN_APPROVAL';

  const send = (): void => {
    const text = input.trim();
    if (!text) return;
    if (planOpen) {
      void store.decidePlan({ decision: 'request_changes', reason: text });
    } else {
      void store.send(text, 'steer');
    }
    setInput('');
  };

  return (
    <div className="tr-composer">
      <textarea
        ref={ref}
        className="tr-input"
        data-testid="agent-input"
        rows={1}
        placeholder={
          planOpen
            ? 'Request changes to the plan — the agent will revise it…'
            : running
              ? 'Reply — steer the agent or add context…'
              : 'Reply — starts a new run…'
        }
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button
        className={`hm-send ${input.trim() ? 'ready' : ''}`}
        data-testid="agent-send"
        disabled={!input.trim()}
        aria-label={planOpen ? 'Request plan changes' : 'Send'}
        onClick={send}
      >
        <Ic name="arrowUp" size={15} strokeWidth={2} />
      </button>
    </div>
  );
}
