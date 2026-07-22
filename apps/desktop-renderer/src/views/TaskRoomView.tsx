import type { AgentMode } from '@pi-ide/agent-contract';
import type { PermissionCardDto } from '@pi-ide/ipc-contracts';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { rpcResult } from '../bridge.js';
import { useTaskStore, RUNNING_TASK_STATES, titleFromIntent } from '../store/taskStore.js';
import { useActivityStore, currentActionLine } from '../store/activityStore.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { PermissionCard, StateBadge } from './AgentPanel.js';
import { RoomTimeline } from './RoomTimeline.js';
import { DistillCards } from './DistillCards.js';
import { ConfirmDangerButton, ModelEffortControl } from './ui.js';
import { Ic } from './home-icons.js';
import {
  MODE_META,
  type ThinkingLevelId,
  canArchiveTask,
  isAnswered,
  modeLabel,
} from './labels.js';
import { hasDragRef } from './dragRefs.js';
import { useSkillSlash } from './SkillSlashPicker.js';
import {
  EMPTY_CODE_CONTEXT_REFS,
  EMPTY_FILE_REFS,
  useDraftStore,
  type TerminalOutputRef,
} from '../store/draftStore.js';
import { FileContextAttachments } from './FileContextAttachments.js';
import {
  addFileRefWithToast,
  handleComposerPaste,
  handleRoomDrop,
  refFromRel,
} from './roomFileRefs.js';
import { PreviewBadge } from './RoomPreviewRail.js';
import { buildPreviewFeedbackText } from './LivePreview.js';
import { ExternalTerminalColumn, useExternalFiles } from './ExternalRoom.js';
import { roomCopyFor } from './roomCopy.js';
import { SessionToolCanvas, type SessionFileStat } from './SessionToolCanvas.js';
import { SessionSplitHandle } from './SessionSplitHandle.js';
import { CodeContextAttachments } from './CodeContextAttachments.js';
import { sessionDisplayTitle } from '../store/sessionAttention.js';
import { OrchestrationFleet, OrchestrationWorkerBand } from './OrchestrationFleet.js';
import { useOrchestrationStore } from '../store/orchestrationStore.js';

const EMPTY_TERMINAL_REFS: TerminalOutputRef[] = [];
const EMPTY_ORCHESTRATION_PERMISSIONS: PermissionCardDto[] = [];

function sessionAgentLabel(task: {
  external?: { cli: string } | null;
  model: { providerId: string };
}): string {
  if (task.external) {
    if (task.external.cli === 'claude') return 'Claude';
    if (task.external.cli === 'codex') return 'Codex';
    return task.external.cli;
  }
  return task.model.providerId === 'mock' ? 'Charter' : task.model.providerId;
}

/**
 * Session Canvas (ADR-0008/0009, PIVOT-021/028): the collaboration ledger rendered in
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
  const sessionRoomView = useAppStore((s) => s.sessionRoomView);
  const task = store.tasks.find((t) => t.id === taskId) ?? null;
  const activity = useActivityStore((s) => (taskId ? s.perTask[taskId] : undefined));
  const orchestration = useOrchestrationStore((state) => state.snapshot);
  const orchestrationPermissions = useOrchestrationStore((state) =>
    taskId
      ? (state.permissions[taskId] ?? EMPTY_ORCHESTRATION_PERMISSIONS)
      : EMPTY_ORCHESTRATION_PERMISSIONS,
  );
  const commanderWorkers = useMemo(
    () =>
      taskId ? orchestration.workers.filter((worker) => worker.commanderTaskId === taskId) : [],
    [orchestration.workers, taskId],
  );
  const workerRoom = taskId
    ? orchestration.workers.some((worker) => worker.taskId === taskId)
    : false;
  const fleetAvailable = orchestration.enabled && commanderWorkers.length > 0 && !workerRoom;
  const orchestrationNeeds =
    orchestrationPermissions.length +
    commanderWorkers.filter((worker) => worker.status === 'failed').length;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const canvasBodyRef = useRef<HTMLDivElement>(null);
  // ADR-0024: the whole Session room is one drop target for context feeding.
  const [roomDrop, setRoomDrop] = useState(false);

  // Hydrate this Session's remembered split before first paint.
  React.useLayoutEffect(() => {
    if (taskId) useAppStore.getState().ensureSessionSplit(taskId);
  }, [taskId]);

  // Resting split sync — lives here (not in SessionSplitHandle) because this
  // component owns the container ref: a child's layout effect would run before
  // the parent host ref is attached on mount, losing the remembered ratio.
  const manualSplit = useAppStore((s) => (taskId ? s.sessionSplit[taskId] : undefined));
  React.useLayoutEffect(() => {
    const el = canvasBodyRef.current;
    if (!el) return;
    if (manualSplit !== undefined) el.style.setProperty('--session-split', `${manualSplit}%`);
    else el.style.removeProperty('--session-split');
  }, [manualSplit, taskId]);

  useEffect(() => {
    store.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    useOrchestrationStore.getState().init();
  }, []);

  useEffect(() => {
    if (!taskId) return;
    const orchestrationStore = useOrchestrationStore.getState();
    orchestrationStore.trackTask(taskId);
    return () => orchestrationStore.untrackTask(taskId);
  }, [taskId]);

  useEffect(() => {
    if (sessionRoomView === 'fleet' && !fleetAvailable) app.setSessionRoomView('conversation');
  }, [app, fleetAvailable, sessionRoomView]);

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
          <div>This Session is not available anymore.</div>
        </div>
      </div>
    );
  }

  const running = RUNNING_TASK_STATES.has(task.state);
  const answered = isAnswered(task);
  // ADR-0017: an external session's rail is fed by watcher accounting, not by
  // agent tool events (there are none). Same rows, same peek behavior.
  const externalFiles = useExternalFiles(task);
  const files = task.external
    ? externalFiles.filter((f) => f.status !== 'deleted').map((f) => f.path)
    : (activity?.filesTouched ?? []);
  const sameProject = workspace?.path === task.projectPath;
  const fileStats = useMemo<Record<string, SessionFileStat>>(() => {
    const stats: Record<string, SessionFileStat> = {};
    for (const file of externalFiles) {
      stats[file.path] = { additions: file.additions, deletions: file.deletions };
    }
    if (store.activeTaskId === task.id) {
      for (const file of store.changeSet?.files ?? []) {
        stats[file.path] = { additions: file.additions, deletions: file.deletions };
      }
    }
    return stats;
  }, [externalFiles, store.activeTaskId, store.changeSet, task.id]);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: MouseEvent): void => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [moreOpen]);

  // Editing is the expanded File tool state. The Session and conversation stay
  // mounted; there is no separate Full workspace surface.
  const openFileInEditor = (path: string): void => {
    void editor.openFile(path);
    app.openPeek(task.id, path, 'edit');
    app.setSessionToolExpanded(true);
  };

  // ADR-0024: tree drags and OS files land anywhere in the room — no aiming
  // at the composer. External rooms route drops through the terminal column
  // instead: the reference lands in the CLI's own input line (ADR-0030).
  const acceptsRoomDrops = !task.external;
  const roomDropHandlers = acceptsRoomDrops
    ? {
        onDragOver: (e: React.DragEvent): void => {
          if (!hasDragRef(e) && !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setRoomDrop(true);
        },
        onDragLeave: (e: React.DragEvent): void => {
          const next = e.relatedTarget as Node | null;
          if (!next || !e.currentTarget.contains(next)) setRoomDrop(false);
        },
        onDrop: (e: React.DragEvent): void => {
          if (!hasDragRef(e) && !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setRoomDrop(false);
          void handleRoomDrop(task.id, sameProject, e);
        },
      }
    : {};

  return (
    <div
      className={`tr-root ${roomDrop ? 'room-drop' : ''}`}
      data-testid="task-room"
      data-task-id={task.id}
      {...roomDropHandlers}
    >
      {roomDrop ? (
        <div className="tr-dropveil" data-testid="room-dropveil" aria-hidden>
          <span>
            <Ic name="file" size={14} />
            Drop to attach to this reply — files, folders, images
          </span>
        </div>
      ) : null}
      <div className="tr-head session-identity-head">
        <div className="tr-head-drag" />
        <button className="tr-back" data-testid="task-room-back" onClick={app.closeTaskRoom}>
          <Ic name="chevron" size={13} className="tr-back-ic" />
          All Sessions
        </button>
        <div className="session-identity">
          <div className="session-identity-title">
            <span className="tr-title" title={sessionDisplayTitle(task)}>
              {sessionDisplayTitle(task)}
            </span>
            <StateBadge
              state={task.state}
              {...(answered ? { label: 'Answered', tone: 'ok' as const } : {})}
            />
          </div>
          <div className="session-identity-meta">
            <span className="tr-proj" data-testid="task-room-project" title={task.projectPath}>
              <Ic name="folder" size={11} />
              {task.projectName}
            </span>
            {task.worktree ? (
              <WorktreeChip task={task} />
            ) : (
              <span className="tr-proj">
                <Ic name="branch" size={11} />
                <span className="mono">main</span>
              </span>
            )}
            <span className="session-agent-chip" data-testid="session-agent-chip">
              <Ic name={task.external ? 'terminal' : 'bot'} size={11} />
              {sessionAgentLabel(task)}
            </span>
            {task.external ? (
              <span
                className="tr-extchip"
                data-testid="task-room-external-chip"
                title="External CLI session — process state and file evidence stay attached to this Session."
              >
                external
              </span>
            ) : null}
          </div>
        </div>
        {fleetAvailable ? (
          <nav className="task-room-switcher" aria-label="Session views">
            <button
              className={sessionRoomView === 'conversation' ? 'active' : ''}
              data-testid="task-room-conversation-tab"
              aria-current={sessionRoomView === 'conversation' ? 'page' : undefined}
              onClick={() => app.setSessionRoomView('conversation')}
            >
              主会话
            </button>
            <button
              className={sessionRoomView === 'fleet' ? 'active' : ''}
              data-testid="task-room-fleet-tab"
              aria-current={sessionRoomView === 'fleet' ? 'page' : undefined}
              onClick={() => app.setSessionRoomView('fleet')}
            >
              <span>⌁ 编队 {commanderWorkers.length}</span>
              {orchestrationNeeds > 0 ? <b>{orchestrationNeeds}</b> : null}
            </button>
          </nav>
        ) : null}
        <span className="tr-sp" />
        <PreviewBadge task={task} />
        <div className="session-more" ref={moreRef}>
          <button
            className="session-more-button"
            data-testid="session-more"
            aria-label="More Session actions"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(!moreOpen)}
          >
            <span>More</span>
            <Ic name="chevron" size={11} />
          </button>
          {moreOpen ? (
            <div className="session-more-menu" role="menu">
              <button
                data-testid="replay-open"
                onClick={() => {
                  setMoreOpen(false);
                  store.openReplay();
                }}
              >
                <Ic name="play" size={12} /> Replay Session
              </button>
              {files[0] && sameProject && !task.worktree ? (
                <button
                  data-testid="task-room-edit-file"
                  onClick={() => {
                    setMoreOpen(false);
                    openFileInEditor(files[0]!);
                  }}
                >
                  <Ic name="pencil" size={12} /> Edit first changed file
                </button>
              ) : null}
              {canArchiveTask(task) ? (
                <ConfirmDangerButton
                  label="Archive…"
                  confirmLabel="Confirm — archive"
                  testid="task-archive"
                  quiet
                  onConfirm={() => void store.archiveTask(task.id)}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {sessionRoomView === 'fleet' && fleetAvailable ? (
        <div className="tr-body fleet-canvas-body">
          <OrchestrationFleet taskId={task.id} />
        </div>
      ) : (
        <div
          ref={canvasBodyRef}
          className={`tr-body session-canvas-body ${app.sessionToolExpanded ? 'tool-expanded' : ''} ${
            app.sessionSplit[task.id] !== undefined || app.sessionSplitDragging
              ? 'split-manual'
              : ''
          } ${app.sessionSplitDragging ? 'splitting' : ''}`}
        >
          <div className="tr-main">
            {task.external ? (
              <OrchestrationWorkerBand taskId={task.id} terminalId={task.external.terminalId} />
            ) : null}
            {task.external && !workerRoom && orchestrationPermissions.length > 0 ? (
              <div className="orch-conversation-approvals" data-testid="orchestration-approvals">
                <span>⌁ Commander approval</span>
                {orchestrationPermissions.map((card) => (
                  <PermissionCard key={card.requestId} card={card} resolution={null} />
                ))}
              </div>
            ) : null}
            {task.external ? (
              /* ADR-0017: the conversation with an external agent IS its terminal —
                 it takes the timeline+composer's place; everything else is the
                 same room (rail, peek, review bar). */
              <ExternalTerminalColumn key={task.id} task={task} sameProject={sameProject} />
            ) : (
              <>
                {/* Mockup A (ADR-0014): mode/model/effort live in the composer foot. */}
                <RoomTimeline task={task} />
              </>
            )}
            {running && !task.external ? (
              <ActivityStrip taskId={task.id} taskText={`${task.title}\n${task.goalMd}`} />
            ) : null}
            {/* ADR-0028: distill card — a captured review correction offers to
                become a project rule, inline where the correction happened. */}
            {task.external ? null : <DistillCards taskId={task.id} />}
            {task.external ? null : <RoomComposer key={task.id} task={task} running={running} />}
          </div>
          <SessionSplitHandle taskId={task.id} containerRef={canvasBodyRef} />
          <SessionToolCanvas
            key={task.id}
            task={task}
            files={files}
            fileStats={fileStats}
            verifications={verifications}
            editableInWorkspace={sameProject && task.worktree === null}
            onOpenFile={openFileInEditor}
          />
        </div>
      )}
    </div>
  );
}

function actionLine(kind: string, label: string): string {
  void kind;
  return label.length > 90 ? `${label.slice(0, 87)}…` : label;
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
  const current = activity?.current ?? null;
  // The 1s elapsed tick only needs to run while an action is actually live;
  // idle rooms render without a timer.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!current) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [current]);

  const action = currentActionLine(activity);
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
    // A11Y-004: announce the agent's current action politely (action-level, not
    // per token — the label only changes when the tool/phase changes).
    <div className="tr-activity" data-testid="task-room-activity" role="status" aria-live="polite">
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
        title="This Session runs in an isolated worktree — changes reach the project only when you accept"
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
                void useTerminalStore.getState().create({
                  taskId: task.id,
                  context: { kind: 'task', taskId: task.id },
                  title: wt.branch,
                  reveal: false,
                });
              });
              app.setSessionTool('terminal');
              app.setSessionToolExpanded(true);
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
 * "Request changes" (ADR-0009; no extra button). ADR-0032: the Session is a
 * continuous conversation — a settled (IDLE) turn just keeps the same reply
 * pill, and the next message starts a new run in the SAME Session. Only an
 * archived Session closes; replying there starts a NEW Session that carries
 * this one as structured context (the Home-parity composer below). */
function RoomComposer({
  task,
  running,
}: {
  task: {
    id: string;
    state: string;
    archived: boolean;
    title: string;
    projectPath: string;
    projectName: string;
    mode: AgentMode;
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
  const codeRefs = useDraftStore((s) => s.codeRefs[task.id] ?? EMPTY_CODE_CONTEXT_REFS);
  // ADR-0024: file / folder / image chips riding the next turn.
  const fileRefs = useDraftStore((s) => s.fileRefs[task.id] ?? EMPTY_FILE_REFS);
  const setInput = (text: string): void => useDraftStore.getState().setDraft(task.id, text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composerFocusSeq = useAppStore((s) => s.composerFocusSeq);
  const planOpen = task.state === 'AWAITING_PLAN_APPROVAL';
  // ADR-0032: only an archived Session is closed. Historic terminal states
  // (pre-migration rows are archived; belt-and-braces here) stay read-only.
  const closed =
    task.archived || ['ACCEPTED', 'ROLLED_BACK', 'CANCELLED', 'ARCHIVED'].includes(task.state);

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

  const startFollowUp = async (text: string): Promise<boolean> => {
    const [providerId, modelId] = modelKey.split('::');
    if (!providerId || !modelId) {
      app.pushToast('warning', 'No model available — add a provider key in Settings.');
      return false;
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
      codeRefs,
      fileRefs,
    });
    if (ok) {
      useDraftStore.getState().clearPreviewRef(task.id);
      useDraftStore.getState().clearFileRefs(task.id);
      const newId = useTaskStore.getState().activeTaskId;
      if (newId) app.openTaskRoom(newId);
    }
    return ok;
  };

  const send = async (): Promise<void> => {
    const typed = input.trim();
    const terminalContext = terminalRefs
      .map(
        (terminalRef) =>
          `终端输出引用：${terminalRef.contextLabel} · ${terminalRef.cwd}\n\n\`\`\`text\n${terminalRef.text}\n\`\`\``,
      )
      .join('\n\n');
    const text =
      [typed, terminalContext].filter(Boolean).join('\n\n') ||
      (codeRefs.length > 0
        ? 'Use the attached code selection as context for this turn.'
        : fileRefs.length > 0
          ? 'Use the attached files as context for this turn.'
          : '');
    if (!text && !previewRef) return;
    let delivered = false;
    if (planOpen) {
      delivered = await store.decidePlan({
        decision: 'request_changes',
        reason: text || 'See the attachment.',
        codeRefs,
      });
    } else if (closed) {
      delivered = await startFollowUp(text);
    } else if (previewRef) {
      // ADR-0022 am.2: the reply carries the preview selection — same steer
      // loop, one conversation; the model sees the screenshot.
      const structured = buildPreviewFeedbackText(previewRef, text);
      if (previewRef.dataBase64) {
        delivered = await store.sendPreviewFeedback(
          structured,
          {
            dataBase64: previewRef.dataBase64,
            mimeType: 'image/png',
            pageUrl: previewRef.pageUrl,
            rect: previewRef.rect,
            ...(previewRef.selector ? { selector: previewRef.selector } : {}),
            ...(text.trim() ? { note: text.trim() } : {}),
          },
          codeRefs,
          fileRefs,
        );
      } else {
        delivered = await store.send(
          `${structured}\n(Screenshot capture failed — none attached.)`,
          'steer',
          undefined,
          codeRefs,
          fileRefs,
        );
      }
    } else {
      const [providerId, modelId] = modelKey.split('::');
      const override =
        modelDirty && providerId && modelId
          ? { providerId, modelId, thinkingLevel: thinking }
          : undefined;
      delivered = await store.send(text, 'steer', override, codeRefs, fileRefs);
      if (delivered) setModelDirty(false);
    }
    if (!delivered) return;
    setInput('');
    useDraftStore.getState().clearTerminalRefs(task.id);
    useDraftStore.getState().clearCodeRefs(task.id);
    // Plan-change feedback rides codeRefs only — file chips stay for the next
    // real turn instead of silently vanishing unsent (ADR-0024).
    if (!planOpen) useDraftStore.getState().clearFileRefs(task.id);
    if (previewRef) useDraftStore.getState().clearPreviewRef(task.id);
  };

  // ADR-0024: tree drags and @ picks land as structured chips above the input
  // (the Room no longer smuggles inline "@path" prose into the reply text).
  const attachRef = (rel: string): void => {
    addFileRefWithToast(task.id, refFromRel(rel));
    ref.current?.focus();
  };

  const pickFile = (path: string): void => {
    setPickerOpen(false);
    attachRef(path);
  };

  const placeholder = planOpen
    ? 'Request changes to the plan — the agent will revise it…'
    : running
      ? 'Reply — steer the agent or add context…'
      : task.state === 'REVIEW_READY'
        ? 'Request changes or add review context…'
        : closed
          ? 'This Session is archived — replying starts a new Session that references it…'
          : task.state === 'IDLE'
            ? 'Reply — continue this Session…'
            : 'Reply or add context…';

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
      onPaste={(e) => {
        // ADR-0024: pasted screenshots become image chips, not text.
        if (handleComposerPaste(task.id, e)) e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (slash.handleKeyDown(e)) {
          e.preventDefault();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void send();
        }
      }}
    />
  );

  const hasAttachments =
    terminalRefs.length > 0 || Boolean(previewRef) || codeRefs.length > 0 || fileRefs.length > 0;
  const sendButton = (
    <button
      className={`hm-send ${input.trim() || hasAttachments ? 'ready' : ''}`}
      data-testid="agent-send"
      disabled={!input.trim() && !hasAttachments}
      aria-label={planOpen ? 'Request plan changes' : 'Send'}
      onClick={() => void send()}
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

  // ADR-0024: one @ picker serves both composer variants — picks land chips.
  const pickerMenu = pickerOpen ? (
    <div className="hm-menu room-file-menu" data-testid="room-file-picker">
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
  ) : null;

  const attachButton = (
    <button
      className="hm-iconbtn"
      data-testid="room-attach"
      disabled={!sameProject}
      title={
        sameProject
          ? 'Attach project files (or drop them anywhere in the room)'
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
  );

  // Mid-run / plan-awaiting: the mockup-A reply card (ADR-0014) — textarea on
  // top, trust level (fixed for the session) and the model·effort control in
  // the foot. ADR-0016: replies can re-pick model/effort for the next turn;
  // a plan-change reply revises within the current turn, so it keeps the
  // read-only meta (the override rides on task.message only).
  if (!closed) {
    return (
      <div className="tr-composer" data-testid="room-composer">
        <div className="tr-ccard">
          <CodeContextAttachments taskId={task.id} refs={codeRefs} />
          <FileContextAttachments taskId={task.id} refs={fileRefs} />
          {previewChip}
          {terminalRefChips}
          {pickerMenu}
          {textarea('tr-cinput')}
          {slash.menu}
          <div className="tr-cfoot">
            {attachButton}
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
    <div className="tr-composer follow" data-testid="room-composer">
      <div className="tr-fcard">
        <div className="hm-card">
          <CodeContextAttachments taskId={task.id} refs={codeRefs} />
          <FileContextAttachments taskId={task.id} refs={fileRefs} />
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
          </div>
          {pickerMenu}

          {textarea('hm-ta tr-fta')}
          {slash.menu}

          <div className="hm-btmrow">
            {attachButton}
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
