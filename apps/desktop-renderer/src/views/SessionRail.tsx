import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MissionSnapshotDto, RecentWorkspaceDto, TaskDto } from '@pi-ide/ipc-contracts';
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
import { MemoryRailPanel } from './MemoryRailPanel.js';
import { useGlowTasks } from './useGlow.js';
import { sessionDisplayTitle } from '../store/sessionAttention.js';
import { useOrchestrationStore } from '../store/orchestrationStore.js';
import {
  ACTIVE_SESSION_GROUP_LIMIT,
  HISTORY_PERIOD_INITIAL_LIMIT,
  HISTORY_PERIOD_MORE_STEP,
  buildHistoryPeriods,
  buildRailGroups,
  isHistoryEntry,
  missionSessionStatus,
  recordedTasksByProject,
  visibleHistoryPeriodEntries,
  visibleRailGroupEntries,
  type HistoryPeriodKey,
  type MissionSessionLink,
  type RailGroup,
  type SessionEntry,
} from './rail-groups.js';
import { ActivityBar } from './ActivityBar.js';
import { MissionRailPanel } from './mission/MissionRailPanel.js';
import { SessionRenameDialog } from './SessionRenameDialog.js';
import { visibleAttentionTasks } from '../store/attentionDismissals.js';
import {
  externalAgentLifecycle,
  externalSessionTitle,
  externalTerminalLifecycle,
  isExternalCli,
} from './external-terminal-lifecycle.js';
import {
  missionAwareWorking,
  missionRuntimeStatusByTerminal,
  type MissionRuntimeStatus,
} from './mission-runtime-status.js';
import { TERMINAL_MISSION_STATES } from './mission/mission-view-model.js';
import { agentDisplayName } from '../store/agentCatalogStore.js';
import { runningSessionTargets, type RunningSessionTarget } from './session-running-targets.js';
import { visibleProjectSessionTasks } from './mission-session-visibility.js';

export { isHistoryEntry, type SessionEntry } from './rail-groups.js';

const COLLAPSED_KEY = 'charter.rail.collapsed.v2';
const RAIL_WIDTH_KEY = 'charter.rail.width.v3';
const RAIL_WIDTH_LEGACY_KEY = 'charter.rail.width.v2';
const RAIL_WIDTH_LEGACY_DEFAULT = 336;
const RAIL_WIDTH_DEFAULT = 312;
const RAIL_WIDTH_MIN = 288;
const RAIL_WIDTH_MAX = 520;
const SESSION_TOOLTIP_DELAY_MS = 180;
const ACTION_TOOLTIP_DELAY_MS = 80;
async function stopExternalSession(taskId: string): Promise<boolean> {
  // Keep process termination and durable Session finalization inside one host
  // operation. A detached/restored PTY can be absent from the renderer while
  // its task row still says active; terminal.kill alone would be a false success.
  const result = await rpcResult('external.endSession', { taskId, force: true });
  return result.ok && result.data.ended;
}

async function stopRunningSession(target: RunningSessionTarget): Promise<boolean> {
  if (target.kind === 'task') {
    const result = await rpcResult('task.stop', { taskId: target.taskId });
    return result.ok;
  }
  if (target.kind === 'external') {
    return stopExternalSession(target.taskId);
  }
  if (target.kind === 'terminal') {
    // The user already confirmed the global destructive action in the rail.
    const result = await rpcResult('terminal.kill', { id: target.terminalId, force: true });
    return result.ok && result.data.closed;
  }
  const cancelled = await rpcResult('mission.cancelAssignment', {
    missionId: target.missionId,
    assignmentId: target.assignmentId,
    reason: 'Stopped by user from the Sessions rail',
  });
  if (!cancelled.ok) return false;
  // Cancellation records lifecycle intent and wakes the outbox, but Stop all
  // promises completion now. Close the resident runtime synchronously too.
  const closed = await rpcResult('mission.closeRuntime', {
    missionId: target.missionId,
    assignmentId: target.assignmentId,
    reason: 'Stopped by user from the Sessions rail',
  });
  return closed.ok;
}

function clampRailWidth(width: number): number {
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.round(width)));
}

function loadRailWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(RAIL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) return clampRailWidth(saved);

    // Carry deliberate user resizing forward, but let the old 336px product
    // default adopt the denser rail automatically.
    const legacy = Number(window.localStorage.getItem(RAIL_WIDTH_LEGACY_KEY));
    if (Number.isFinite(legacy) && legacy > 0 && Math.round(legacy) !== RAIL_WIDTH_LEGACY_DEFAULT) {
      return clampRailWidth(legacy);
    }
  } catch {
    // best-effort UI state
  }
  return RAIL_WIDTH_DEFAULT;
}

function saveRailWidth(width: number): void {
  try {
    window.localStorage.setItem(RAIL_WIDTH_KEY, String(clampRailWidth(width)));
  } catch {
    // best-effort UI state
  }
}

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

function providerForTask(task: TaskDto): string {
  return task.external?.cli ?? 'pi';
}

function providerLabel(provider: string): string {
  return agentDisplayName(provider, true);
}

function missionProvider(
  snapshot: MissionSnapshotDto,
  assignment: MissionSnapshotDto['assignments'][number],
  attempt: MissionSnapshotDto['attempts'][number] | null,
): MissionSessionLink['provider'] {
  const principal = snapshot.principals.find(
    (candidate) => candidate.id === assignment.assigneePrincipalId,
  );
  const provider = principal?.provider ?? attempt?.requestedRuntime ?? null;
  if (provider === 'managed' || !provider) return 'pi';
  return provider;
}

function missionAssignmentDepth(
  snapshot: MissionSnapshotDto,
  assignment: MissionSnapshotDto['assignments'][number],
): number {
  const byId = new Map(snapshot.assignments.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>([assignment.id]);
  let parentId = assignment.supervisorAssignmentId;
  let depth = 0;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.supervisorAssignmentId ?? null;
  }
  return depth;
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
  depth = 0,
  missionSelected = false,
  workerWorking = false,
  missionRuntimeStatus = null,
  mission,
}: {
  task: TaskDto;
  /** Rows inside a project group drop the redundant project name (ADR-0023). */
  showProject?: boolean;
  now: number;
  worker?: boolean;
  depth?: number;
  missionSelected?: boolean;
  workerWorking?: boolean;
  missionRuntimeStatus?: MissionRuntimeStatus | null;
  mission?: MissionSessionLink;
}): React.JSX.Element {
  const app = useAppStore();
  const hoverTooltip = useSessionHoverTooltip();
  const actionTooltip = useSessionHoverTooltip();
  const activity = useActivityStore((state) => state.perTask[task.id]);
  const glowTasks = useGlowTasks();
  const completion = app.sessionCompletionSignals.find((signal) => signal.taskId === task.id);
  const reply = app.sessionReplySignals.find((signal) => signal.taskId === task.id);
  const selected = app.taskRoomTaskId === task.id || missionSelected;
  const provider = mission?.provider ?? providerForTask(task);
  const displayTitle = mission?.agentName ?? sessionDisplayTitle(task);
  const showDetail = showProject || Boolean(mission);
  const running = RUNNING_TASK_STATES.has(task.state);
  const meta = presentedMeta(task);
  const action = running ? currentActionLine(activity) : null;
  const missionSettled = missionRuntimeStatus !== null && missionRuntimeStatus !== 'active';
  const missionStatus = mission ? missionSessionStatus(mission) : null;
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
  const working = missionStatus
    ? missionAwareWorking(externalWorking || workerWorking, missionRuntimeStatus)
    : task.external
      ? missionAwareWorking(externalWorking || workerWorking, missionRuntimeStatus)
      : ['EXPLORING', 'PLANNING', 'IN_PROGRESS', 'VERIFYING'].includes(task.state);
  const badge = missionStatus
    ? {
        label: missionStatus.label === 'Active' && working ? 'Working' : missionStatus.label,
        tone: missionStatus.tone,
      }
    : missionSettled
      ? missionRuntimeStatus === 'succeeded'
        ? { label: 'Done', tone: 'answered' }
        : missionRuntimeStatus === 'failed'
          ? { label: 'Failed', tone: 'failed' }
          : { label: 'Stopped', tone: 'neutral' }
      : statusBadge(task);
  const resumable = canResumeExternal(task) && !live;
  const endable = task.external !== null && live;
  const deletable = canArchiveTask(task) && !endable;
  const hasActions = endable || resumable || deletable;
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
  const missionDetail = mission?.waitingFor.length
    ? `Waiting for ${mission.waitingFor.join(', ')}`
    : missionStatus
      ? badge?.label
      : undefined;
  const rowDescription = mission
    ? `${providerLabel(provider)} · ${displayTitle} · ${mission.taskTitle} — ${missionDetail ?? 'Mission work'}`
    : `${providerLabel(provider)} · ${displayTitle} · ${task.projectName} — ${
        working ? 'Agent working' : (externalLifecycle?.summary ?? meta.label)
      }`;

  const open = (): void => {
    void useTaskStore.getState().openTask(task.id);
    app.openTaskRoom(task.id);
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
            `${agentDisplayName(task.external!.cli)} did not exit. Close its terminal to force it to stop.`,
          );
        }
      })
      .finally(() => setEndingExternal(false));
  };

  return (
    <div
      className={`sr-row-wrap ${showDetail ? 'has-detail' : ''} ${hasActions ? 'has-actions' : ''} ${worker || depth > 0 ? 'sr-orch-worker' : ''}`}
      style={{ '--sr-depth': Math.max(depth, worker ? 1 : 0) } as React.CSSProperties}
    >
      <button
        className={`sr-session ${showDetail ? 'has-detail' : ''} ${selected ? 'selected' : ''} ${working ? 'is-working' : ''} ${glowTasks.has(task.id) ? 'glow-pulse' : ''} ${completion ? `completion-ripple completion-${completion.tone}` : ''} ${reply ? 'reply-shake' : ''}`}
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
            {badge || !showDetail ? (
              <span className="sr-session-tail">
                {badge ? <span className={`sr-state ${badge.tone}`}>{badge.label}</span> : null}
                {!showDetail ? (
                  <time className="sr-session-time" dateTime={task.updatedAt}>
                    {timeAgo(task.updatedAt, now)}
                  </time>
                ) : null}
              </span>
            ) : null}
          </span>
          {showDetail ? (
            <span className="sr-session-detail">
              <span data-testid={`home-task-ticker-${task.id}`}>
                {mission ? (
                  <>
                    {mission.taskTitle} · {missionDetail ?? 'Mission work'}
                  </>
                ) : (
                  <>
                    {task.projectName} ·{' '}
                    {action?.label ??
                      (working ? 'Agent is working...' : null) ??
                      externalLifecycle?.summary ??
                      (isAnswered(task)
                        ? task.external
                          ? 'Session ended · no file changes'
                          : 'Answered · no file changes'
                        : meta.label)}
                  </>
                )}
              </span>
              <time dateTime={task.updatedAt}>{timeAgo(task.updatedAt, now)}</time>
            </span>
          ) : null}
        </span>
      </button>
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
          {deletable ? (
            <ArmedIconButton
              icon="trash"
              className="sr-delete"
              testid={`home-delete-${task.id}`}
              title="Delete session"
              armedTitle="Click again to permanently delete"
              onConfirm={() => void useTaskStore.getState().deleteTask(task.id)}
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
  depth = 0,
  missionSelected = false,
  working = false,
  missionRuntimeStatus = null,
  mission,
}: {
  terminalId: string;
  launch: string;
  showProject?: boolean;
  worker?: boolean;
  depth?: number;
  missionSelected?: boolean;
  working?: boolean;
  missionRuntimeStatus?: MissionRuntimeStatus | null;
  mission?: MissionSessionLink;
}): React.JSX.Element | null {
  const app = useAppStore();
  const hoverTooltip = useSessionHoverTooltip();
  const item = useTerminalStore((state) => state.items.find((entry) => entry.id === terminalId));
  if (!item) return null;
  const selected = app.sessionTerminalId === terminalId || missionSelected;
  const provider = mission?.provider ?? launch;
  const showDetail = showProject || Boolean(mission);
  const missionSettled = missionRuntimeStatus !== null && missionRuntimeStatus !== 'active';
  const missionStatus = mission ? missionSessionStatus(mission) : null;
  const visiblyWorking = missionAwareWorking(working, missionRuntimeStatus);
  const missionStatusLabel =
    missionStatus?.label === 'Active' && visiblyWorking ? 'Working' : missionStatus?.label;
  // The brand mark carries the provider — never repeat the CLI name as the
  // title. Generic launch titles read as an unnamed session.
  const sessionName =
    mission?.agentName ??
    (isExternalCli(launch) ? externalSessionTitle(launch, item.title) : item.title);
  const missionDetail = mission?.waitingFor.length
    ? `Waiting for ${mission.waitingFor.join(', ')}`
    : missionStatusLabel;
  const terminalState = item.exited
    ? 'Process ended'
    : item.remote
      ? 'Remote SSH session live'
      : visiblyWorking
        ? `${providerLabel(provider)} working`
        : 'Terminal live';
  const rowDescription = mission
    ? `${providerLabel(provider)} · ${sessionName} · ${mission.taskTitle} — ${missionDetail ?? terminalState}`
    : `${providerLabel(provider)} · ${sessionName} · ${item.contextLabel} — ${terminalState}`;
  return (
    <div
      className={`sr-row-wrap ${showDetail ? 'has-detail' : ''} ${worker || depth > 0 ? 'sr-orch-worker' : ''}`}
      style={{ '--sr-depth': Math.max(depth, worker ? 1 : 0) } as React.CSSProperties}
    >
      <button
        className={`sr-session ${showDetail ? 'has-detail' : ''} ${selected ? 'selected' : ''} ${visiblyWorking ? 'is-working' : ''}`}
        data-testid={`session-terminal-${terminalId}`}
        data-session-key={`terminal:${terminalId}`}
        data-working={visiblyWorking ? 'true' : 'false'}
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
        <ProviderMark provider={provider} className={visiblyWorking ? 'is-working' : ''} />
        <span className="sr-session-copy">
          <span className="sr-session-title">
            <span className={`sr-live-dot ${item.exited ? '' : 'live'}`} />
            {item.remote ? <span className="sr-remote-mark">⌁</span> : null}
            <b>{sessionName}</b>
            {item.exited ? <span className="sr-state neutral">Ended</span> : null}
            {!item.exited && (missionStatus || missionSettled) ? (
              <span
                className={`sr-state ${
                  missionStatus
                    ? missionStatus.tone
                    : missionRuntimeStatus === 'succeeded'
                      ? 'answered'
                      : missionRuntimeStatus === 'failed'
                        ? 'failed'
                        : 'neutral'
                }`}
              >
                {missionStatus
                  ? missionStatusLabel
                  : missionRuntimeStatus === 'succeeded'
                    ? 'Done'
                    : missionRuntimeStatus === 'failed'
                      ? 'Failed'
                      : 'Stopped'}
              </span>
            ) : null}
          </span>
          {showDetail ? (
            <span className="sr-session-detail">
              <span>
                {mission ? (
                  <>
                    {mission.taskTitle} · {missionDetail ?? terminalState}
                  </>
                ) : (
                  <>
                    {item.projectName} ·{' '}
                    {item.exited
                      ? 'Process ended · session retained'
                      : item.remote
                        ? 'Remote SSH session is live'
                        : 'Terminal session is live'}
                  </>
                )}
              </span>
            </span>
          ) : null}
        </span>
      </button>
      {hoverTooltip.tooltip}
    </div>
  );
}

function MissionRuntimeRow({
  entry,
  now,
}: {
  entry: Extract<SessionEntry, { kind: 'mission' }>;
  now: number;
}): React.JSX.Element {
  const app = useAppStore();
  const hoverTooltip = useSessionHoverTooltip();
  const status = missionSessionStatus(entry.mission);
  const selected =
    app.missionCenter?.missionId === entry.mission.missionId &&
    app.missionCenter.assignmentId === entry.mission.assignmentId;
  const transport = entry.mission.waitingFor.length
    ? `Waiting for ${entry.mission.waitingFor.join(', ')}`
    : entry.mission.taskState === 'BLOCKED'
      ? 'Waiting for dependencies'
      : entry.mission.transport === 'acp'
        ? 'ACP session'
        : entry.mission.transport === 'terminal'
          ? 'Terminal session'
          : entry.mission.transport === 'native'
            ? 'Managed session'
            : 'Session starting';
  const detail =
    entry.mission.taskState === 'BLOCKED' ? transport : `${entry.mission.taskTitle} · ${transport}`;
  const description = `${entry.mission.agentName} · ${entry.mission.taskTitle} · ${transport}`;

  return (
    <div
      className="sr-row-wrap sr-orch-worker sr-mission-runtime"
      style={{ '--sr-depth': Math.max(1, entry.mission.depth) } as React.CSSProperties}
    >
      <button
        type="button"
        className={`sr-session has-detail ${selected ? 'selected' : ''} ${status.working ? 'is-working' : ''}`}
        data-testid={`session-mission-${entry.mission.assignmentId}`}
        data-session-key={entry.key}
        data-working={status.working ? 'true' : 'false'}
        aria-label={description}
        {...hoverTooltip.triggerProps(
          description,
          `session-tooltip-mission-${entry.mission.assignmentId}`,
        )}
        onClick={() => {
          hoverTooltip.hide();
          app.openMission(entry.mission.missionId, entry.mission.assignmentId, 'session');
        }}
      >
        <ProviderMark
          provider={entry.mission.provider}
          className={status.working ? 'is-working' : ''}
        />
        <span className="sr-session-copy">
          <span className="sr-session-title">
            <span className={`sr-live-dot ${status.live ? 'live' : ''}`} />
            <b>{entry.mission.agentName}</b>
            <span className={`sr-state ${status.tone}`}>{status.label}</span>
          </span>
          <span className="sr-session-detail">
            <span>{detail}</span>
            <time dateTime={entry.updatedAt}>{timeAgo(entry.updatedAt, now)}</time>
          </span>
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
  const attentionDismissals = useTaskStore((s) => s.attentionDismissals);
  const clearAttention = useTaskStore((s) => s.clearAttention);
  const terminalStore = useTerminalStore();
  const taskByTerminal = useExternalStore((state) => state.taskByTerminal);
  const externalSessions = useExternalStore((state) => state.sessions);
  const orchestration = useOrchestrationStore((state) => state.snapshot);
  const missionsById = useOrchestrationStore((state) => state.missionsById);
  const missionOrder = useOrchestrationStore((state) => state.missionOrder);
  const deletedMissionsById = useOrchestrationStore((state) => state.deletedMissionsById);
  const deletedMissionOrder = useOrchestrationStore((state) => state.deletedMissionOrder);
  const topLevelSessionTasks = useMemo(
    () =>
      visibleProjectSessionTasks(
        tasks,
        [...missionOrder, ...deletedMissionOrder].flatMap((id) => {
          const snapshot = missionsById[id] ?? deletedMissionsById[id];
          return snapshot ? [snapshot] : [];
        }),
      ),
    [deletedMissionOrder, deletedMissionsById, missionOrder, missionsById, tasks],
  );
  const missionRuntimeStatuses = useMemo(
    () => missionRuntimeStatusByTerminal(Object.values(missionsById)),
    [missionsById],
  );
  const inbox = visibleAttentionTasks(tasks, attentionDismissals);
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
  const [projectQuery, setProjectQuery] = useState('');
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [projectMenuPath, setProjectMenuPath] = useState<string | null>(null);
  const [stopAllConfirmOpen, setStopAllConfirmOpen] = useState(false);
  const [stoppingAll, setStoppingAll] = useState(false);
  const [stoppingCount, setStoppingCount] = useState(0);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const stopAllRef = useRef<HTMLDivElement | null>(null);
  const stopAllTriggerRef = useRef<HTMLButtonElement | null>(null);
  const stopAllCancelRef = useRef<HTMLButtonElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const railWidthRef = useRef(loadRailWidth());
  const railResizingRef = useRef(false);
  const [railWidth, setRailWidth] = useState(railWidthRef.current);
  const [railResizing, setRailResizing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const refreshRecent = (): void => {
    void rpcResult('workspace.recent', {}).then((result) => {
      if (result.ok) setRecent(result.data.items);
    });
  };
  const setView = (next: RailView): void => {
    if (next === 'missions') app.openMission(app.missionCenter?.missionId ?? null);
    else app.setRailView(next);
    if (window.matchMedia('(max-width: 1120px)').matches) setCompactPanelOpen(true);
    // Rail navigation dismisses the Remotes surface — switching the left panel
    // while the main area stays parked on hosts reads as a dead click.
    if (useAppStore.getState().remotesOpen) useAppStore.getState().closeRemotes();
    if (next !== 'projects') setProjectsPanelOpen(false);
    setAddMenuOpen(false);
  };

  const showProjects = (): void => {
    refreshRecent();
    setView('projects');
    setProjectsPanelOpen(true);
  };

  useEffect(() => {
    useTaskStore.getState().init();
    void useTaskStore.getState().refreshTasks();
    terminalStore.init();
    useExternalStore.getState().init();
    useOrchestrationStore.getState().init();
    refreshRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceStore.workspace?.path]);

  // Selecting Projects establishes a browsed project without changing the
  // working context. Prefer the current workspace, then the newest available
  // saved project. Subsequent row clicks own the selection explicitly.
  useEffect(() => {
    if (view !== 'projects' || app.projectCenter || recent.length === 0) return;
    const preferred =
      recent.find((project) => project.path === workspaceStore.workspace?.path) ??
      recent.find((project) => project.exists) ??
      recent[0];
    if (preferred) app.openProjectCenter(preferred.path);
  }, [app, recent, view, workspaceStore.workspace?.path]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!railResizing) return;
    document.documentElement.classList.add('sr-resizing');
    return () => document.documentElement.classList.remove('sr-resizing');
  }, [railResizing]);

  const railWidthLimit = (): number =>
    Math.max(RAIL_WIDTH_MIN, Math.min(RAIL_WIDTH_MAX, window.innerWidth - 560));

  const updateRailWidth = (width: number, persist = false): void => {
    const next = Math.min(railWidthLimit(), clampRailWidth(width));
    railWidthRef.current = next;
    setRailWidth(next);
    if (persist) saveRailWidth(next);
  };

  const resizeRailFromPointer = (clientX: number): void => {
    const left = railRef.current?.getBoundingClientRect().left ?? 0;
    updateRailWidth(clientX - left);
  };

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

  useEffect(() => {
    if (!projectMenuPath) return;
    const close = (event: MouseEvent): void => {
      if (!(event.target as Element | null)?.closest('.sr-project-menu-wrap')) {
        setProjectMenuPath(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setProjectMenuPath(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [projectMenuPath]);

  useEffect(() => {
    if (!stopAllConfirmOpen) return;
    const frame = window.requestAnimationFrame(() => stopAllCancelRef.current?.focus());
    const close = (event: MouseEvent): void => {
      if (!stopAllRef.current?.contains(event.target as Node)) setStopAllConfirmOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setStopAllConfirmOpen(false);
      stopAllTriggerRef.current?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [stopAllConfirmOpen]);

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
          (isExternalCli(terminal.launch) ||
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
    const legacyOrdered: SessionEntry[] = [];
    const appended = new Set<string>();
    const append = (entry: SessionEntry): void => {
      if (appended.has(entry.key)) return;
      appended.add(entry.key);
      legacyOrdered.push(entry);
    };
    for (const entry of base) {
      const isChild =
        entry.kind === 'task'
          ? workerTaskIds.has(entry.task.id)
          : entry.kind === 'terminal'
            ? unboundWorkerTerminalIds.has(entry.terminalId)
            : false;
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

    const entryByKey = new Map(legacyOrdered.map((entry) => [entry.key, entry]));
    const claimedEntries = new Set<string>();
    const missionEntries: Array<Extract<SessionEntry, { kind: 'mission' }>> = [];
    const currentSnapshots = missionOrder
      .map((id) => missionsById[id])
      .filter((snapshot): snapshot is MissionSnapshotDto => Boolean(snapshot));
    const deletedSnapshots = deletedMissionOrder
      .map((id) => deletedMissionsById[id])
      .filter((snapshot): snapshot is MissionSnapshotDto => Boolean(snapshot));
    const hiddenMissionOwnedKeys = new Set<string>();
    for (const snapshot of [...currentSnapshots, ...deletedSnapshots]) {
      if (!snapshot.mission.deletedAt && !TERMINAL_MISSION_STATES.has(snapshot.mission.state)) {
        continue;
      }
      const originTaskId = snapshot.mission.originConversationTaskId;
      for (const assignment of snapshot.assignments) {
        if (assignment.id === snapshot.mission.leadAssignmentId && originTaskId) continue;
        const attempt =
          snapshot.attempts.find((candidate) => candidate.id === assignment.activeAttemptId) ??
          null;
        if (attempt?.runtimeSessionId?.startsWith('managed-task:')) {
          hiddenMissionOwnedKeys.add(
            `task:${attempt.runtimeSessionId.slice('managed-task:'.length)}`,
          );
        }
        if (attempt?.terminalId) {
          const taskEntry = taskEntries.find(
            (entry) =>
              entry.kind === 'task' && entry.task.external?.terminalId === attempt.terminalId,
          );
          hiddenMissionOwnedKeys.add(taskEntry?.key ?? `terminal:${attempt.terminalId}`);
        }
      }
    }
    // The Session rail is for live/current conversations. Once a Mission is
    // terminal its assignment tree belongs to Mission History, not Session
    // cleanup; only non-terminal Missions project their ownership here.
    const snapshots = currentSnapshots.filter(
      (snapshot) => !TERMINAL_MISSION_STATES.has(snapshot.mission.state),
    );

    for (const snapshot of snapshots) {
      const originTaskId = snapshot.mission.originConversationTaskId;
      const originTask = originTaskId ? tasks.find((task) => task.id === originTaskId) : undefined;
      const projectPath = originTask?.projectPath ?? snapshot.mission.executionPolicy.workspaceRoot;
      const projectName =
        originTask?.projectName ??
        projectPath
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .at(-1) ??
        'Mission';
      const assignmentKeys = new Map<string, string>();

      for (const assignment of snapshot.assignments) {
        const attempt =
          snapshot.attempts.find((candidate) => candidate.id === assignment.activeAttemptId) ??
          null;
        let key: string | null = null;
        if (assignment.id === snapshot.mission.leadAssignmentId && originTaskId) {
          const candidate = `task:${originTaskId}`;
          if (entryByKey.has(candidate) && !claimedEntries.has(candidate)) key = candidate;
        }
        if (!key && attempt?.runtimeSessionId?.startsWith('managed-task:')) {
          const taskId = attempt.runtimeSessionId.slice('managed-task:'.length);
          const candidate = `task:${taskId}`;
          if (entryByKey.has(candidate) && !claimedEntries.has(candidate)) key = candidate;
        }
        if (!key && attempt?.terminalId) {
          const taskEntry = taskEntries.find(
            (entry) =>
              entry.kind === 'task' && entry.task.external?.terminalId === attempt.terminalId,
          );
          const candidate = taskEntry?.key ?? `terminal:${attempt.terminalId}`;
          if (entryByKey.has(candidate) && !claimedEntries.has(candidate)) key = candidate;
        }
        key ??= `mission:${snapshot.mission.id}:${assignment.id}`;
        if (entryByKey.has(key)) claimedEntries.add(key);
        assignmentKeys.set(assignment.id, key);
      }

      for (const assignment of snapshot.assignments) {
        const key = assignmentKeys.get(assignment.id)!;
        const task = snapshot.tasks.find((candidate) => candidate.id === assignment.taskId);
        if (!task) continue;
        const attempt =
          snapshot.attempts.find((candidate) => candidate.id === assignment.activeAttemptId) ??
          null;
        const runtimeSession = attempt
          ? (snapshot.runtimeSessions?.find((candidate) => candidate.attemptId === attempt.id) ??
            null)
          : null;
        const principal = snapshot.principals.find(
          (candidate) => candidate.id === assignment.assigneePrincipalId,
        );
        const mission: MissionSessionLink = {
          missionId: snapshot.mission.id,
          assignmentId: assignment.id,
          parentKey: assignment.supervisorAssignmentId
            ? (assignmentKeys.get(assignment.supervisorAssignmentId) ?? null)
            : null,
          depth: missionAssignmentDepth(snapshot, assignment),
          agentName: principal?.displayName ?? task.title,
          taskTitle: task.title,
          provider: missionProvider(snapshot, assignment, attempt),
          assignmentState: assignment.state,
          taskState: task.state,
          waitingFor: snapshot.dependencies
            .filter((dependency) => dependency.taskId === task.id)
            .map((dependency) =>
              snapshot.tasks.find((candidate) => candidate.id === dependency.dependsOnTaskId),
            )
            .filter(
              (dependency): dependency is MissionSnapshotDto['tasks'][number] =>
                dependency !== undefined && dependency.state !== 'COMPLETED',
            )
            .map((dependency) => dependency.title),
          missionState: snapshot.mission.state,
          runtimeSessionId: attempt?.runtimeSessionId ?? null,
          terminalId: attempt?.terminalId ?? null,
          transport: runtimeSession?.transport ?? null,
        };
        const existing = entryByKey.get(key);
        if (existing) {
          entryByKey.set(key, { ...existing, mission } as SessionEntry);
        } else {
          missionEntries.push({
            key,
            kind: 'mission',
            projectName,
            projectPath,
            updatedAt: assignment.updatedAt,
            mission,
          });
        }
      }
    }

    const candidates = [
      ...legacyOrdered
        .filter((entry) => !hiddenMissionOwnedKeys.has(entry.key))
        .map((entry) => entryByKey.get(entry.key) ?? entry),
      ...missionEntries,
    ];
    const candidateKeys = new Set(candidates.map((entry) => entry.key));
    const children = new Map<string, SessionEntry[]>();
    for (const entry of candidates) {
      const parentKey = entry.mission?.parentKey;
      if (!parentKey || !candidateKeys.has(parentKey)) continue;
      const bucket = children.get(parentKey) ?? [];
      bucket.push(entry);
      children.set(parentKey, bucket);
    }
    const ordered: SessionEntry[] = [];
    const seen = new Set<string>();
    const appendTree = (entry: SessionEntry): void => {
      if (seen.has(entry.key)) return;
      seen.add(entry.key);
      ordered.push(entry);
      for (const child of children.get(entry.key) ?? []) appendTree(child);
    };
    for (const entry of candidates) {
      const parentKey = entry.mission?.parentKey;
      if (!parentKey || !candidateKeys.has(parentKey)) appendTree(entry);
    }
    for (const entry of candidates) appendTree(entry);
    return ordered;
  }, [
    deletedMissionOrder,
    deletedMissionsById,
    missionOrder,
    missionsById,
    orchestration.workers,
    tasks,
    terminalStore.items,
    taskByTerminal,
  ]);

  const runningTargets = useMemo(
    () => runningSessionTargets(allEntries, externalSessions),
    [allEntries, externalSessions],
  );

  const groups = useMemo<RailGroup[]>(() => buildRailGroups(allEntries), [allEntries]);

  // Notification activation reveals the target's directory and pagination
  // slot when needed.
  useEffect(() => {
    const reveal = app.sessionReveal;
    if (!reveal) return;
    useAppStore.getState().setRailView('sessions');
    if (window.matchMedia('(max-width: 1120px)').matches) setCompactPanelOpen(true);
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

  const filteringSessions = false;
  const displayedGroups = useMemo(
    () =>
      groups.map((group) => ({
        group,
        entries: visibleRailGroupEntries(group, {
          expanded: expandedGroups.has(group.key),
          filtering: filteringSessions,
        }),
      })),
    [expandedGroups, groups],
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
  const selectedMission = app.missionCenter;
  const selectedMissionKey =
    selectedMission?.missionId && selectedMission.assignmentId
      ? (allEntries.find(
          (entry) =>
            entry.mission?.missionId === selectedMission.missionId &&
            entry.mission.assignmentId === selectedMission.assignmentId,
        )?.key ?? null)
      : null;
  const selectedKey = app.taskRoomTaskId
    ? `task:${app.taskRoomTaskId}`
    : app.sessionTerminalId
      ? `terminal:${app.sessionTerminalId}`
      : selectedMissionKey;
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
    } else if (
      selectedGroup &&
      !selectedGroup.history &&
      !visibleRailGroupEntries(selectedGroup, { expanded: false, filtering: false }).some(
        (entry) => entry.key === selectedKey,
      )
    ) {
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
      } else if (entry.kind === 'terminal') {
        // ADR-0046: keyboard navigation follows the project context too.
        const item = useTerminalStore
          .getState()
          .items.find((candidate) => candidate.id === entry.terminalId);
        void useWorkspaceStore.getState().followProject(item?.projectPath ?? null);
        app.openTerminalSession(entry.terminalId);
      } else {
        app.openMission(entry.mission.missionId, entry.mission.assignmentId, 'session');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app, orderedEntries]);

  const startSession = async (projectPath: string): Promise<void> => {
    if (workspaceStore.workspace?.path !== projectPath) {
      app.setHomePick(true);
      await workspaceStore.openPath(projectPath);
      if (useWorkspaceStore.getState().workspace?.path !== projectPath) return;
    }
    // ADR-0042: switch the nav section first — it restores that group's last
    // surface — THEN apply this action's explicit intent (the composer), so
    // the restore never overrides it.
    app.openSessionHome();
    app.focusComposer();
    if (window.matchMedia('(max-width: 1120px)').matches) setCompactPanelOpen(false);
  };

  const stopAllRunningSessions = async (): Promise<void> => {
    if (stoppingAll || runningTargets.length === 0) return;
    const targets = [...runningTargets];
    setStopAllConfirmOpen(false);
    setStoppingCount(targets.length);
    setStoppingAll(true);
    const results = await Promise.all(
      targets.map(async (target) => {
        try {
          return await stopRunningSession(target);
        } catch {
          return false;
        }
      }),
    );
    await Promise.allSettled([
      useTaskStore.getState().refreshTasks(),
      useOrchestrationStore.getState().refreshMissions(),
    ]);
    const stopped = results.filter(Boolean).length;
    const failed = results.length - stopped;
    if (failed === 0) {
      app.pushToast(
        'success',
        `Stopped ${stopped} running session${stopped === 1 ? '' : 's'}. Records remain in Session Archive.`,
      );
    } else {
      app.pushToast(
        'warning',
        `Stopped ${stopped} of ${results.length} sessions. ${failed} could not be stopped.`,
      );
    }
    setStoppingAll(false);
  };

  const renderSessionEntry = (entry: SessionEntry, showProject: boolean): React.ReactNode => {
    if (entry.kind === 'mission') {
      return <MissionRuntimeRow key={entry.key} entry={entry} now={now} />;
    }
    if (entry.kind === 'task') {
      const terminalId = entry.task.external?.terminalId ?? null;
      return (
        <SessionTaskRow
          key={entry.key}
          task={entry.task}
          showProject={showProject}
          now={now}
          worker={orchestration.workers.some((worker) => worker.taskId === entry.task.id)}
          depth={entry.mission?.depth ?? 0}
          missionSelected={Boolean(
            entry.mission &&
            app.missionCenter &&
            entry.mission.missionId === app.missionCenter.missionId &&
            entry.mission.assignmentId === app.missionCenter.assignmentId,
          )}
          workerWorking={orchestration.workers.some(
            (worker) => worker.taskId === entry.task.id && worker.status === 'streaming',
          )}
          missionRuntimeStatus={
            terminalId ? (missionRuntimeStatuses.get(terminalId) ?? null) : null
          }
          mission={entry.mission}
        />
      );
    }
    return (
      <TerminalSessionRow
        key={entry.key}
        terminalId={entry.terminalId}
        launch={entry.launch}
        showProject={showProject}
        worker={orchestration.workers.some((worker) => worker.terminalId === entry.terminalId)}
        depth={entry.mission?.depth ?? 0}
        missionSelected={Boolean(
          entry.mission &&
          app.missionCenter &&
          entry.mission.missionId === app.missionCenter.missionId &&
          entry.mission.assignmentId === app.missionCenter.assignmentId,
        )}
        working={orchestration.workers.some(
          (worker) => worker.terminalId === entry.terminalId && worker.status === 'streaming',
        )}
        missionRuntimeStatus={missionRuntimeStatuses.get(entry.terminalId) ?? null}
        mission={entry.mission}
      />
    );
  };

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
        <span className="sr-tab-label">Sessions</span>
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
        <span className="sr-tab-label">Files</span>
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

  const runningSessionsControl =
    runningTargets.length > 0 || stoppingAll ? (
      <div ref={stopAllRef} className="sr-running-compact-wrap">
        <button
          ref={stopAllTriggerRef}
          type="button"
          className="sr-running-compact"
          data-testid="rail-running-summary"
          aria-label={
            stoppingAll
              ? `Stopping ${stoppingCount} ${stoppingCount === 1 ? 'session' : 'sessions'}`
              : `${runningTargets.length} ${runningTargets.length === 1 ? 'session' : 'sessions'} running`
          }
          aria-haspopup="dialog"
          aria-expanded={stopAllConfirmOpen}
          aria-controls="rail-stop-all-confirm"
          disabled={stoppingAll}
          title={
            stoppingAll
              ? `Stopping ${stoppingCount}…`
              : `${runningTargets.length} running · click for controls`
          }
          onClick={() => setStopAllConfirmOpen((open) => !open)}
        >
          <span className="sr-running-dot" />
          <span className="sr-running-count" aria-live="polite">
            {stoppingAll ? '…' : runningTargets.length}
          </span>
          <span className="sr-running-label">running</span>
        </button>
        {stopAllConfirmOpen ? (
          <div
            id="rail-stop-all-confirm"
            className="sr-stop-all-popover"
            data-testid="rail-stop-all-confirm"
            role="alertdialog"
            aria-modal="false"
            aria-labelledby="rail-stop-all-title"
            aria-describedby="rail-stop-all-description"
          >
            <strong id="rail-stop-all-title">
              {runningTargets.length} running {runningTargets.length === 1 ? 'session' : 'sessions'}
            </strong>
            <p id="rail-stop-all-description">
              Stop every active process? Session records and changes stay available in Session
              Archive.
            </p>
            <div className="sr-stop-all-actions">
              <button
                ref={stopAllCancelRef}
                type="button"
                data-testid="rail-stop-all-cancel"
                onClick={() => {
                  setStopAllConfirmOpen(false);
                  stopAllTriggerRef.current?.focus();
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                data-testid="rail-stop-all-confirm-action"
                onClick={() => void stopAllRunningSessions()}
              >
                <Ic name="circleStop" size={12} />
                Stop all
              </button>
            </div>
          </div>
        ) : null}
      </div>
    ) : null;

  const sessionArchiveButton = (placement: 'history' | 'fallback'): React.JSX.Element => (
    <button
      className={`sr-session-archive ${placement} ${app.archaeology ? 'active' : ''}`}
      data-testid="rail-session-archive"
      aria-label={`Session Archive, ${allEntries.length} sessions`}
      title={`${tasks.length} tracked · opens tracked and external history`}
      onClick={() => {
        app.openArchaeology(null);
        if (window.matchMedia('(max-width: 1120px)').matches) setCompactPanelOpen(false);
      }}
    >
      <Ic name="clock" size={11} />
      <span>Archive</span>
      <small>{allEntries.length}</small>
    </button>
  );

  const hasHistoryGroup = groups.some((group) => group.history);

  const sessionsPanel = (
    <>
      <header className="sr-head sr-sessions-head">
        <div className="sr-session-tabs-line">
          {railTabs}
          {runningSessionsControl}
        </div>
      </header>

      <div className="sr-scroll">
        {groups.length === 0 ? (
          <div className="sr-empty">
            No sessions yet. Start with Charter Agent, Claude or Codex.
          </div>
        ) : (
          displayedGroups.map(({ group, entries }) => {
            const isCollapsed = !filteringSessions && collapsed.has(group.key);
            const isExpanded = expandedGroups.has(group.key);
            const compactEntryCount = visibleRailGroupEntries(group, {
              expanded: false,
              filtering: false,
            }).length;
            const hiddenCount = Math.max(0, group.entries.length - compactEntryCount);
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
                  {group.history ? (
                    sessionArchiveButton('history')
                  ) : group.path ? (
                    <button
                      className="sr-group-add"
                      aria-label={`New session in ${group.name}`}
                      title={`New session in ${group.name}`}
                      onClick={() => {
                        if (group.path) void startSession(group.path);
                      }}
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
                                  size={12}
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
                            ? `Show compact sessions in ${group.name}`
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
        {hasHistoryGroup ? null : (
          <div className="sr-archive-fallback">{sessionArchiveButton('fallback')}</div>
        )}
      </div>
    </>
  );

  const inboxPanel = (
    <>
      <header className="sr-head sr-head-plain">
        <div className="sr-heading-row">
          <strong>Needs attention</strong>
          <div className="sr-inbox-heading-actions">
            <small>{inbox.length} waiting</small>
            {inbox.length > 0 ? (
              <button
                className="sr-inbox-clear"
                data-testid="rail-inbox-clear"
                title="Clear current reminders without deleting sessions"
                onClick={clearAttention}
              >
                Clear all
              </button>
            ) : null}
          </div>
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
          const current = workspaceStore.workspace?.path === project.path;
          const selected = app.projectCenter?.path === project.path;
          const projectTasks = topLevelSessionTasks.filter(
            (task) => task.projectPath === project.path && !task.archived,
          );
          const liveCount = projectTasks.filter(
            (task) => task.external?.status === 'active' || RUNNING_TASK_STATES.has(task.state),
          ).length;
          const attentionCount = projectTasks.filter(needsAttention).length;
          const recordedCount = recordedByProject.get(project.path) ?? 0;
          return (
            <div
              className={`sr-project-wrap ${selected ? 'selected' : ''} ${current ? 'current' : ''} ${!project.exists ? 'unavailable' : ''}`}
              key={project.path}
            >
              <button
                className={`sr-project ${selected ? 'selected' : ''}`}
                data-testid={`home-recent-${project.path}`}
                title={`${project.path} — view Project Center`}
                onClick={() => {
                  setProjectMenuPath(null);
                  app.openProjectCenter(project.path);
                  if (window.matchMedia('(max-width: 1120px)').matches) {
                    setCompactPanelOpen(false);
                  }
                }}
              >
                <Ic name="folder" size={14} />
                <span className="sr-project-copy">
                  <strong>{project.displayName}</strong>
                  <small
                    data-testid={`project-discovered-${project.path}`}
                    title={`${liveCount} live session${liveCount === 1 ? '' : 's'} · ${attentionCount} need attention`}
                  >
                    {!project.exists
                      ? 'Unavailable'
                      : liveCount > 0 || attentionCount > 0
                        ? `${liveCount} live${attentionCount > 0 ? ` · ${attentionCount} need you` : ''}`
                        : 'No live sessions'}
                  </small>
                </span>
                {current ? (
                  <span className="sr-project-current" title="Current project">
                    <Ic name="check" size={12} />
                  </span>
                ) : null}
              </button>
              <div className="sr-project-menu-wrap">
                <button
                  className="sr-project-use"
                  data-testid={`project-menu-${project.path}`}
                  title={`Project actions for ${project.displayName}`}
                  aria-label={`Project actions for ${project.displayName}`}
                  aria-haspopup="menu"
                  aria-expanded={projectMenuPath === project.path}
                  onClick={() =>
                    setProjectMenuPath((value) => (value === project.path ? null : project.path))
                  }
                >
                  <Ic name="more" size={14} />
                </button>
                {projectMenuPath === project.path ? (
                  <div className="sr-project-menu" role="menu">
                    {!current && project.exists ? (
                      <button
                        role="menuitem"
                        data-testid={`project-set-current-${project.path}`}
                        onClick={() => {
                          setProjectMenuPath(null);
                          app.setHomePick(true);
                          void workspaceStore.openPath(project.path);
                        }}
                      >
                        <Ic name="check" size={12} /> Set as current
                      </button>
                    ) : null}
                    <button
                      role="menuitem"
                      data-testid={`project-history-${project.path}`}
                      onClick={() => {
                        setProjectMenuPath(null);
                        app.openProjectCenter(project.path, 'sessions');
                      }}
                    >
                      <Ic name="clock" size={12} /> View sessions
                    </button>
                    {project.exists ? (
                      <button
                        role="menuitem"
                        data-testid={`project-spawn-pi-${project.path}`}
                        onClick={() => {
                          setProjectMenuPath(null);
                          void startSession(project.path);
                        }}
                      >
                        <Ic name="plus" size={12} /> New Session
                      </button>
                    ) : null}
                    {project.exists ? (
                      <button
                        role="menuitem"
                        onClick={() => {
                          setProjectMenuPath(null);
                          void rpcResult('app.revealPath', { path: project.path });
                        }}
                      >
                        <Ic name="folder-open" size={12} /> Reveal in Finder
                      </button>
                    ) : null}
                    <button
                      className="danger"
                      role="menuitem"
                      data-testid={`project-remove-${project.path}`}
                      onClick={() => {
                        setProjectMenuPath(null);
                        void removeProject(project.path, recordedCount);
                      }}
                    >
                      <Ic name="trash" size={12} /> Remove from Charter
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <aside
      ref={railRef}
      className={`sr-rail view-${view} ${railWidth < RAIL_WIDTH_DEFAULT ? 'is-narrow' : ''} ${
        projectsPanelOpen ? 'projects-panel-open' : ''
      } ${compactPanelOpen ? 'compact-open' : ''} ${railResizing ? 'is-resizing' : ''}`}
      data-rail-density={railWidth < RAIL_WIDTH_DEFAULT ? 'compact' : 'comfortable'}
      data-testid="home-sidebar"
      aria-label={
        view === 'skills'
          ? 'Skills'
          : view === 'memory'
            ? 'Memory'
            : view === 'missions'
              ? 'Missions'
              : view === 'projects'
                ? 'Projects'
                : view === 'inbox'
                  ? 'For you'
                  : 'Sessions'
      }
      style={{ '--rail-width': `${railWidth}px` } as React.CSSProperties}
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
        ) : view === 'missions' ? (
          <MissionRailPanel />
        ) : view === 'projects' ? (
          projectsPanel
        ) : view === 'skills' ? (
          <SkillsRailPanel />
        ) : view === 'memory' ? (
          <MemoryRailPanel />
        ) : view === 'files' ? (
          filesPanel
        ) : (
          sessionsPanel
        )}
      </section>
      <div
        className="sr-rail-resize"
        data-testid="rail-resize-handle"
        role="separator"
        aria-label="Resize Sessions sidebar"
        aria-orientation="vertical"
        aria-valuemin={RAIL_WIDTH_MIN}
        aria-valuemax={railWidthLimit()}
        aria-valuenow={railWidth}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onDoubleClick={() => updateRailWidth(RAIL_WIDTH_DEFAULT, true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            updateRailWidth(railWidth + (event.key === 'ArrowRight' ? 10 : -10), true);
          } else if (event.key === 'Home') {
            event.preventDefault();
            updateRailWidth(RAIL_WIDTH_DEFAULT, true);
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          railResizingRef.current = true;
          setRailResizing(true);
          resizeRailFromPointer(event.clientX);
        }}
        onPointerMove={(event) => {
          if (!railResizingRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) {
            return;
          }
          resizeRailFromPointer(event.clientX);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          saveRailWidth(railWidthRef.current);
          railResizingRef.current = false;
          setRailResizing(false);
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          saveRailWidth(railWidthRef.current);
          railResizingRef.current = false;
          setRailResizing(false);
        }}
      />
    </aside>
  );
}
