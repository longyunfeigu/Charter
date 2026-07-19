import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RecentWorkspaceDto, TaskDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useActivityStore, currentActionLine } from '../store/activityStore.js';
import { useAppStore } from '../store/appStore.js';
import { useExternalStore } from '../store/externalStore.js';
import { RUNNING_TASK_STATES, useTaskStore } from '../store/taskStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useTerminalStore } from './TerminalPanel.js';
import { Ic, ProviderMark } from './home-icons.js';
import { canArchiveTask, isAnswered, presentedMeta } from './labels.js';
import { ArmedIconButton } from './ui.js';
import { needsAttention } from './HomeSidebar.js';
import { SessionFilesPane } from './SessionFilesPane.js';
import { useGlowTasks } from './useGlow.js';
import { sessionDisplayTitle } from '../store/sessionAttention.js';

type SessionEntry =
  | { key: string; kind: 'task'; task: TaskDto }
  | {
      key: string;
      kind: 'terminal';
      terminalId: string;
      launch: 'claude' | 'codex';
      projectName: string;
    };

/** The rail's contextual views inside the single navigation surface.
 * 'files' is the persistent context-feeding tree (ADR-0024, mock B+D). */
type RailView = 'sessions' | 'inbox' | 'projects' | 'files';

interface RailGroup {
  key: string;
  name: string;
  path: string | null;
  entries: SessionEntry[];
  needs: number;
  history?: boolean;
}

/**
 * ADR-0023: settled sessions leave their project group for the collapsed
 * History group. Attention states (FAILED/INTERRUPTED, review) stay in their
 * project group — History never hides something that still wants a decision.
 */
const SETTLED_STATES = new Set(['ACCEPTED', 'ROLLED_BACK', 'CANCELLED']);

const COLLAPSED_KEY = 'charter.rail.collapsed.v1';
const VIEW_KEY = 'charter.rail.view.v1';
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

function loadRailView(): RailView {
  try {
    const saved = window.sessionStorage.getItem(VIEW_KEY);
    if (saved === 'sessions' || saved === 'inbox' || saved === 'projects' || saved === 'files') {
      return saved;
    }
  } catch {
    // Session-local navigation persistence is best effort.
  }
  return 'sessions';
}

function saveRailView(view: RailView): void {
  try {
    window.sessionStorage.setItem(VIEW_KEY, view);
  } catch {
    // Session-local navigation persistence is best effort.
  }
}

function providerForTask(task: TaskDto): 'pi' | 'claude' | 'codex' {
  if (task.external?.cli === 'claude') return 'claude';
  if (task.external?.cli === 'codex') return 'codex';
  return 'pi';
}

function providerLabel(provider: 'pi' | 'claude' | 'codex'): string {
  if (provider === 'claude') return 'Claude';
  if (provider === 'codex') return 'Codex';
  return 'Pi';
}

function timeAgo(value: string, now: number): string {
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
}: {
  task: TaskDto;
  /** Rows inside a project group drop the redundant project name (ADR-0023). */
  showProject?: boolean;
  now: number;
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
  const live = task.external ? externalSession?.status === 'active' : running;

  const open = (): void => {
    void useTaskStore.getState().openTask(task.id);
    app.openTaskRoom(task.id);
  };

  return (
    <div className="sr-row-wrap">
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
  );
}

function TerminalSessionRow({
  terminalId,
  launch,
  showProject = true,
}: {
  terminalId: string;
  launch: 'claude' | 'codex';
  showProject?: boolean;
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
  const inbox = tasks.filter((task) => !task.archived && needsAttention(task));
  const [recent, setRecent] = useState<RecentWorkspaceDto[]>([]);
  const [view, setViewState] = useState<RailView>(loadRailView);
  const [projectsPanelOpen, setProjectsPanelOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(loadCollapsed);
  const [query, setQuery] = useState('');
  const [needsOnly, setNeedsOnly] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [visibleCount, setVisibleCount] = useState(SESSION_PAGE_SIZE);

  const setView = (next: RailView): void => {
    saveRailView(next);
    setViewState(next);
    if (next !== 'projects') setProjectsPanelOpen(false);
    setAddMenuOpen(false);
  };

  const showProjects = (): void => {
    setView('projects');
    setProjectsPanelOpen(true);
  };

  useEffect(() => {
    useTaskStore.getState().init();
    void useTaskStore.getState().refreshTasks();
    terminalStore.init();
    useExternalStore.getState().init();
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
    const taskEntries: SessionEntry[] = tasks
      .filter((task) => !task.archived)
      .map((task) => ({ key: `task:${task.id}`, kind: 'task', task }));
    const terminalEntries: SessionEntry[] = terminalStore.items
      .filter(
        (terminal) =>
          !terminal.hidden &&
          !taskByTerminal[terminal.id] &&
          (terminal.launch === 'claude' || terminal.launch === 'codex'),
      )
      .map((terminal) => ({
        key: `terminal:${terminal.id}`,
        kind: 'terminal',
        terminalId: terminal.id,
        launch: terminal.launch as 'claude' | 'codex',
        projectName: terminal.projectName,
      }));
    return [...terminalEntries.toReversed(), ...taskEntries];
  }, [tasks, terminalStore.items, taskByTerminal]);

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
    saveRailView('sessions');
    setViewState('sessions');
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

  const groups = useMemo<RailGroup[]>(() => {
    const active: RailGroup[] = [];
    const byName = new Map<string, RailGroup>();
    const history: RailGroup = {
      key: 'history',
      name: 'History',
      path: null,
      entries: [],
      needs: 0,
      history: true,
    };
    for (const entry of flatEntries) {
      if (entry.kind === 'task' && SETTLED_STATES.has(entry.task.state)) {
        history.entries.push(entry);
        continue;
      }
      const name = entry.kind === 'task' ? entry.task.projectName : entry.projectName;
      let group = byName.get(name);
      if (!group) {
        group = { key: `proj:${name}`, name, path: null, entries: [], needs: 0 };
        byName.set(name, group);
        active.push(group);
      }
      if (entry.kind === 'task') {
        group.path ??= entry.task.projectPath;
        if (needsAttention(entry.task)) group.needs += 1;
      }
      group.entries.push(entry);
    }
    return history.entries.length > 0 ? [...active, history] : active;
  }, [flatEntries]);

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
    app.closeTaskRoom();
    app.setSurface('home');
    app.focusComposer();
    setView('sessions');
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
                        />
                      ) : (
                        <TerminalSessionRow
                          key={entry.key}
                          terminalId={entry.terminalId}
                          launch={entry.launch}
                          showProject={false}
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
          const sessionCount =
            groups.find((group) => group.path === project.path)?.entries.length ?? 0;
          return (
            <div className={`sr-project-wrap ${active ? 'active' : ''}`} key={project.path}>
              <button
                className={`sr-project ${active ? 'active' : ''}`}
                data-testid={`home-recent-${project.path}`}
                title={`${project.path} — open project files`}
                onClick={() => {
                  setProjectsPanelOpen(false);
                  if (active) {
                    app.setProjectTool('files');
                    return;
                  }
                  app.setHomePick(true);
                  void workspaceStore
                    .openPath(project.path)
                    .then(() => app.setProjectTool('files'));
                }}
              >
                <Ic name="folder" size={14} />
                <span className="sr-project-copy">
                  <strong>{project.displayName}</strong>
                  <small>{sessionCount} sessions</small>
                </span>
                {active ? (
                  <span className="sr-project-current" title="Current project">
                    <Ic name="check" size={12} />
                  </span>
                ) : null}
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
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <aside
      className={`sr-rail view-${view} ${projectsPanelOpen ? 'projects-panel-open' : ''}`}
      data-testid="home-sidebar"
      aria-label="Sessions"
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
        {view === 'inbox'
          ? inboxPanel
          : view === 'projects'
            ? projectsPanel
            : view === 'files'
              ? filesPanel
              : sessionsPanel}
      </section>
    </aside>
  );
}
