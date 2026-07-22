import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  buildRailGroups,
  isHistoryEntry,
  recordedTasksByProject,
  type RailGroup,
  type SessionEntry,
} from './rail-groups.js';

export { isHistoryEntry, type SessionEntry } from './rail-groups.js';

const COLLAPSED_KEY = 'charter.rail.collapsed.v1';
const SESSION_PAGE_SIZE = 20;

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
  return new Set(['history']);
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
  return 'Pi';
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
  if (['AWAITING_PLAN_APPROVAL', 'AWAITING_PERMISSION', 'INTERRUPTED'].includes(task.state)) {
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
  workerCount = 0,
  orchestrationNeeds = 0,
}: {
  task: TaskDto;
  /** Rows inside a project group drop the redundant project name (ADR-0023). */
  showProject?: boolean;
  now: number;
  worker?: boolean;
  workerCount?: number;
  orchestrationNeeds?: number;
}): React.JSX.Element {
  const app = useAppStore();
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
  const resumingTaskId = useExternalStore((state) => state.resumingTaskId);
  const live = task.external ? externalSession?.status === 'active' : running;
  const resumable = canResumeExternal(task) && !live;

  const open = (): void => {
    void useTaskStore.getState().openTask(task.id);
    app.openTaskRoom(task.id);
  };

  return (
    <div className={`sr-row-wrap ${worker ? 'sr-orch-worker' : ''}`}>
      <button
        className={`sr-session ${selected ? 'selected' : ''} ${glowTasks.has(task.id) ? 'glow-pulse' : ''} ${completion ? `completion-ripple completion-${completion.tone}` : ''} ${reply ? 'reply-shake' : ''}`}
        data-testid={`home-task-${task.id}`}
        data-session-key={`task:${task.id}`}
        data-state={task.state}
        data-completion={completion?.tone}
        data-reply={reply ? 'true' : undefined}
        title={`${providerLabel(provider)} · ${displayTitle} — ${meta.label}`}
        onClick={open}
      >
        <ProviderMark
          provider={provider}
          className={
            completion || reply ? `session-wave ${completion ? 'completion' : 'reply'}` : ''
          }
        />
        <span className="sr-session-copy">
          <span className="sr-session-title">
            <span className={`sr-live-dot ${live ? 'live' : ''}`} />
            <b>{displayTitle}</b>
            {badge ? <span className={`sr-state ${badge.tone}`}>{badge.label}</span> : null}
            {workerCount > 0 ? <span className="sr-orch-chip">⌁ 指挥 {workerCount}</span> : null}
            {orchestrationNeeds > 0 ? (
              <span
                className="sr-orch-needs"
                title={`${orchestrationNeeds} orchestration approval(s)`}
              >
                {orchestrationNeeds}
              </span>
            ) : null}
          </span>
          <span className="sr-session-detail">
            <span data-testid={`home-task-ticker-${task.id}`}>
              {showProject ? `${task.projectName} · ` : ''}
              {action?.label ??
                (isAnswered(task)
                  ? task.external
                    ? 'Session ended · no file changes'
                    : 'Answered · no file changes'
                  : meta.label)}
            </span>
            <time dateTime={task.updatedAt}>{timeAgo(task.updatedAt, now)}</time>
          </span>
        </span>
      </button>
      {resumable || canArchiveTask(task) ? (
        <div className="sr-actions">
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
          {canArchiveTask(task) ? (
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
    </div>
  );
}

function TerminalSessionRow({
  terminalId,
  launch,
  showProject = true,
  worker = false,
}: {
  terminalId: string;
  launch: 'shell' | 'claude' | 'codex';
  showProject?: boolean;
  worker?: boolean;
}): React.JSX.Element | null {
  const app = useAppStore();
  const item = useTerminalStore((state) => state.items.find((entry) => entry.id === terminalId));
  if (!item) return null;
  const selected = app.sessionTerminalId === terminalId;
  const provider = launch;
  // The brand mark carries the provider — never repeat the CLI name as the
  // title. Generic launch titles read as an unnamed session.
  const sessionName = /^(?:Claude Code|Codex)$/i.test(item.title) ? 'New session' : item.title;
  return (
    <div className={`sr-row-wrap ${worker ? 'sr-orch-worker' : ''}`}>
      <button
        className={`sr-session ${selected ? 'selected' : ''}`}
        data-testid={`session-terminal-${terminalId}`}
        data-session-key={`terminal:${terminalId}`}
        title={`${providerLabel(provider)} · ${item.contextLabel}`}
        onClick={() => app.openTerminalSession(terminalId)}
      >
        <ProviderMark provider={provider} />
        <span className="sr-session-copy">
          <span className="sr-session-title">
            <span className={`sr-live-dot ${item.exited ? '' : 'live'}`} />
            <b>{sessionName}</b>
            {item.exited ? <span className="sr-state neutral">Ended</span> : null}
          </span>
          <span className="sr-session-detail">
            <span>
              {showProject ? `${item.projectName} · ` : ''}
              {item.exited ? 'Process ended · session retained' : 'Terminal session is live'}
            </span>
          </span>
        </span>
      </button>
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
  const [projectsPanelOpen, setProjectsPanelOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(loadCollapsed);
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
  const [visibleCount, setVisibleCount] = useState(SESSION_PAGE_SIZE);

  const setView = (next: RailView): void => {
    app.setRailView(next);
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
          (terminal.launch === 'claude' ||
            terminal.launch === 'codex' ||
            workerTerminalIds.has(terminal.id)),
      )
      .map((terminal) => ({
        key: `terminal:${terminal.id}`,
        kind: 'terminal',
        terminalId: terminal.id,
        launch: terminal.launch,
        projectName: terminal.projectName,
        exited: terminal.exited,
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

  // Search and Needs You always inspect the complete set. The default rail is
  // intentionally progressive so long histories stay lightweight.
  const flatEntries = useMemo(
    () => (query.trim() || needsOnly ? allEntries : allEntries.slice(0, Math.max(visibleCount, 1))),
    [allEntries, needsOnly, query, visibleCount],
  );

  // Notification activation is stronger than the current rail filters: show
  // Sessions, clear filters, and expand enough pages to include the target.
  useEffect(() => {
    const reveal = app.sessionReveal;
    if (!reveal) return;
    useAppStore.getState().setRailView('sessions');
    setQuery('');
    setNeedsOnly(false);
    const index = allEntries.findIndex((entry) => entry.key === `task:${reveal.taskId}`);
    if (index >= 0) {
      setVisibleCount((count) =>
        Math.max(count, Math.ceil((index + 1) / SESSION_PAGE_SIZE) * SESSION_PAGE_SIZE),
      );
      useAppStore.getState().clearSessionReveal(reveal.seq);
    }
  }, [allEntries, app.sessionReveal]);

  const groups = useMemo<RailGroup[]>(() => buildRailGroups(flatEntries), [flatEntries]);

  // The Projects panel counts over the COMPLETE set — `groups` is built from
  // the paginated slice and would under-report past the first rail page.
  const fullGroups = useMemo<RailGroup[]>(() => buildRailGroups(allEntries), [allEntries]);
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

  /** Keyboard order mirrors the visual order (groups flattened, History last). */
  const orderedEntries = useMemo(
    () => visibleGroups.flatMap((group) => group.entries),
    [visibleGroups],
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

  // The open room's row is never hidden: when the selection lands in (or moves
  // into) a collapsed group — e.g. accept sends a task to History — expand it.
  // Manual collapses are respected until the selection or its group changes.
  const selectedKey = app.taskRoomTaskId
    ? `task:${app.taskRoomTaskId}`
    : app.sessionTerminalId
      ? `terminal:${app.sessionTerminalId}`
      : null;
  const selectedGroupKey = selectedKey
    ? (groups.find((group) => group.entries.some((entry) => entry.key === selectedKey))?.key ??
      null)
    : null;
  useEffect(() => {
    if (!selectedGroupKey) return;
    setCollapsed((prev) => {
      if (!prev.has(selectedGroupKey)) return prev;
      const next = new Set(prev);
      next.delete(selectedGroupKey);
      saveCollapsed(next);
      return next;
    });
  }, [selectedGroupKey, selectedKey]);

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
              ? 'No sessions yet. Start with Pi, Claude or Codex.'
              : 'No sessions match this search or filter.'}
          </div>
        ) : (
          visibleGroups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            return (
              <section key={group.key} className="sr-group">
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
                  <div className="sr-group-items">
                    {group.entries.map((entry) =>
                      entry.kind === 'task' ? (
                        <SessionTaskRow
                          key={entry.key}
                          task={entry.task}
                          showProject={group.history === true}
                          now={now}
                          worker={orchestration.workers.some(
                            (worker) => worker.taskId === entry.task.id,
                          )}
                          workerCount={
                            orchestration.workers.filter(
                              (worker) => worker.commanderTaskId === entry.task.id,
                            ).length
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
                          showProject={group.history === true}
                          worker={orchestration.workers.some(
                            (worker) => worker.terminalId === entry.terminalId,
                          )}
                        />
                      ),
                    )}
                  </div>
                )}
              </section>
            );
          })
        )}
        {!query.trim() && !needsOnly && visibleCount < allEntries.length ? (
          <button
            className="sr-more"
            data-testid="rail-more"
            onClick={() => setVisibleCount((count) => count + SESSION_PAGE_SIZE)}
          >
            <span>More</span>
            <small>
              {Math.min(SESSION_PAGE_SIZE, allEntries.length - visibleCount)} of{' '}
              {allEntries.length - visibleCount} remaining
            </small>
            <Ic name="chevron" size={11} />
          </button>
        ) : null}
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
          <span>Plans, permissions and reviews waiting for your decision appear here.</span>
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
            fullGroups.find((group) => group.path === project.path)?.entries.length ?? 0;
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
      className={`sr-rail view-${view} ${projectsPanelOpen ? 'projects-panel-open' : ''}`}
      data-testid="home-sidebar"
      aria-label={view === 'skills' ? 'Skills' : 'Sessions'}
    >
      <nav className="sr-activity" aria-label="Application">
        <div className="sr-activity-brand" aria-label="Charter">
          <Ic name="flag" size={15} />
        </div>
        <button
          className={`sr-activity-item ${view === 'sessions' ? 'active' : ''}`}
          data-testid="rail-view-sessions"
          aria-label="Sessions"
          title="Sessions"
          onClick={() => setView('sessions')}
        >
          <Ic name="terminal" size={16} />
        </button>
        <button
          className={`sr-activity-item ${view === 'inbox' ? 'active' : ''}`}
          data-testid="rail-needs-you"
          aria-label="Needs attention"
          title="Needs attention"
          onClick={() => setView('inbox')}
        >
          <Ic name="inbox" size={16} />
          {inbox.length > 0 ? <span className="sr-mini-badge">{inbox.length}</span> : null}
        </button>
        <button
          className={`sr-activity-item ${view === 'projects' ? 'active' : ''}`}
          data-testid="rail-view-projects"
          aria-label="Projects"
          title="Projects"
          aria-pressed={view === 'projects' && projectsPanelOpen}
          onClick={() => {
            if (view === 'projects') setProjectsPanelOpen((open) => !open);
            else showProjects();
          }}
        >
          <Ic name="folder" size={16} />
        </button>
        <button
          className="sr-activity-item"
          data-testid="rail-search"
          aria-label="Search everything"
          title="Search everything · ⌘K"
          onClick={() => app.setLauncherOpen(true)}
        >
          <Ic name="search" size={16} />
        </button>
        <button
          className={`sr-activity-item ${app.overlay === 'memory' ? 'active' : ''}`}
          data-testid="rail-view-memory"
          aria-label="Memory"
          title="Memory — project rules & agent memories"
          onClick={() => app.setOverlay('memory')}
        >
          <Ic name="brain" size={16} />
        </button>
        <button
          className={`sr-activity-item ${view === 'skills' ? 'active' : ''}`}
          data-testid="rail-view-skills"
          aria-label="Skills"
          title="Skills — usage and Agent installations"
          onClick={() => setView('skills')}
        >
          <Ic name="puzzle" size={17} />
        </button>
        <span className="sr-activity-spacer" />
        <button
          className="sr-activity-item"
          data-testid="home-open-ide"
          aria-label="Editor"
          title="Editor · ⌘E"
          onClick={() => app.setSurface('workspace')}
        >
          <Ic name="layout" size={16} />
        </button>
        <button
          className="sr-activity-item"
          data-testid="home-settings"
          aria-label="Settings"
          title="Settings"
          onClick={() => app.openSettings()}
        >
          <Ic name="sliders" size={16} />
        </button>
      </nav>
      <section className="sr-panel">
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
