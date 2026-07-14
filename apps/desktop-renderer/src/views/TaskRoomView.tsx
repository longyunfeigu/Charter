import React, { useEffect, useMemo, useRef, useState } from 'react';
import { rpcResult } from '../bridge.js';
import { useTaskStore, RUNNING_TASK_STATES, titleFromIntent } from '../store/taskStore.js';
import { useActivityStore, currentActionLine } from '../store/activityStore.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { StateBadge } from './AgentPanel.js';
import { RoomTimeline } from './RoomTimeline.js';
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
import { useDraftStore } from '../store/draftStore.js';
import { openTaskInEditor } from './openInEditor.js';

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
  const peek = useAppStore((s) => s.peek);
  const peeking = peek !== null && peek.taskId === task.id;

  // ADR-0009/0014: shared with the room-aware ⌘E toggle (PIVOT-006r).
  const openInEditor = (): void => openTaskInEditor(task);

  // Peek escape hatch (PIVOT-035): the ONLY plain-click path to the Editor.
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

      <div className={`tr-body ${peeking ? 'peeking' : ''}`}>
        <div className="tr-main">
          {/* Mockup A (ADR-0014): mode/model/effort live in the composer foot. */}
          <RoomTimeline task={task} />
          {running ? <ActivityStrip taskId={task.id} /> : null}
          <RoomComposer key={task.id} task={task} running={running} />
        </div>

        {peeking ? (
          <FilePeek
            taskId={task.id}
            worktree={task.worktree !== null}
            onOpenInEditor={openFileInEditor}
          />
        ) : null}
        {peeking ? (
          <button
            className="tr-rail-tab"
            data-testid="peek-rail-restore"
            title="Close the peek and show the task rail"
            onClick={app.closePeek}
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
  const setInput = (text: string): void => useDraftStore.getState().setDraft(task.id, text);
  const [dropActive, setDropActive] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const planOpen = task.state === 'AWAITING_PLAN_APPROVAL';
  const closed = ['ACCEPTED', 'ROLLED_BACK', 'CANCELLED', 'ARCHIVED'].includes(task.state);

  // A follow-up is a NEW task: its own mode / model / effort, seeded from the
  // finished task but freely editable (state reseeds per task via key=).
  const configuredModels = useMemo(() => store.models.filter((m) => m.configured), [store.models]);
  const [mode, setMode] = useState(task.mode);
  const [modelKey, setModelKey] = useState(`${task.model.providerId}::${task.model.modelId}`);
  const [thinking, setThinking] = useState<ThinkingLevelId>(task.model.thinkingLevel ?? 'medium');
  const sameProject = workspacePath === task.projectPath;

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
    const ok = await store.createAndStart({
      title: titleFromIntent(text),
      goalMd: `${text}\n\n(Follow-up to “${task.title}” — that task's changes are already applied in this project.)`,
      acceptance: [],
      mode,
      model: { providerId, modelId, thinkingLevel: thinking },
      projectPath: task.projectPath,
      isolation: 'none',
    });
    if (ok) {
      const newId = useTaskStore.getState().activeTaskId;
      if (newId) app.openTaskRoom(newId);
    }
  };

  const send = (): void => {
    const text = input.trim();
    if (!text) return;
    if (planOpen) {
      void store.decidePlan({ decision: 'request_changes', reason: text });
    } else if (closed) {
      void startFollowUp(text);
    } else {
      void store.send(text, 'steer');
    }
    setInput('');
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
      className={`hm-send ${input.trim() ? 'ready' : ''}`}
      data-testid="agent-send"
      disabled={!input.trim()}
      aria-label={planOpen ? 'Request plan changes' : 'Send'}
      onClick={send}
    >
      <Ic name="arrowUp" size={15} strokeWidth={2} />
    </button>
  );

  // Mid-run / plan-awaiting: the mockup-A reply card (ADR-0014) — textarea on
  // top, a quiet mode·model·effort foot and the round send button below.
  // Nothing to re-pick on a running task, so the meta is read-only here.
  if (!closed) {
    return (
      <div
        className={`tr-composer ${dropActive ? 'drop' : ''}`}
        data-testid="room-composer"
        {...dragHandlers}
      >
        <div className="tr-ccard">
          {textarea('tr-cinput')}
          {slash.menu}
          <div className="tr-cfoot">
            <span className="tr-mode" title="This task's trust level, model and reasoning effort">
              {modeLabel(task.mode)} · {task.model.providerId}/{task.model.modelId}
              {task.model.thinkingLevel ? ` · effort ${task.model.thinkingLevel}` : ''}
            </span>
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
