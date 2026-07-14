import React, { useEffect, useMemo, useRef, useState } from 'react';
import { rpcResult } from '../bridge.js';
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
import { canArchiveTask, isAnswered, modeLabel, presentedMeta } from './labels.js';

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

      <div className="tr-body">
        <div className="tr-main">
          <div className="tr-mode text-muted">
            <span className="tr-mode-fixed">
              {modeLabel(task.mode)} · {task.model.providerId}/{task.model.modelId}
              {task.model.thinkingLevel ? ` · effort ${task.model.thinkingLevel}` : ''}
            </span>
          </div>
          <RoomTimeline task={task} />
          {running ? <ActivityStrip taskId={task.id} /> : null}
          <RoomComposer task={task} running={running} />
        </div>

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
                title={
                  task.worktree
                    ? `Show what changed in ${path} (the file lives in the task's worktree)`
                    : `Open ${path} in the editor`
                }
                onClick={() => {
                  // Worktree tasks: the main tree does NOT have these changes —
                  // open the honest diff-so-far lens instead of the untouched file.
                  if (task.worktree) {
                    app.setLens({ taskId: task.id, path });
                  } else {
                    void editor.openFile(path);
                    openInEditor();
                  }
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

/**
 * Live activity strip (ADR-0011): what the agent is DOING right now — current
 * tool + target, elapsed time and token spend — replacing the bare "Working".
 */
function ActivityStrip({ taskId }: { taskId: string }): React.JSX.Element {
  const store = useTaskStore();
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

  // Token spend so far: sum the recorded usage events for this task.
  const tokens = useMemo(() => {
    let input = 0;
    let output = 0;
    for (const event of store.timeline) {
      if (event.type !== 'agent.usage') continue;
      const usage = (event.payload as { usage?: { inputTokens?: number; outputTokens?: number } })
        .usage;
      input += usage?.inputTokens ?? 0;
      output += usage?.outputTokens ?? 0;
    }
    return { input, output };
  }, [store.timeline]);

  const label = streamingThinking
    ? 'Thinking…'
    : store.streaming
      ? 'Writing a reply…'
      : action
        ? actionLine(action.kind, action.label)
        : 'Working…';

  const fmt = (n: number): string =>
    n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

  return (
    <div className="tr-activity" data-testid="task-room-activity">
      <span className="tr-activity-dot" aria-hidden />
      <span className="tr-activity-label" data-testid="task-room-action">
        {label}
      </span>
      <span className="tr-activity-meta">
        {current && elapsed !== null && elapsed > 1 ? <span>{elapsed}s</span> : null}
        {tokens.input + tokens.output > 0 ? (
          <span title="Tokens so far (in · out)">
            ↑{fmt(tokens.input)} ↓{fmt(tokens.output)}
          </span>
        ) : null}
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
