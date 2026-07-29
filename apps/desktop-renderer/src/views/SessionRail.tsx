import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RecentWorkspaceDto, TaskDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useActivityStore, currentActionLine } from '../store/activityStore.js';
import { useAppStore, type RailView } from '../store/appStore.js';
import { useExternalStore } from '../store/externalStore.js';
import { RUNNING_TASK_STATES, useTaskStore } from '../store/taskStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useTerminalStore } from './TerminalPanel.js';
import { Ic, ProviderMark } from './home-icons.js';
import {
  canArchiveTask,
  canResumeExternal,
  isAnswered,
  needsAttention,
  presentedMeta,
} from './labels.js';
import { ArmedIconButton } from './ui.js';
import { SessionFilesPane } from './SessionFilesPane.js';
import { SkillsRailPanel } from './SkillsRailPanel.js';
import { useGlowTasks } from './useGlow.js';
import { sessionDisplayTitle } from '../store/sessionAttention.js';
import { unknownDirectories, useArchaeologyStore } from '../store/archaeologyStore.js';
import { permissionForWorker, useOrchestrationStore } from '../store/orchestrationStore.js';
import {
  ACTIVE_SESSION_GROUP_LIMIT,
  HISTORY_PERIOD_INITIAL_LIMIT,
  HISTORY_PERIOD_MORE_STEP,
  buildHistoryPeriods,
  buildRailGroups,
  isHistoryEntry,
  recordedTasksByProject,
  visibleHistoryPeriodEntries,
  visibleRailGroupEntries,
  type HistoryPeriodKey,
  type RailGroup,
  type SessionEntry,
} from './rail-groups.js';
import { ActivityBar } from './ActivityBar.js';
import { SessionRenameDialog } from './SessionRenameDialog.js';
import {
  externalAgentLifecycle,
  externalSessionTitle,
  externalTerminalLifecycle,
  isExternalCli,
} from './external-terminal-lifecycle.js';

export { isHistoryEntry, type SessionEntry } from './rail-groups.js';

const COLLAPSED_KEY = 'charter.rail.collapsed.v2';
const SESSION_TOOLTIP_DELAY_MS = 180;
const ACTION_TOOLTIP_DELAY_MS = 80;

function historyPeriodGroupKey(key: HistoryPeriodKey): string {
  return `history:${key}`;
}

interface SessionTooltipState {
  id: string;
  label: string;
  left: number;
  top: number;
  maxWidth: number;
}

type SessionTooltipPlacement = 'auto' | 'left';

function useSessionHoverTooltip(): {
  triggerProps: (
    label: string,
    id: string,
    delay?: number,
    placement?: SessionTooltipPlacement,
  ) => {
    'aria-describedby': string | undefined;
    onMouseEnter: React.MouseEventHandler<HTMLButtonElement>;
    onMouseLeave: React.MouseEventHandler<HTMLButtonElement>;
    onFocus: React.FocusEventHandler<HTMLButtonElement>;
    onBlur: React.FocusEventHandler<HTMLButtonElement>;
  };
  tooltip: React.ReactNode;
  hide: () => void;
} {
  const timerRef = useRef<number | null>(null);
  const [state, setState] = useState<SessionTooltipState | null>(null);

  const clearTimer = (): void => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const hide = (): void => {
    clearTimer();
    setState(null);
  };
  const schedule = (
    target: HTMLButtonElement,
    label: string,
    id: string,
    delay: number,
    placement: SessionTooltipPlacement,
  ): void => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      const rect = target.getBoundingClientRect();
      const maxWidth = Math.min(360, window.innerWidth - 16);
      const rightSide = rect.right + 8;
      const estimatedWidth = Math.min(maxWidth, Math.max(72, Math.ceil(label.length * 6.2) + 20));
      const left =
        placement === 'left'
          ? Math.max(8, rect.left - estimatedWidth - 8)
          : rightSide + estimatedWidth <= window.innerWidth - 8
            ? rightSide
            : Math.max(8, rect.left - estimatedWidth - 8);
      setState({
        id,
        label,
        left,
        top: Math.max(8, Math.min(rect.top, window.innerHeight - 96)),
        maxWidth,
      });
      timerRef.current = null;
    }, delay);
  };

  useEffect(() => () => clearTimer(), []);

  return {
    triggerProps: (label, id, delay = SESSION_TOOLTIP_DELAY_MS, placement = 'auto') => ({
      'aria-describedby': state?.id === id ? id : undefined,
      onMouseEnter: (event) => schedule(event.currentTarget, label, id, delay, placement),
      onMouseLeave: hide,
      onFocus: (event) => schedule(event.currentTarget, label, id, 0, placement),
      onBlur: hide,
    }),
    tooltip: state
      ? createPortal(
          <div
            id={state.id}
            className="sr-hover-tooltip"
            role="tooltip"
            style={{ left: state.left, top: state.top, maxWidth: state.maxWidth }}
          >
            {state.label}
          </div>,
          document.body,
        )
      : null,
    hide,
  };
}

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (raw) {
      return new Set(
        (JSON.parse(raw) as unknown[]).filter((v): v is string => typeof v === 'string'),
      );
    }
  } catch {
    // fall through to the default below
  }
  return new Set(['history', historyPeriodGroupKey('older')]);
}

function saveCollapsed(collapsed: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // best-effort UI state
  }
}

function providerForTask(task: TaskDto): 'pi' | 'claude' | 'codex' {
  if (task.external?.cli === 'claude') return 'claude';
  if (task.external?.cli === 'codex') return 'codex';
  return 'pi';
}

function providerLabel(provider: 'pi' | 'shell' | 'claude' | 'codex'): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  if (provider === 'shell') return 'Shell';
  return 'Charter';
}

export function timeAgo(value: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function statusBadge(task: TaskDto): { label: string; tone: string } | null {
  if (isAnswered(task)) {
    // Ended CLI session ≠ answered Pi run: the truthful edge is the exit.
    if (task.external) return { label: 'Ended', tone: 'neutral' };
    return { label: 'Answered', tone: 'answered' };
  }
  if (task.state === 'REVIEW_READY') return { label: 'Review', tone: 'review' };
  const meta = presentedMeta(task);
  if (
    ['AWAITING_PLAN_APPROVAL', 'AWAITING_USER', 'AWAITING_PERMISSION', 'INTERRUPTED'].includes(
      task.state,
    )
  ) {
    return { label: meta.short, tone: 'review' };
  }
  if (task.state === 'FAILED') return { label: 'Failed', tone: 'failed' };
  // ADR-0032: a settled conversation with work applied — quiet ok badge.
  if (task.state === 'IDLE') return { label: 'Settled', tone: 'answered' };
  if (task.state === 'ACCEPTED') return { label: 'Accepted', tone: 'answered' };
  if (task.state === 'ROLLED_BACK' || task.state === 'CANCELLED') {
    return { label: meta.short, tone: 'neutral' };
  }
  return null;
}

function SessionTaskRow({
  task,
  showProject = true,
  now,
  worker = false,
  workerWorking = false,
  workerCount = 0,
  orchestrationNeeds = 0,
}: {
  task: TaskDto;
  /** Rows inside a project group drop the redundant project name (ADR-0023). */
  showProject?: boolean;
  now: number;
  worker?: boolean;
  workerWorking?: boolean;
  workerCount?: number;
  orchestrationNeeds?: number;
}): React.JSX.Element {
  const app = useAppStore();
  const hoverTooltip = useSessionHoverTooltip();
  const actionTooltip = useSessionHoverTooltip();
  const activity = useActivityStore((state) => state.perTask[task.id]);
  const glowTasks = useGlowTasks();
  const completion = app.sessionCompletionSignals.find((signal) => signal.taskId === task.id);
  const reply = app.sessionReplySignals.find((signal) => signal.taskId === task.id);
  const selected = app.taskRoomTaskId === task.id;
  const provider = providerForTask(task);
  const displayTitle = sessionDisplayTitle(task);
  const running = RUNNING_TASK_STATES.has(task.state);
  const meta = presentedMeta(task);
  const action = running ? currentActionLine(activity) : null;
  const badge = statusBadge(task);
  const externalSession = useExternalStore((state) => state.sessions[task.id]);
  const externalWorking = useExternalStore((state) => Boolean(state.working[task.id]));
  const resumingTaskId = useExternalStore((state) => state.resumingTaskId);
  const externalTerminal = useTerminalStore((state) =>
    task.external
      ? state.items.find((terminal) => terminal.id === task.external?.terminalId)
      : undefined,
  );
  const live = task.external
    ? (externalSession?.status ?? task.external.status) === 'active'
    : running;
  const working = task.external
    ? externalWorking || workerWorking
    : ['EXPLORING', 'PLANNING', 'IN_PROGRESS', 'VERIFYING'].includes(task.state);
  const resumable = canResumeExternal(task) && !live;
  const endable = task.external !== null && live;
  const archivable = canArchiveTask(task) && !endable;
  const hasActions = endable || resumable || archivable;
  const [renameOpen, setRenameOpen] = useState(false);
  const [endingExternal, setEndingExternal] = useState(false);
  const externalLifecycle =
    task.external && isExternalCli(task.external.cli) && externalTerminal
      ? externalTerminalLifecycle({
          cli: task.external.cli,
          agent: externalAgentLifecycle(
            externalSession?.status ?? task.external.status,
            task.state,
          ),
          terminalExited: externalTerminal.exited,
          shellTitle: externalTerminal.title,
        })
      : null;
  const rowDescription = `${providerLabel(provider)} · ${displayTitle} · ${task.projectName} — ${
    working ? 'Agent working' : (externalLifecycle?.summary ?? meta.label)
  }`;

  const open = (): void => {
    void useTaskStore.getState().openTask(task.id);
    app.openTaskRoom(task.id);
  };

  const openFleet = (event: React.MouseEvent): void => {
    event.stopPropagation();
    void useTaskStore.getState().openTask(task.id);
    app.openTaskRoom(task.id);
    app.setSessionRoomView('fleet');
  };

  const endExternalSession = (): void => {
    if (!task.external || endingExternal) return;
    setEndingExternal(true);
    void rpcResult('external.endSession', { taskId: task.id })
      .then((result) => {
        if (!result.ok) {
          app.pushToast('error', result.error.userMessage);
          return;
        }
        if (!result.data.ended) {
          app.pushToast(
            'warning',
            `${task.external?.cli === 'claude' ? 'Claude Code' : 'Codex'} did not exit. Close its terminal to force it to stop.`,
          );
        }
      })
      .finally(() => setEndingExternal(false));
  };

  return (
    <div
      className={`sr-row-wrap ${showProject ? 'has-detail' : ''} ${hasActions ? 'has-actions' : ''} ${worker ? 'sr-orch-worker' : ''} ${workerCount > 0 ? 'has-fleet' : ''}`}
    >
      <button
        className={`sr-session ${showProject ? 'has-detail' : ''} ${selected ? 'selected' : ''} ${working ? 'is-working' : ''} ${glowTasks.has(task.id) ? 'glow-pulse' : ''} ${completion ? `completion-ripple completion-${completion.tone}` : ''} ${reply ? 'reply-shake' : ''}`}
        data-testid={`home-task-${task.id}`}
        data-session-key={`task:${task.id}`}
        data-state={task.state}
        data-completion={completion?.tone}
        data-reply={reply ? 'true' : undefined}
        data-working={working ? 'true' : 'false'}
        aria-label={rowDescription}
        {...hoverTooltip.triggerProps(rowDescription, `session-tooltip-task-${task.id}`)}
        onClick={() => {
          hoverTooltip.hide();
          open();
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setRenameOpen(true);
        }}
      >
        <ProviderMark
          provider={provider}
          className={`${working ? 'is-working' : ''} ${
            completion || reply ? `session-wave ${completion ? 'completion' : 'reply'}` : ''
          }`.trim()}
        />
        <span className="sr-session-copy">
          <span className="sr-session-title">
            <span className={`sr-live-dot ${live ? 'live' : ''}`} />
            <b>{displayTitle}</b>
            {badge || !showProject ? (
              <span className="sr-session-tail">
                {badge ? <span className={`sr-state ${badge.tone}`}>{badge.label}</span> : null}
                {!showProject ? (
                  <time className="sr-session-time" dateTime={task.updatedAt}>
                    {timeAgo(task.updatedAt, now)}
                  </time>
                ) : null}
              </span>
            ) : null}
          </span>
          {showProject ? (
            <span className="sr-session-detail">
              <span data-testid={`home-task-ticker-${task.id}`}>
                {task.projectName} ·{' '}
                {action?.label ??
                  (working ? 'Agent is working...' : null) ??
                  externalLifecycle?.summary ??
                  (isAnswered(task)
                    ? task.external
                      ? 'Session ended · no file changes'
                      : 'Answered · no file changes'
                    : meta.label)}
              </span>
              <time dateTime={task.updatedAt}>{timeAgo(task.updatedAt, now)}</time>
            </span>
          ) : null}
        </span>
      </button>
      {workerCount > 0 ? (
        <button
          className={`sr-fleet-shortcut ${selected && app.sessionRoomView === 'fleet' ? 'active' : ''}`}
          data-testid={`home-fleet-${task.id}`}
          title={`Open Fleet · ${workerCount} worker${workerCount === 1 ? '' : 's'}${
            orchestrationNeeds > 0 ? ` · ${orchestrationNeeds} need attention` : ''
          }`}
          aria-label={`Open Fleet for ${displayTitle}`}
          onClick={openFleet}
        >
          <span>⌁</span>
          <b>{workerCount}</b>
          {orchestrationNeeds > 0 ? <i>{orchestrationNeeds}</i> : null}
        </button>
      ) : null}
      {hasActions ? (
        <div className="sr-actions">
          {endable ? (
            <ArmedIconButton
              icon={endingExternal ? 'refresh' : 'circleStop'}
              iconSize={endingExternal ? 13 : 16}
              className="sr-end"
              testid={`home-end-${task.id}`}
              title={endingExternal ? 'Ending session…' : 'End session'}
              armedTitle="Click again to end this session"
              disabled={endingExternal}
              tooltipProps={actionTooltip.triggerProps(
                endingExternal ? 'Ending session…' : 'End session',
                `session-tooltip-end-${task.id}`,
                ACTION_TOOLTIP_DELAY_MS,
                'left',
              )}
              onInteract={actionTooltip.hide}
              onConfirm={endExternalSession}
            />
          ) : null}
          {resumable ? (
            <button
              className="sr-resume"
              data-testid={`home-resume-${task.id}`}
              title={`Resume this ${task.external?.cli ?? ''} session`}
              aria-label={`Resume this ${task.external?.cli ?? ''} session`}
              disabled={resumingTaskId !== null}
              onClick={() => void useExternalStore.getState().resumeTask(task)}
            >
              <Ic name="refresh" size={12} strokeWidth={2} />
            </button>
          ) : null}
          {archivable ? (
            <ArmedIconButton
              icon="archive"
              className="sr-archive"
              testid={`home-archive-${task.id}`}
              title="Archive session"
              armedTitle="Click again to archive"
              onConfirm={() => void useTaskStore.getState().archiveTask(task.id)}
            />
          ) : null}
        </div>
      ) : null}
      <SessionRenameDialog task={task} open={renameOpen} onClose={() => setRenameOpen(false)} />
      {hoverTooltip.tooltip}
      {actionTooltip.tooltip}
    </div>
  );
}

function TerminalSessionRow({
  terminalId,
  launch,
  showProject = true,
  worker = false,
  working = false,
}: {
  terminalId: string;
  launch: 'shell' | 'claude' | 'codex';
  showProject?: boolean;
  worker?: boolean;
  working?: boolean;
}): React.JSX.Element | null {
  const app = useAppStore();
  const hoverTooltip = useSessionHoverTooltip();
  const item = useTerminalStore((state) => state.items.find((entry) => entry.id === terminalId));
  if (!item) return null;
  const selected = app.sessionTerminalId === terminalId;
  const provider = launch;
  // The brand mark carries the provider — never repeat the CLI name as the
  // title. Generic launch titles read as an unnamed session.
  const sessionName = isExternalCli(launch) ? externalSessionTitle(launch, item.title) : item.title;
  const terminalState = item.exited
    ? 'Process ended'
    : item.remote
      ? 'Remote SSH session live'
      : working
        ? `${providerLabel(provider)} working`
        : 'Terminal live';
  const rowDescription = `${providerLabel(provider)} · ${sessionName} · ${item.contextLabel} — ${terminalState}`;
  return (
    <div
      className={`sr-row-wrap ${showProject ? 'has-detail' : ''} ${worker ? 'sr-orch-worker' : ''}`}
    >
      <button
        className={`sr-session ${showProject ? 'has-detail' : ''} ${selected ? 'selected' : ''} ${working ? 'is-working' : ''}`}
        data-testid={`session-terminal-${terminalId}`}
        data-session-key={`terminal:${terminalId}`}
        data-working={working ? 'true' : 'false'}
        aria-label={rowDescription}
        {...hoverTooltip.triggerProps(rowDescription, `session-tooltip-terminal-${terminalId}`)}
        onClick={() => {
          hoverTooltip.hide();
          // ADR-0046: entering a session moves the working context (and the
          // Files tree) to its project.
          void useWorkspaceStore.getState().followProject(item.projectPath);
          app.openTerminalSession(terminalId);
        }}
      >
        <ProviderMark provider={provider} className={working ? 'is-working' : ''} />
        <span className="sr-session-copy">
          <span className="sr-session-title">
            <span className={`sr-live-dot ${item.exited ? '' : 'live'}`} />
            {item.remote ? <span className="sr-remote-mark">⌁</span> : null}
            <b>{sessionName}</b>
            {item.exited ? <span className="sr-state neutral">Ended</span> : null}
          </span>
          {showProject ? (
            <span className="sr-session-detail">
              <span>
                {item.projectName} ·{' '}
                {item.exited
                  ? 'Process ended · session retained'
                  : item.remote
                    ? 'Remote SSH session is live'
                    : 'Terminal session is live'}
              </span>
            </span>
          ) : null}
        </span>
      </button>
      {hoverTooltip.tooltip}
    </div>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest('input, textarea, [contenteditable="true"], .xterm-helper-textarea'),
  );
}

/**
 * The one global Session Rail. Sessions are grouped by project with a collapsed
 * History group for settled work; Needs You and Projects are contextual panel
 * states, not parallel navigation shells.
 */
export function SessionRail(): React.JSX.Element {
  const app = useAppStore();
  const workspaceStore = useWorkspaceStore();
  // Subscribe to the task list only — the rail must not re-render on every
  // streaming delta of whichever session is active.
  const tasks = useTaskStore((s) => s.tasks);
  const terminalStore = useTerminalStore();
  const taskByTerminal = useExternalStore((state) => state.taskByTerminal);
  const orchestration = useOrchestrationStore((state) => state.snapshot);
  const orchestrationPermissions = useOrchestrationStore((state) => state.permissions);
  const inbox = tasks.filter((task) => !task.archived && needsAttention(task));
  const [recent, setRecent] = useState<RecentWorkspaceDto[]>([]);
  // ADR-0029: the rail view lives in the app store so commands (⌘⇧E) and
  // "open project files" flows can reveal the Files tree.
  const view = app.railView;
  const [projectsPanelOpen, setProjectsPanelOpen] = useState(view === 'projects');
  const [compactPanelOpen, setCompactPanelOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(loadCollapsed);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [historyPeriodLimits, setHistoryPeriodLimits] = useState<
    Readonly<Partial<Record<HistoryPeriodKey, number>>>
  >({});
  const [query, setQuery] = useState('');
  const [needsOnly, setNeedsOnly] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // ADR-0038: discovered external conversations (read-only ~/.claude/~/.codex
  // sweep) — the Projects panel shows per-project counts and unknown dirs.
  const discovered = useArchaeologyStore((s) => s.sessions);
  const discoveryEnabled = useArchaeologyStore((s) => s.enabled);
  const discoveredByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of discovered) {
      if (session.trackedTaskId !== null || !session.projectPath) continue;
      counts.set(session.projectPath, (counts.get(session.projectPath) ?? 0) + 1);
    }
    return counts;
  }, [discovered]);
  const unknownDirs = useMemo(() => unknownDirectories(discovered), [discovered]);
  const setView = (next: RailView): void => {
    app.setRailView(next);
    if (window.matchMedia('(max-width: 1120px)').matches) setCompactPanelOpen(true);
    // Rail navigation dismisses the Remotes surface — switching the left panel
    // while the main area stays parked on hosts reads as a dead click.
    if (useAppStore.getState().remotesOpen) useAppStore.getState().closeRemotes();
    if (next !== 'projects') setProjectsPanelOpen(false);
    setAddMenuOpen(false);
  };

  const showProjects = (): void => {
    setView('projects');
    setProjectsPanelOpen(true);
    // ADR-0038: the Projects panel is discovery's ambient entry point — keep
    // the "N outside" counts fresh without the user ever asking for a scan.
    void useArchaeologyStore.getState().scan();
  };

  useEffect(() => {
    useTaskStore.getState().init();
    void useTaskStore.getState().refreshTasks();
    terminalStore.init();
    useExternalStore.getState().init();
    useOrchestrationStore.getState().init();
    void rpcResult('workspace.recent', {}).then((result) => {
      if (result.ok) setRecent(result.data.items);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceStore.workspace?.path]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (app.taskRoomTaskId && window.matchMedia('(max-width: 1120px)').matches) {
      setCompactPanelOpen(false);
    }
  }, [app.taskRoomTaskId]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const close = (event: MouseEvent): void => {
      if (addMenuRef.current && !addMenuRef.current.contains(event.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAddMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [addMenuOpen]);

  const allEntries = useMemo<SessionEntry[]>(() => {
    const workerTerminalIds = new Set(orchestration.workers.map((worker) => worker.terminalId));
    const taskEntries: SessionEntry[] = tasks
      .filter((task) => !task.archived)
      .map((task) => ({ key: `task:${task.id}`, kind: 'task', task }));
    const terminalEntries: SessionEntry[] = terminalStore.items
      .filter(
        (terminal) =>
          !terminal.hidden &&
          !taskByTerminal[terminal.id] &&
          !tasks.some((task) => task.external?.terminalId === terminal.id) &&
          // ADR-0047: remote SSH sessions always earn a rail row (grouped by host).
          (terminal.launch === 'claude' ||
            terminal.launch === 'codex' ||
            Boolean(terminal.remote) ||
            workerTerminalIds.has(terminal.id)),
      )
      .map((terminal) => ({
        key: `terminal:${terminal.id}`,
        kind: 'terminal',
        terminalId: terminal.id,
        launch: terminal.launch,
        projectName: terminal.projectName,
        exited: terminal.exited,
        remote: Boolean(terminal.remote),
      }));
    const base = [...terminalEntries.toReversed(), ...taskEntries];
    const workerTaskIds = new Set(
      orchestration.workers
        .map((worker) => worker.taskId)
        .filter((id): id is string => id !== null),
    );
    const unboundWorkerTerminalIds = new Set(
      orchestration.workers.filter((worker) => !worker.taskId).map((worker) => worker.terminalId),
    );
    const ordered: SessionEntry[] = [];
    const appended = new Set<string>();
    const append = (entry: SessionEntry): void => {
      if (appended.has(entry.key)) return;
      appended.add(entry.key);
      ordered.push(entry);
    };
    for (const entry of base) {
      const isChild =
        entry.kind === 'task'
          ? workerTaskIds.has(entry.task.id)
          : unboundWorkerTerminalIds.has(entry.terminalId);
      if (isChild) continue;
      append(entry);
      if (entry.kind !== 'task') continue;
      for (const relation of orchestration.workers.filter(
        (worker) => worker.commanderTaskId === entry.task.id,
      )) {
        const child = base.find((candidate) =>
          relation.taskId
            ? candidate.kind === 'task' && candidate.task.id === relation.taskId
            : candidate.kind === 'terminal' && candidate.terminalId === relation.terminalId,
        );
        if (child) append(child);
      }
    }
    for (const entry of base) append(entry);
    return ordered;
  }, [orchestration.workers, tasks, terminalStore.items, taskByTerminal]);

  const groups = useMemo<RailGroup[]>(() => buildRailGroups(allEntries), [allEntries]);

  // Notification activation is stronger than the current rail filters: show
  // Sessions, clear filters, and expand the target's directory when needed.
  useEffect(() => {
    const reveal = app.sessionReveal;
    if (!reveal) return;
    useAppStore.getState().setRailView('sessions');
    if (window.matchMedia('(max-width: 1120px)').matches) setCompactPanelOpen(true);
    setQuery('');
    setNeedsOnly(false);
    const key = `task:${reveal.taskId}`;
    const group = groups.find((candidate) => candidate.entries.some((entry) => entry.key === key));
    if (group?.history) {
      const period = buildHistoryPeriods(group.entries, now).find((candidate) =>
        candidate.entries.some((entry) => entry.key === key),
      );
      if (period) {
        const periodKey = historyPeriodGroupKey(period.key);
        setCollapsed((previous) => {
          const next = new Set(previous);
          next.delete(group.key);
          next.delete(periodKey);
          saveCollapsed(next);
          return next;
        });
        const index = period.entries.findIndex((entry) => entry.key === key);
        if (index >= HISTORY_PERIOD_INITIAL_LIMIT) {
          setHistoryPeriodLimits((previous) => ({
            ...previous,
            [period.key]: Math.max(previous[period.key] ?? 0, index + 1),
          }));
        }
      }
    } else if (
      group &&
      group.entries.findIndex((entry) => entry.key === key) >= ACTIVE_SESSION_GROUP_LIMIT
    ) {
      setExpandedGroups((previous) => new Set(previous).add(group.key));
    }
    useAppStore.getState().clearSessionReveal(reveal.seq);
  }, [app.sessionReveal, groups, now]);

  const recordedByProject = useMemo(() => recordedTasksByProject(allEntries), [allEntries]);

  const visibleGroups = useMemo<RailGroup[]>(() => {
    const normalized = query.trim().toLowerCase();
    return groups
      .map((group) => ({
        ...group,
        entries: group.entries.filter((entry) => {
          if (needsOnly && (entry.kind !== 'task' || !needsAttention(entry.task))) return false;
          if (!normalized) return true;
          const haystack =
            entry.kind === 'task'
              ? [
                  sessionDisplayTitle(entry.task),
                  entry.task.title,
                  entry.task.goalMd,
                  entry.task.projectName,
                  presentedMeta(entry.task).label,
                ].join(' ')
              : [entry.projectName, entry.launch, 'terminal session'].join(' ');
          return haystack.toLowerCase().includes(normalized);
        }),
      }))
      .filter((group) => group.entries.length > 0);
  }, [groups, needsOnly, query]);

  const filteringSessions = Boolean(query.trim() || needsOnly);
  const displayedGroups = useMemo(
    () =>
      visibleGroups.map((group) => ({
        group,
        entries: visibleRailGroupEntries(group, {
          expanded: expandedGroups.has(group.key),
          filtering: filteringSessions,
        }),
      })),
    [expandedGroups, filteringSessions, visibleGroups],
  );

  /** Keyboard order mirrors the visible rows, including History pagination. */
  const orderedEntries = useMemo(
    () =>
      displayedGroups.flatMap(({ group, entries }) => {
        if (!filteringSessions && collapsed.has(group.key)) return [];
        if (!group.history) return entries;
        return buildHistoryPeriods(entries, now).flatMap((period) => {
          if (!filteringSessions && collapsed.has(historyPeriodGroupKey(period.key))) return [];
          return visibleHistoryPeriodEntries(period, {
            filtering: filteringSessions,
            limit: historyPeriodLimits[period.key] ?? HISTORY_PERIOD_INITIAL_LIMIT,
          });
        });
      }),
    [collapsed, displayedGroups, filteringSessions, historyPeriodLimits, now],
  );

  const toggleGroup = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  };

  const toggleGroupExpanded = (key: string): void => {
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleHistoryPeriodMore = (key: HistoryPeriodKey, total: number): void => {
    setHistoryPeriodLimits((previous) => {
      const current = previous[key] ?? HISTORY_PERIOD_INITIAL_LIMIT;
      if (current >= total) {
        const next = { ...previous };
        delete next[key];
        return next;
      }
      return {
        ...previous,
        [key]: Math.min(total, current + HISTORY_PERIOD_MORE_STEP),
      };
    });
  };

  // The open room's row is never hidden: when the selection lands in (or moves
  // into) a collapsed group — e.g. accept sends a task to History — expand it.
  // Manual collapses are respected until the selection or its group changes.
  const selectedKey = app.taskRoomTaskId
    ? `task:${app.taskRoomTaskId}`
    : app.sessionTerminalId
      ? `terminal:${app.sessionTerminalId}`
      : null;
  const selectedGroup = selectedKey
    ? (groups.find((group) => group.entries.some((entry) => entry.key === selectedKey)) ?? null)
    : null;
  const selectedGroupKey = selectedGroup?.key ?? null;
  const selectedEntryIndex = selectedKey
    ? (selectedGroup?.entries.findIndex((entry) => entry.key === selectedKey) ?? -1)
    : -1;
  const selectedHistoryPeriod = useMemo(
    () =>
      selectedKey && selectedGroup?.history
        ? (buildHistoryPeriods(selectedGroup.entries, now).find((period) =>
            period.entries.some((entry) => entry.key === selectedKey),
          ) ?? null)
        : null,
    [now, selectedGroup, selectedKey],
  );
  const selectedHistoryPeriodIndex = selectedKey
    ? (selectedHistoryPeriod?.entries.findIndex((entry) => entry.key === selectedKey) ?? -1)
    : -1;
  useEffect(() => {
    if (!selectedGroupKey) return;
    setCollapsed((prev) => {
      const historyPeriodKey = selectedHistoryPeriod
        ? historyPeriodGroupKey(selectedHistoryPeriod.key)
        : null;
      if (!prev.has(selectedGroupKey) && (!historyPeriodKey || !prev.has(historyPeriodKey))) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(selectedGroupKey);
      if (historyPeriodKey) next.delete(historyPeriodKey);
      saveCollapsed(next);
      return next;
    });
    if (selectedHistoryPeriod && selectedHistoryPeriodIndex >= HISTORY_PERIOD_INITIAL_LIMIT) {
      setHistoryPeriodLimits((previous) => ({
        ...previous,
        [selectedHistoryPeriod.key]: Math.max(
          previous[selectedHistoryPeriod.key] ?? 0,
          selectedHistoryPeriodIndex + 1,
        ),
      }));
    } else if (!selectedGroup?.history && selectedEntryIndex >= ACTIVE_SESSION_GROUP_LIMIT) {
      setExpandedGroups((previous) => {
        if (previous.has(selectedGroupKey)) return previous;
        return new Set(previous).add(selectedGroupKey);
      });
    }
  }, [
    selectedEntryIndex,
    selectedGroup?.history,
    selectedGroupKey,
    selectedHistoryPeriod,
    selectedHistoryPeriodIndex,
    selectedKey,
  ]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target) || !event.metaKey || event.altKey || event.ctrlKey) return;
      let index = -1;
      if (/^[1-9]$/.test(event.key)) index = Number(event.key) - 1;
      if (event.key === '[' || event.key === ']') {
        const currentKey = app.taskRoomTaskId
          ? `task:${app.taskRoomTaskId}`
          : app.sessionTerminalId
            ? `terminal:${app.sessionTerminalId}`
            : null;
        const current = orderedEntries.findIndex((entry) => entry.key === currentKey);
        index =
          event.key === '['
            ? current <= 0
              ? orderedEntries.length - 1
              : current - 1
            : current < 0 || current >= orderedEntries.length - 1
              ? 0
              : current + 1;
      }
      const entry = orderedEntries[index];
      if (!entry) return;
      event.preventDefault();
      if (entry.kind === 'task') {
        void useTaskStore.getState().openTask(entry.task.id);
        app.openTaskRoom(entry.task.id);
      } else {
        // ADR-0046: keyboard navigation follows the project context too.
        const item = useTerminalStore
          .getState()
          .items.find((candidate) => candidate.id === entry.terminalId);
        void useWorkspaceStore.getState().followProject(item?.projectPath ?? null);
        app.openTerminalSession(entry.terminalId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app, orderedEntries]);

  const startSession = (projectPath?: string): void => {
    if (projectPath && workspaceStore.workspace?.path !== projectPath) {
      app.setHomePick(true);
      void workspaceStore.openPath(projectPath);
    }
    // ADR-0042: switch the nav section first — it restores that group's last
    // surface — THEN apply this action's explicit intent (the composer), so
    // the restore never overrides it.
    setView('sessions');
    app.closeTaskRoom();
    app.setSurface('home');
    app.focusComposer();
    if (window.matchMedia('(max-width: 1120px)').matches) setCompactPanelOpen(false);
  };

  const renderSessionEntry = (entry: SessionEntry, showProject: boolean): React.ReactNode =>
    entry.kind === 'task' ? (
      <SessionTaskRow
        key={entry.key}
        task={entry.task}
        showProject={showProject}
        now={now}
        worker={orchestration.workers.some((worker) => worker.taskId === entry.task.id)}
        workerWorking={orchestration.workers.some(
          (worker) => worker.taskId === entry.task.id && worker.status === 'streaming',
        )}
        workerCount={
          orchestration.workers.filter((worker) => worker.commanderTaskId === entry.task.id).length
        }
        orchestrationNeeds={
          orchestration.workers.some((worker) => worker.taskId === entry.task.id)
            ? orchestration.workers.filter(
                (worker) =>
                  worker.taskId === entry.task.id &&
                  permissionForWorker(
                    orchestrationPermissions[worker.commanderTaskId] ?? [],
                    worker.terminalId,
                  ),
              ).length
            : (orchestrationPermissions[entry.task.id]?.length ?? 0)
        }
      />
    ) : (
      <TerminalSessionRow
        key={entry.key}
        terminalId={entry.terminalId}
        launch={entry.launch}
        showProject={showProject}
        worker={orchestration.workers.some((worker) => worker.terminalId === entry.terminalId)}
        working={orchestration.workers.some(
          (worker) => worker.terminalId === entry.terminalId && worker.status === 'streaming',
        )}
      />
    );

  // ADR-0024 (mock B+D): Sessions ⇄ Files segmented tabs. The attention dot on
  // Sessions keeps needs-you visible while the Files tree is showing.
  const railTabs = (
    <div className="sr-tabs" role="tablist" aria-label="Rail panel">
      <button
        role="tab"
        className={`sr-tab ${view === 'files' ? '' : 'active'}`}
        data-testid="rail-tab-sessions"
        aria-selected={view !== 'files'}
        onClick={() => setView('sessions')}
      >
        <Ic name="terminal" size={12} />
        <span>Sessions</span>
        {inbox.length > 0 ? (
          <span
            className="sr-tab-dot"
            data-testid="rail-tab-dot"
            title={`${inbox.length} session(s) need you`}
          />
        ) : null}
      </button>
      <button
        role="tab"
        className={`sr-tab ${view === 'files' ? 'active' : ''}`}
        data-testid="rail-tab-files"
        aria-selected={view === 'files'}
        onClick={() => setView('files')}
      >
        <Ic name="folder" size={12} />
        <span>Files</span>
      </button>
    </div>
  );

  const filesPanel = (
    <>
      <header className="sr-head">
        {railTabs}
        <div className="sr-heading-row">
          <strong>Files</strong>
          <small>drag into a conversation</small>
        </div>
      </header>
      <SessionFilesPane />
    </>
  );

  const sessionsPanel = (
    <>
      <header className="sr-head">
        {railTabs}
        <div className="sr-heading-row">
          <strong>Sessions</strong>
          <small>{allEntries.length} sessions</small>
        </div>
        <div className="sr-search-row">
          <label className="sr-search-box">
            <Ic name="search" size={13} />
            <input
              data-testid="rail-session-search"
              value={query}
              placeholder="Search sessions…"
              aria-label="Search sessions"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <button
            className={`sr-filter ${needsOnly ? 'active' : ''}`}
            data-testid="rail-needs-filter"
            aria-label="Show only sessions that need you"
            aria-pressed={needsOnly}
            title="Needs you only"
            onClick={() => setNeedsOnly((value) => !value)}
          >
            <Ic name="filter" size={13} />
          </button>
        </div>
        <div className="sr-new-wrap">
          <button
            className="sr-new"
            data-testid="home-new-task"
            title="Start from the shared Session Composer"
            onClick={() => startSession()}
          >
            <Ic name="plus" size={13} /> New Session
          </button>
          <button
            className="sr-new-menu"
            data-testid="rail-context"
            title={
              workspaceStore.workspace
                ? `${workspaceStore.workspace.path} — new sessions bind here`
                : 'Pick the project new sessions bind to'
            }
            onClick={showProjects}
          >
            <Ic name="folder" size={12} />
            <span>{workspaceStore.workspace?.displayName ?? 'Project'}</span>
            <Ic name="chevron" size={10} />
          </button>
        </div>
      </header>

      <div className="sr-scroll">
        {visibleGroups.length === 0 ? (
          <div className="sr-empty">
            {groups.length === 0
              ? 'No sessions yet. Start with Charter Agent, Claude or Codex.'
              : 'No sessions match this search or filter.'}
          </div>
        ) : (
          displayedGroups.map(({ group, entries }) => {
            const isCollapsed = !filteringSessions && collapsed.has(group.key);
            const isExpanded = expandedGroups.has(group.key);
            const hiddenCount = Math.max(0, group.entries.length - ACTIVE_SESSION_GROUP_LIMIT);
            const hasOverflow = !group.history && !filteringSessions && hiddenCount > 0;
            const historyPeriods = group.history ? buildHistoryPeriods(entries, now) : [];
            return (
              <section
                key={group.key}
                className="sr-group"
                data-group-key={group.key}
                data-testid={`rail-session-group-${group.history ? 'history' : group.name}`}
              >
                <div className="sr-group-head">
                  <button
                    className="sr-group-toggle"
                    data-testid={`rail-group-${group.history ? 'history' : group.name}`}
                    aria-expanded={!isCollapsed}
                    title={group.path ?? group.name}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <Ic
                      name="chevron"
                      size={12}
                      className={`sr-group-chevron ${isCollapsed ? 'closed' : ''}`}
                    />
                    <Ic name={group.history ? 'clock' : 'folder'} size={12} />
                    <strong>{group.name}</strong>
                    <span className="sr-group-count">{group.entries.length}</span>
                  </button>
                  {!group.history && group.path ? (
                    <button
                      className="sr-group-add"
                      aria-label={`New session in ${group.name}`}
                      title={`New session in ${group.name}`}
                      onClick={() => startSession(group.path ?? undefined)}
                    >
                      <Ic name="plus" size={12} />
                    </button>
                  ) : null}
                </div>
                {isCollapsed ? null : (
                  <div className={`sr-group-items ${group.history ? 'sr-history-groups' : ''}`}>
                    {group.history
                      ? historyPeriods.map((period) => {
                          const periodGroupKey = historyPeriodGroupKey(period.key);
                          const periodCollapsed =
                            !filteringSessions && collapsed.has(periodGroupKey);
                          const periodLimit =
                            historyPeriodLimits[period.key] ?? HISTORY_PERIOD_INITIAL_LIMIT;
                          const periodEntries = visibleHistoryPeriodEntries(period, {
                            filtering: filteringSessions,
                            limit: periodLimit,
                          });
                          const periodHiddenCount = Math.max(
                            0,
                            period.entries.length - periodEntries.length,
                          );
                          const hasPeriodOverflow =
                            !filteringSessions &&
                            period.entries.length > HISTORY_PERIOD_INITIAL_LIMIT;
                          const periodFullyExpanded = periodHiddenCount === 0;
                          return (
                            <section
                              key={period.key}
                              className="sr-history-period"
                              data-testid={`rail-history-period-${period.key}`}
                            >
                              <button
                                type="button"
                                className="sr-history-period-toggle"
                                data-testid={`rail-history-period-toggle-${period.key}`}
                                aria-expanded={!periodCollapsed}
                                onClick={() => toggleGroup(periodGroupKey)}
                              >
                                <Ic
                                  name="chevron"
                                  size={11}
                                  className={`sr-group-chevron ${periodCollapsed ? 'closed' : ''}`}
                                />
                                <strong>{period.label}</strong>
                                <span>{period.entries.length}</span>
                              </button>
                              {periodCollapsed ? null : (
                                <div className="sr-history-period-items">
                                  {periodEntries.map((entry) => renderSessionEntry(entry, true))}
                                  {hasPeriodOverflow ? (
                                    <button
                                      type="button"
                                      className={`sr-group-more ${periodFullyExpanded ? 'expanded' : ''}`}
                                      data-testid={`rail-history-more-${period.key}`}
                                      aria-expanded={periodFullyExpanded}
                                      aria-label={
                                        periodFullyExpanded
                                          ? `Show only five sessions in ${period.label}`
                                          : `Show more sessions in ${period.label}`
                                      }
                                      onClick={() =>
                                        toggleHistoryPeriodMore(period.key, period.entries.length)
                                      }
                                    >
                                      <span>{periodFullyExpanded ? 'Show less' : 'More'}</span>
                                      <small>
                                        {periodFullyExpanded
                                          ? `${period.entries.length} shown`
                                          : `${periodHiddenCount} more`}
                                      </small>
                                      <Ic name="chevron" size={11} />
                                    </button>
                                  ) : null}
                                </div>
                              )}
                            </section>
                          );
                        })
                      : entries.map((entry) => renderSessionEntry(entry, false))}
                    {hasOverflow ? (
                      <button
                        type="button"
                        className={`sr-group-more ${isExpanded ? 'expanded' : ''}`}
                        data-testid="rail-group-more"
                        aria-expanded={isExpanded}
                        aria-label={
                          isExpanded
                            ? `Show only three sessions in ${group.name}`
                            : `Show ${hiddenCount} more sessions in ${group.name}`
                        }
                        onClick={() => toggleGroupExpanded(group.key)}
                      >
                        <span>{isExpanded ? 'Show less' : 'More'}</span>
                        <small>
                          {isExpanded ? `${group.entries.length} shown` : `${hiddenCount} more`}
                        </small>
                        <Ic name="chevron" size={11} />
                      </button>
                    ) : null}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
    </>
  );

  const inboxPanel = (
    <>
      <header className="sr-head sr-head-plain">
        <div className="sr-heading-row">
          <strong>Needs attention</strong>
          <small>{inbox.length} waiting</small>
        </div>
      </header>
      <div className="sr-scroll" data-testid="rail-inbox-panel">
        <div className="sr-inbox-intro">
          <strong>Move work forward</strong>
          <span>Questions, plans, permissions and reviews waiting for you appear here.</span>
        </div>
        {inbox.length === 0 ? (
          <div className="sr-empty">Nothing needs you right now.</div>
        ) : (
          <div className="sr-inbox-list">
            {inbox.map((task) => (
              <SessionTaskRow key={task.id} task={task} now={now} />
            ))}
          </div>
        )}
      </div>
    </>
  );

  const filteredRecent = recent
    .filter((project) =>
      `${project.displayName} ${project.path}`.toLowerCase().includes(projectQuery.toLowerCase()),
    )
    .slice(0, 8);

  // ADR-0034: forget a project. Removal is arm-then-confirm on the icon; a
  // project that still has recorded Sessions asks once more with the count
  // (active and History alike — those records go with it; files on disk are
  // never touched).
  const removeProject = async (path: string, recordedCount: number): Promise<void> => {
    if (
      recordedCount > 0 &&
      !window.confirm(
        `Remove this project and its ${recordedCount} recorded session${recordedCount === 1 ? '' : 's'} from Charter?\n\nFiles on disk are not touched.`,
      )
    ) {
      return;
    }
    const res = await rpcResult('workspace.remove', { path });
    if (!res.ok) {
      useAppStore.getState().pushToast('error', res.error.userMessage);
      return;
    }
    setRecent((items) => items.filter((item) => item.path !== path));
    await useTaskStore.getState().refreshTasks();
    useAppStore
      .getState()
      .pushToast(
        'success',
        res.data.removedSessions > 0
          ? `Project removed (${res.data.removedSessions} session${res.data.removedSessions === 1 ? '' : 's'} deleted). Files on disk were not touched.`
          : 'Project removed. Files on disk were not touched.',
      );
  };

  const openFolderAction = (): void => {
    setAddMenuOpen(false);
    void workspaceStore.openViaDialog();
  };
  const newProjectAction = (): void => {
    setAddMenuOpen(false);
    app.setNewProjectOpen(true);
  };

  // Shared by the "+" dropdown and the empty state (distinct testids so both
  // may render at once without ambiguity).
  const addProjectItems = (idSuffix: '' | '-empty'): React.JSX.Element => (
    <>
      <button
        className="sr-add-item"
        role="menuitem"
        data-testid={`home-open-folder${idSuffix}`}
        onClick={openFolderAction}
      >
        <span className="sr-add-ic">
          <Ic name="folder-open" size={14} />
        </span>
        <span className="sr-add-copy">
          <strong>Open folder…</strong>
          <small>Use an existing folder on disk</small>
        </span>
      </button>
      <button
        className="sr-add-item"
        role="menuitem"
        data-testid={`home-new-project${idSuffix}`}
        onClick={newProjectAction}
      >
        <span className="sr-add-ic">
          <Ic name="folder-plus" size={14} />
        </span>
        <span className="sr-add-copy">
          <strong>New project…</strong>
          <small>Create empty, or clone a repository</small>
        </span>
      </button>
    </>
  );

  const projectsPanel = (
    <>
      <header className="sr-head">
        <div className="sr-heading-row">
          <strong>Projects</strong>
          <small>working context</small>
        </div>
        <div className="sr-search-row">
          <label className="sr-search-box sr-project-search">
            <Ic name="search" size={13} />
            <input
              value={projectQuery}
              placeholder="Search projects…"
              aria-label="Search projects"
              onChange={(event) => setProjectQuery(event.currentTarget.value)}
            />
          </label>
          <div className="sr-add-wrap" ref={addMenuRef}>
            <button
              className={`sr-filter ${addMenuOpen ? 'active' : ''}`}
              data-testid="rail-add-project"
              title="Add project"
              aria-label="Add project"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((open) => !open)}
            >
              <Ic name="plus" size={13} />
            </button>
            {addMenuOpen ? (
              <div className="sr-add-menu" role="menu" data-testid="rail-add-menu">
                {addProjectItems('')}
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <div className="sr-scroll" data-testid="rail-projects-panel">
        {recent.length === 0 ? (
          <div className="sr-project-empty" data-testid="rail-projects-empty">
            <p>No projects yet</p>
            <small>Add one to give sessions a working context</small>
            {addProjectItems('-empty')}
          </div>
        ) : filteredRecent.length === 0 ? (
          <div className="sr-empty">No projects match this search.</div>
        ) : null}
        {filteredRecent.map((project) => {
          const active = workspaceStore.workspace?.path === project.path;
          const activeCount =
            groups.find((group) => group.path === project.path)?.entries.length ?? 0;
          const outsideCount = discoveredByProject.get(project.path) ?? 0;
          const recordedCount = recordedByProject.get(project.path) ?? 0;
          return (
            <div className={`sr-project-wrap ${active ? 'active' : ''}`} key={project.path}>
              <button
                className={`sr-project ${active ? 'active' : ''}`}
                data-testid={`home-recent-${project.path}`}
                title={`${project.path} — open project files`}
                onClick={() => {
                  // ADR-0029: "open project files" = the Editor surface plus
                  // the rail's Files tree (the one project tree). ADR-0042:
                  // setProjectTool pairs the rail's Files view itself.
                  setProjectsPanelOpen(false);
                  if (active) {
                    app.setProjectTool('editor');
                    return;
                  }
                  app.setHomePick(true);
                  void workspaceStore
                    .openPath(project.path)
                    .then(() => useAppStore.getState().setProjectTool('editor'));
                }}
              >
                <Ic name="folder" size={14} />
                <span className="sr-project-copy">
                  <strong>{project.displayName}</strong>
                  <small
                    data-testid={`project-discovered-${project.path}`}
                    title={
                      `${activeCount} active session${activeCount === 1 ? '' : 's'} — settled History and archived sessions are not counted` +
                      (outsideCount > 0
                        ? `\n${outsideCount} conversation${outsideCount === 1 ? '' : 's'} ran outside Charter — the clock button lists everything`
                        : '')
                    }
                  >
                    {activeCount} active
                    {outsideCount > 0 ? ` · ${outsideCount} outside` : ''}
                  </small>
                </span>
                {active ? (
                  <span className="sr-project-current" title="Current project">
                    <Ic name="check" size={12} />
                  </span>
                ) : null}
              </button>
              <button
                className="sr-project-use"
                data-testid={`project-history-${project.path}`}
                title={`Session history of ${project.displayName} — Charter and outside`}
                aria-label={`Session history of ${project.displayName}`}
                onClick={() => {
                  setProjectsPanelOpen(false);
                  app.openArchaeology(project.path);
                }}
              >
                <Ic name="clock" size={13} />
              </button>
              <button
                className="sr-project-use"
                data-testid={`project-spawn-pi-${project.path}`}
                title={`New session in ${project.displayName}`}
                aria-label={`New session in ${project.displayName}`}
                onClick={() => startSession(project.path)}
              >
                <Ic name="plus" size={13} />
              </button>
              <ArmedIconButton
                icon="trash"
                className="sr-project-remove"
                testid={`project-remove-${project.path}`}
                title={`Remove ${project.displayName} from Charter`}
                armedTitle="Click again to remove this project"
                onConfirm={() => void removeProject(project.path, recordedCount)}
              />
            </div>
          );
        })}
        {discoveryEnabled && (unknownDirs.length > 0 || discovered.length > 0) ? (
          <button
            className="sr-agent-activity"
            data-testid="rail-agent-activity"
            onClick={() => {
              setProjectsPanelOpen(false);
              app.openArchaeology(null);
            }}
          >
            <Ic name="clock" size={14} />
            <span className="sr-project-copy">
              <strong>Agent activity</strong>
              <small>
                {unknownDirs.length > 0
                  ? `${unknownDirs.length} director${unknownDirs.length === 1 ? 'y' : 'ies'} never opened here`
                  : 'everything discovered on this machine'}
              </small>
            </span>
            <Ic name="chevron" size={12} className="sr-agent-activity-chevron" />
          </button>
        ) : null}
      </div>
    </>
  );

  return (
    <aside
      className={`sr-rail view-${view} ${projectsPanelOpen ? 'projects-panel-open' : ''} ${
        compactPanelOpen ? 'compact-open' : ''
      }`}
      data-testid="home-sidebar"
      aria-label={view === 'skills' ? 'Skills' : 'Sessions'}
    >
      <ActivityBar
        active={view}
        projectsOpen={projectsPanelOpen}
        onSelect={setView}
        onProjects={() => {
          if (view !== 'projects') {
            showProjects();
            return;
          }
          setProjectsPanelOpen(true);
          if (window.matchMedia('(max-width: 1120px)').matches) {
            setCompactPanelOpen((open) => !open);
          }
        }}
        onRemotes={() => app.openRemotes()}
      />
      <button
        type="button"
        className="sr-compact-backdrop"
        aria-label="Close navigation drawer"
        onClick={() => setCompactPanelOpen(false)}
      />
      <section className="sr-panel">
        <button
          type="button"
          className="sr-compact-close"
          data-testid="rail-compact-close"
          aria-label="Close navigation drawer"
          onClick={() => setCompactPanelOpen(false)}
        >
          <Ic name="x" size={13} />
        </button>
        {view === 'inbox' ? (
          inboxPanel
        ) : view === 'projects' ? (
          projectsPanel
        ) : view === 'skills' ? (
          <SkillsRailPanel />
        ) : view === 'files' ? (
          filesPanel
        ) : (
          sessionsPanel
        )}
      </section>
    </aside>
  );
}
