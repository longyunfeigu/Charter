import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ChannelResponse,
  DirEntryDto,
  DiscoveredSessionDto,
  TaskDto,
} from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore, type ProjectCenterTab } from '../store/appStore.js';
import { useArchaeologyStore } from '../store/archaeologyStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { useExternalStore } from '../store/externalStore.js';
import { agentDisplayName } from '../store/agentCatalogStore.js';
import { useOrchestrationStore } from '../store/orchestrationStore.js';
import { RUNNING_TASK_STATES, useTaskStore } from '../store/taskStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useTerminalStore } from './TerminalPanel.js';
import { canResumeExternal, isHistoryTask, needsAttention, presentedMeta } from './labels.js';
import { Ic, ProviderMark, type ProviderMarkKind } from './home-icons.js';
import {
  bucketSessionHistory,
  sessionHistoryItems,
  sessionHistoryMatches,
  type SessionHistoryItem,
} from './session-history.js';
import { visibleProjectSessionTasks } from './mission-session-visibility.js';

type ProjectInspection = ChannelResponse<'project.inspect'>;
type ProjectFile = ChannelResponse<'project.readFile'>;
type SessionFilter = 'all' | 'active' | 'attention' | 'finished';
type SourceFilter = 'all' | 'tracked' | 'external';

const TABS: Array<{ id: ProjectCenterTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'files', label: 'Files' },
  { id: 'changes', label: 'Changes' },
  { id: 'setup', label: 'Setup' },
];
const MANUAL_REFRESH_FEEDBACK_MS = 500;

function relativeTime(value: string | null, now = Date.now()): string {
  if (!value) return 'No activity yet';
  const delta = Math.max(0, now - Date.parse(value));
  if (!Number.isFinite(delta)) return 'Unknown';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value),
  );
}

function providerForTask(task: TaskDto): ProviderMarkKind {
  if (task.external) return task.external.cli;
  return 'pi';
}

function providerLabel(task: TaskDto): string {
  if (!task.external) return 'Charter';
  return agentDisplayName(task.external.cli);
}

function isLive(task: TaskDto): boolean {
  return task.external?.status === 'active' || RUNNING_TASK_STATES.has(task.state);
}

function sessionMatches(task: TaskDto, state: SessionFilter): boolean {
  if (state === 'active') return isLive(task);
  if (state === 'attention') return needsAttention(task);
  if (state === 'finished') return isHistoryTask(task);
  return true;
}

async function openTrackedTask(task: TaskDto): Promise<void> {
  await useTaskStore.getState().openTask(task.id);
  useAppStore.getState().openTaskRoom(task.id);
}

function EmptyState(props: {
  icon: string;
  title: string;
  detail: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="pc-empty">
      <span className="pc-empty-icon">
        <Ic name={props.icon} size={20} />
      </span>
      <strong>{props.title}</strong>
      <p>{props.detail}</p>
      {props.action}
    </div>
  );
}

function SessionCard({ task }: { task: TaskDto }): React.JSX.Element {
  const meta = presentedMeta(task);
  const resuming = useExternalStore((state) => state.resumingTaskId === task.id);
  return (
    <article className="pc-session-card" data-testid={`project-session-${task.id}`}>
      <ProviderMark provider={providerForTask(task)} size={18} />
      <button className="pc-session-copy" onClick={() => void openTrackedTask(task)}>
        <strong>{task.title || 'Untitled session'}</strong>
        <span>
          {providerLabel(task)} · {meta.label}
          {task.changedFiles != null ? ` · ${task.changedFiles} changed` : ''}
        </span>
      </button>
      <div className="pc-session-end">
        <time dateTime={task.updatedAt}>{relativeTime(task.updatedAt)}</time>
        {canResumeExternal(task) ? (
          <button
            className="pc-button subtle"
            disabled={resuming}
            onClick={() => void useExternalStore.getState().resumeTask(task)}
          >
            <Ic name="play" size={11} /> {resuming ? 'Resuming…' : 'Resume'}
          </button>
        ) : (
          <button className="pc-button subtle" onClick={() => void openTrackedTask(task)}>
            Open
          </button>
        )}
      </div>
    </article>
  );
}

function DiscoveredSessionCard({ session }: { session: DiscoveredSessionDto }): React.JSX.Element {
  const adopting = useArchaeologyStore((state) => state.adoptingId === session.sessionId);
  return (
    <article
      className="pc-session-card discovered"
      data-testid={`project-session-${session.sessionId}`}
    >
      <ProviderMark provider={session.cli} size={18} />
      <div className="pc-session-copy">
        <strong>{session.title || `${session.cli} conversation`}</strong>
        <span>
          Ran outside Charter · {session.turnCount} turn{session.turnCount === 1 ? '' : 's'}
          {session.filesTouched.length > 0 ? ` · ${session.filesTouched.length} files` : ''}
        </span>
      </div>
      <div className="pc-session-end">
        <time dateTime={session.endedAt ?? undefined}>
          {relativeTime(session.endedAt ?? session.startedAt)}
        </time>
        <button
          className="pc-button subtle"
          disabled={adopting}
          onClick={() => void useArchaeologyStore.getState().adopt(session)}
        >
          <Ic name="play" size={11} /> {adopting ? 'Resuming…' : 'Resume'}
        </button>
      </div>
    </article>
  );
}

function OverviewTab(props: {
  inspection: ProjectInspection;
  tasks: TaskDto[];
  history: SessionHistoryItem[];
  onTab(tab: ProjectCenterTab): void;
  onNewSession(): void;
}): React.JSX.Element {
  const { inspection, tasks, history } = props;
  const live = tasks.filter(isLive).length;
  const attention = tasks.filter(needsAttention).length;
  const lastActivity = [
    inspection.lastOpenedAt,
    ...tasks.map((task) => task.updatedAt),
    ...history.map((item) => item.at).filter(Boolean),
  ].toSorted((a, b) => (b ?? '').localeCompare(a ?? ''))[0];
  const recent = history.slice(0, 4);
  const setupCount = [
    inspection.setup.agentsMd,
    inspection.setup.claudeMd,
    inspection.setup.agentsDir,
    inspection.setup.piDir,
  ].filter(Boolean).length;

  return (
    <div className="pc-overview" data-testid="project-center-overview">
      <section className="pc-metrics" aria-label="Project status">
        <button onClick={() => props.onTab('sessions')}>
          <span>Live now</span>
          <strong data-testid="project-live-count">{live}</strong>
          <small>{live === 0 ? 'No agents running' : 'Open running sessions'}</small>
        </button>
        <button className={attention > 0 ? 'warn' : ''} onClick={() => props.onTab('sessions')}>
          <span>Needs you</span>
          <strong>{attention}</strong>
          <small>{attention === 0 ? 'Nothing blocking' : 'Review pending decisions'}</small>
        </button>
        <button onClick={() => props.onTab('changes')}>
          <span>Working tree</span>
          <strong>{inspection.git.entries.length}</strong>
          <small>
            {!inspection.git.isRepo
              ? 'Not a Git repository'
              : inspection.git.entries.length === 0
                ? 'Clean'
                : 'Changed files'}
          </small>
        </button>
        <div>
          <span>Last activity</span>
          <strong className="pc-metric-time">{relativeTime(lastActivity ?? null)}</strong>
          <small>{history.length} known sessions</small>
        </div>
      </section>

      <div className="pc-overview-grid">
        <section className="pc-panel pc-recent-sessions">
          <header>
            <div>
              <strong>Recent sessions</strong>
              <span>Work and conversations attributed to this project</span>
            </div>
            <button className="pc-text-button" onClick={() => props.onTab('sessions')}>
              View all <Ic name="chevron" size={10} />
            </button>
          </header>
          {recent.length > 0 ? (
            <div className="pc-session-list">
              {recent.map((item) =>
                item.kind === 'task' ? (
                  <SessionCard key={item.key} task={item.task} />
                ) : (
                  <DiscoveredSessionCard key={item.key} session={item.session} />
                ),
              )}
            </div>
          ) : (
            <EmptyState
              icon="terminal"
              title="No Charter sessions yet"
              detail="Start a session when you want the agent, evidence, and review tied to this project."
              action={
                <button className="pc-button primary" onClick={props.onNewSession}>
                  <Ic name="plus" size={12} /> New Session
                </button>
              }
            />
          )}
        </section>

        <aside className="pc-overview-side">
          <section className="pc-panel pc-git-summary">
            <header>
              <div>
                <strong>Repository</strong>
                <span>Observed directly from disk</span>
              </div>
              <Ic name="branch" size={15} />
            </header>
            {inspection.git.isRepo ? (
              <dl>
                <div>
                  <dt>Branch</dt>
                  <dd>{inspection.git.branch ?? inspection.git.head?.slice(0, 8) ?? 'Detached'}</dd>
                </div>
                <div>
                  <dt>Sync</dt>
                  <dd>
                    {inspection.git.ahead > 0 ? `↑${inspection.git.ahead}` : ''}
                    {inspection.git.behind > 0 ? ` ↓${inspection.git.behind}` : ''}
                    {inspection.git.ahead === 0 && inspection.git.behind === 0 ? 'Up to date' : ''}
                  </dd>
                </div>
                <div>
                  <dt>Changes</dt>
                  <dd>{inspection.git.entries.length}</dd>
                </div>
              </dl>
            ) : (
              <p className="pc-panel-note">This folder is not a Git repository.</p>
            )}
          </section>

          <section className="pc-panel pc-setup-summary">
            <header>
              <div>
                <strong>Agent setup</strong>
                <span>{setupCount} project resources detected</span>
              </div>
              <button className="pc-text-button" onClick={() => props.onTab('setup')}>
                Manage
              </button>
            </header>
            <div className={`pc-trust-line ${inspection.trustState}`}>
              <Ic name="shield" size={14} />
              <span>
                <strong>
                  {inspection.trustState === 'trusted' ? 'Trusted project' : 'Extensions blocked'}
                </strong>
                <small>
                  {inspection.trustState === 'trusted'
                    ? 'Local agent resources may load'
                    : 'Project resources stay disabled'}
                </small>
              </span>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function SessionsTab(props: {
  items: SessionHistoryItem[];
  onBrowseAll(): void;
}): React.JSX.Element {
  const [stateFilter, setStateFilter] = useState<SessionFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [query, setQuery] = useState('');
  const filtered = props.items.filter((item) => {
    if (!sessionHistoryMatches(item, query)) return false;
    if (sourceFilter === 'tracked' && item.kind !== 'task') return false;
    if (sourceFilter === 'external' && item.kind !== 'discovered') return false;
    if (item.kind === 'task') return sessionMatches(item.task, stateFilter);
    return stateFilter === 'all' || stateFilter === 'finished';
  });
  const buckets = bucketSessionHistory(filtered);

  return (
    <div className="pc-tab-page" data-testid="project-center-sessions">
      <div className="pc-tab-toolbar">
        <label className="pc-session-search">
          <Ic name="search" size={13} />
          <input
            value={query}
            aria-label="Search project sessions"
            placeholder="Search titles, goals, files or skills…"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <button className="pc-text-button pc-browse-archive" onClick={props.onBrowseAll}>
          Browse all machine history <Ic name="chevron" size={10} />
        </button>
      </div>
      <div className="pc-session-filters">
        <div className="pc-filter-group" role="group" aria-label="Session state">
          {(['all', 'active', 'attention', 'finished'] as const).map((filter) => (
            <button
              key={filter}
              className={stateFilter === filter ? 'active' : ''}
              onClick={() => setStateFilter(filter)}
            >
              {filter === 'all'
                ? 'All'
                : filter === 'active'
                  ? 'Live'
                  : filter === 'attention'
                    ? 'Needs you'
                    : 'Finished'}
            </button>
          ))}
        </div>
        <div className="pc-filter-group" role="group" aria-label="Session source">
          {(['all', 'tracked', 'external'] as const).map((filter) => (
            <button
              key={filter}
              className={sourceFilter === filter ? 'active' : ''}
              onClick={() => setSourceFilter(filter)}
            >
              {filter === 'all' ? 'All sources' : filter === 'tracked' ? 'Tracked' : 'External'}
            </button>
          ))}
        </div>
      </div>
      {buckets.length > 0 ? (
        <div className="pc-history">
          {buckets.map((bucket) => (
            <section className="pc-history-group" key={bucket.key}>
              <header>
                <strong>{bucket.label}</strong>
                <span>{bucket.items.length}</span>
              </header>
              <div className="pc-session-list roomy">
                {bucket.items.map((item) =>
                  item.kind === 'task' ? (
                    <SessionCard key={item.key} task={item.task} />
                  ) : (
                    <DiscoveredSessionCard key={item.key} session={item.session} />
                  ),
                )}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="terminal"
          title="No sessions match"
          detail="Change the filters to see other work attached to this project."
        />
      )}
    </div>
  );
}

function FileTree(props: {
  dir: string;
  dirs: Record<string, DirEntryDto[] | undefined>;
  expanded: ReadonlySet<string>;
  selected: string | null;
  onToggle(path: string): void;
  onSelect(path: string): void;
}): React.JSX.Element {
  const entries = props.dirs[props.dir];
  if (!entries) return <div className="pc-tree-loading">Loading…</div>;
  if (entries.length === 0) return <div className="pc-tree-empty">Empty folder</div>;
  return (
    <div className="pc-tree-level">
      {entries.map((entry) => {
        const path = props.dir ? `${props.dir}/${entry.name}` : entry.name;
        const folder = entry.kind === 'dir';
        const open = folder && props.expanded.has(path);
        return (
          <React.Fragment key={path}>
            <button
              className={`pc-tree-row ${props.selected === path ? 'selected' : ''} ${entry.ignored ? 'ignored' : ''}`}
              data-testid={`project-file-${path}`}
              style={{ '--pc-tree-depth': path.split('/').length - 1 } as React.CSSProperties}
              onClick={() => (folder ? props.onToggle(path) : props.onSelect(path))}
              title={path}
            >
              {folder ? (
                <Ic name="chevron" size={10} className={open ? 'open' : ''} />
              ) : (
                <span className="pc-tree-spacer" />
              )}
              <Ic name={folder ? 'folder' : 'file'} size={13} />
              <span>{entry.name}</span>
              {entry.ignored ? <small>ignored</small> : null}
            </button>
            {open ? <FileTree {...props} dir={path} /> : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function FilesTab(props: {
  projectPath: string;
  onOpenEditor(file?: string): void;
}): React.JSX.Element {
  const [dirs, setDirs] = useState<Record<string, DirEntryDto[] | undefined>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProjectFile | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);

  const loadDir = useCallback(
    async (dir: string): Promise<void> => {
      const result = await rpcResult('project.listDir', {
        path: props.projectPath,
        dir,
        showIgnored,
      });
      if (result.ok) setDirs((current) => ({ ...current, [dir]: result.data.entries }));
    },
    [props.projectPath, showIgnored],
  );

  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    setSelected(null);
    setPreview(null);
    void loadDir('');
  }, [loadDir]);

  const toggle = (dir: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
    if (dirs[dir] === undefined) void loadDir(dir);
  };

  const select = async (file: string): Promise<void> => {
    setSelected(file);
    setLoadingPreview(true);
    const result = await rpcResult('project.readFile', { path: props.projectPath, file });
    setLoadingPreview(false);
    if (result.ok) setPreview(result.data);
    else {
      setPreview(null);
      useAppStore.getState().pushToast('error', result.error.userMessage);
    }
  };

  return (
    <div className="pc-files" data-testid="project-center-files">
      <aside className="pc-file-browser">
        <header>
          <strong>Project files</strong>
          <label>
            <input
              type="checkbox"
              checked={showIgnored}
              onChange={(event) => setShowIgnored(event.currentTarget.checked)}
            />
            Show ignored
          </label>
        </header>
        <div className="pc-file-tree">
          <FileTree
            dir=""
            dirs={dirs}
            expanded={expanded}
            selected={selected}
            onToggle={toggle}
            onSelect={(file) => void select(file)}
          />
        </div>
      </aside>
      <section className="pc-file-preview">
        {selected ? (
          <>
            <header>
              <div>
                <strong>{selected.split('/').at(-1)}</strong>
                <span>{selected}</span>
              </div>
              <button className="pc-button" onClick={() => props.onOpenEditor(selected)}>
                Open in editor
              </button>
            </header>
            {loadingPreview ? (
              <div className="pc-preview-message">Loading preview…</div>
            ) : preview?.binary ? (
              <div className="pc-preview-message">
                Binary file · {preview.size.toLocaleString()} bytes
              </div>
            ) : (
              <pre>
                <code>{preview?.content ?? ''}</code>
                {preview?.truncated ? '\n\n— Preview truncated at 256 KiB —' : ''}
              </pre>
            )}
          </>
        ) : (
          <EmptyState
            icon="file"
            title="Select a file"
            detail="Browse safely without changing the current working project."
          />
        )}
      </section>
    </div>
  );
}

function ChangesTab(props: {
  inspection: ProjectInspection;
  onOpenChanges(): void;
}): React.JSX.Element {
  const { git } = props.inspection;
  const stats = new Map(git.stats.map((item) => [item.path, item]));
  const groups = (['conflict', 'staged', 'changes', 'untracked'] as const)
    .map((group) => ({ group, entries: git.entries.filter((entry) => entry.group === group) }))
    .filter((group) => group.entries.length > 0);
  const labels = {
    conflict: 'Conflicts',
    staged: 'Staged changes',
    changes: 'Changes',
    untracked: 'Untracked files',
  };

  if (!git.gitAvailable) {
    return (
      <EmptyState
        icon="alert"
        title="Git status unavailable"
        detail="Charter could not read this repository. Files and sessions remain available."
      />
    );
  }
  if (!git.isRepo) {
    return (
      <EmptyState
        icon="branch"
        title="Not a Git repository"
        detail="No working-tree changes to show."
      />
    );
  }
  return (
    <div className="pc-tab-page" data-testid="project-center-changes">
      <div className="pc-changes-head">
        <div>
          <strong>{git.branch ?? git.head?.slice(0, 8) ?? 'Detached HEAD'}</strong>
          <span>
            {git.entries.length === 0
              ? 'Working tree clean'
              : `${git.entries.length} changed file${git.entries.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <button className="pc-button" onClick={props.onOpenChanges}>
          Open full Changes
        </button>
      </div>
      {groups.length > 0 ? (
        <div className="pc-change-groups">
          {groups.map(({ group, entries }) => (
            <section className="pc-change-group" key={group}>
              <header>
                <strong>{labels[group]}</strong>
                <span>{entries.length}</span>
              </header>
              {entries.map((entry) => {
                const stat = stats.get(entry.path);
                return (
                  <div className="pc-change-row" key={`${group}:${entry.path}`}>
                    <span className={`pc-change-code ${group}`}>
                      {group === 'untracked'
                        ? 'U'
                        : group === 'conflict'
                          ? '!'
                          : entry.workState.trim() || entry.indexState.trim() || 'M'}
                    </span>
                    <span title={entry.path}>{entry.path}</span>
                    {stat ? (
                      <small>
                        <i>+{stat.insertions}</i> <b>−{stat.deletions}</b>
                      </small>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="checkCircle"
          title="Working tree clean"
          detail="There are no local changes."
        />
      )}
    </div>
  );
}

function SetupTab(props: {
  inspection: ProjectInspection;
  onTrust(trusted: boolean): void;
  onOpenEditor(file: string): void;
}): React.JSX.Element {
  const items = [
    {
      key: 'agentsMd' as const,
      name: 'AGENTS.md',
      detail: 'Project instructions used by Codex and compatible agents.',
      file: true,
    },
    {
      key: 'claudeMd' as const,
      name: 'CLAUDE.md',
      detail: 'Project instructions used by Claude Code.',
      file: true,
    },
    {
      key: 'agentsDir' as const,
      name: '.agents/',
      detail: 'Project-scoped agent resources and reusable capabilities.',
      file: false,
    },
    {
      key: 'piDir' as const,
      name: '.pi/',
      detail: 'Charter project metadata and local agent configuration.',
      file: false,
    },
  ];
  return (
    <div className="pc-tab-page pc-setup" data-testid="project-center-setup">
      <section className="pc-panel pc-trust-card">
        <div className={`pc-setup-icon ${props.inspection.trustState}`}>
          <Ic name="shield" size={19} />
        </div>
        <div>
          <strong>Project trust</strong>
          <p>
            Trust controls whether project-owned instructions and agent extensions may load. It does
            not affect file browsing or Git status.
          </p>
        </div>
        <button
          className={`pc-button ${props.inspection.trustState === 'trusted' ? '' : 'primary'}`}
          onClick={() => props.onTrust(props.inspection.trustState !== 'trusted')}
        >
          {props.inspection.trustState === 'trusted' ? 'Mark untrusted' : 'Trust project'}
        </button>
      </section>
      <section className="pc-setup-list">
        <header>
          <div>
            <strong>Detected project resources</strong>
            <span>Read from the project root; no inferred or placeholder settings.</span>
          </div>
        </header>
        {items.map((item) => {
          const present = props.inspection.setup[item.key];
          return (
            <article key={item.key} data-testid={`project-setup-${item.key}`}>
              <span className={`pc-resource-state ${present ? 'present' : ''}`}>
                <Ic name={present ? 'check' : 'x'} size={12} />
              </span>
              <div>
                <strong>{item.name}</strong>
                <p>{item.detail}</p>
              </div>
              <span className="pc-resource-label">{present ? 'Detected' : 'Not found'}</span>
              {present && item.file ? (
                <button className="pc-button subtle" onClick={() => props.onOpenEditor(item.name)}>
                  Open
                </button>
              ) : null}
            </article>
          );
        })}
      </section>
    </div>
  );
}

export function ProjectCenterView(): React.JSX.Element {
  const center = useAppStore((state) => state.projectCenter);
  const setTab = useAppStore((state) => state.setProjectCenterTab);
  const pushToast = useAppStore((state) => state.pushToast);
  const workspace = useWorkspaceStore((state) => state.workspace);
  const tasks = useTaskStore((state) => state.tasks);
  const discovered = useArchaeologyStore((state) => state.sessions);
  const missionsById = useOrchestrationStore((state) => state.missionsById);
  const missionOrder = useOrchestrationStore((state) => state.missionOrder);
  const deletedMissionsById = useOrchestrationStore((state) => state.deletedMissionsById);
  const deletedMissionOrder = useOrchestrationStore((state) => state.deletedMissionOrder);
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);
  const [catalogTasks, setCatalogTasks] = useState<TaskDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectPath = center?.path ?? '';
  const projectTasks = useMemo(() => {
    const merged = new Map(catalogTasks.map((task) => [task.id, task]));
    for (const task of tasks) merged.set(task.id, task);
    return [...merged.values()].filter((task) => task.projectPath === projectPath);
  }, [catalogTasks, projectPath, tasks]);
  const missionSnapshots = useMemo(
    () =>
      [...missionOrder, ...deletedMissionOrder].flatMap((id) => {
        const snapshot = missionsById[id] ?? deletedMissionsById[id];
        return snapshot ? [snapshot] : [];
      }),
    [deletedMissionOrder, deletedMissionsById, missionOrder, missionsById],
  );
  const projectSessionTasks = useMemo(
    () => visibleProjectSessionTasks(projectTasks, missionSnapshots),
    [missionSnapshots, projectTasks],
  );
  const projectHistory = useMemo(
    () => sessionHistoryItems(projectSessionTasks, discovered, projectPath),
    [discovered, projectPath, projectSessionTasks],
  );
  const current = workspace?.path === projectPath;

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectPath) return;
    setLoading(true);
    setError(null);
    const [result, taskResult] = await Promise.all([
      rpcResult('project.inspect', { path: projectPath }),
      rpcResult('task.list', { filter: 'all', includeArchived: true, scope: 'all' }),
    ]);
    setLoading(false);
    if (result.ok) setInspection(result.data);
    else setError(result.error.userMessage);
    if (taskResult.ok) setCatalogTasks(taskResult.data.tasks);
  }, [projectPath]);

  const manualRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) return;
    const startedAt = performance.now();
    setRefreshing(true);
    try {
      await Promise.all([
        refresh(),
        useArchaeologyStore.getState().scan(true),
        useOrchestrationStore.getState().refreshMissions(),
        useOrchestrationStore.getState().refreshDeletedMissions(),
      ]);
    } finally {
      const remaining = MANUAL_REFRESH_FEEDBACK_MS - (performance.now() - startedAt);
      if (remaining > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
      }
      setRefreshing(false);
    }
  }, [refresh, refreshing]);

  useEffect(() => {
    useOrchestrationStore.getState().init();
    void refresh();
    void useArchaeologyStore.getState().scan();
  }, [refresh]);

  const activate = async (): Promise<boolean> => {
    if (useWorkspaceStore.getState().workspace?.path === projectPath) return true;
    useAppStore.getState().setHomePick(true);
    await useWorkspaceStore.getState().openPath(projectPath);
    return useWorkspaceStore.getState().workspace?.path === projectPath;
  };

  const setCurrent = async (): Promise<void> => {
    if (!(await activate())) return;
    pushToast('success', `${inspection?.displayName ?? 'Project'} is now the working context.`);
  };

  const newSession = async (): Promise<void> => {
    if (!(await activate())) return;
    const app = useAppStore.getState();
    app.openSessionHome();
    app.focusComposer();
  };

  const openTerminal = async (): Promise<void> => {
    const id = await useTerminalStore.getState().create({
      context: { kind: 'recent', projectPath },
      launch: 'shell',
      reveal: false,
      title: inspection?.displayName ? `${inspection.displayName} shell` : 'Project shell',
    });
    if (id) useAppStore.getState().openTerminalSession(id);
  };

  const openEditor = async (file?: string): Promise<void> => {
    if (!(await activate())) return;
    if (file) await useEditorStore.getState().openFile(file);
    useAppStore.getState().setProjectTool('editor');
  };

  const openChanges = async (): Promise<void> => {
    if (!(await activate())) return;
    useAppStore.getState().setProjectTool('changes');
  };

  const setTrust = async (trusted: boolean): Promise<void> => {
    const result = await rpcResult('project.setTrust', { path: projectPath, trusted });
    if (!result.ok) {
      pushToast('error', result.error.userMessage);
      return;
    }
    setInspection((value) => (value ? { ...value, trustState: result.data.trustState } : value));
    if (current)
      useWorkspaceStore.setState({
        workspace: workspace ? { ...workspace, trustState: result.data.trustState } : null,
        trustPromptVisible: false,
      });
    pushToast(
      trusted ? 'warning' : 'info',
      trusted
        ? 'Project-owned agent resources may now load.'
        : 'Project-owned agent resources are now blocked.',
    );
  };

  if (!center) return <main className="pc-root" />;

  return (
    <main className="pc-root" data-testid="project-center">
      <header className="pc-header">
        <div className="pc-identity">
          <div className="pc-title-line">
            <h1>{inspection?.displayName ?? projectPath.split('/').at(-1) ?? 'Project'}</h1>
            {current ? <span className="pc-badge current">Current</span> : null}
            {inspection && !inspection.exists ? (
              <span className="pc-badge unavailable">Unavailable</span>
            ) : null}
            {inspection?.kind ? <span className="pc-badge">{inspection.kind}</span> : null}
          </div>
          <p title={projectPath}>{projectPath}</p>
          {inspection?.git.isRepo ? (
            <span className="pc-header-git">
              <Ic name="branch" size={11} />
              {inspection.git.branch ?? inspection.git.head?.slice(0, 8) ?? 'Detached'}
              {inspection.git.entries.length > 0
                ? ` · ${inspection.git.entries.length} changes`
                : ' · clean'}
            </span>
          ) : null}
        </div>
        <div className="pc-actions">
          {!current && inspection?.exists ? (
            <button
              className="pc-button"
              data-testid="project-set-current"
              onClick={() => void setCurrent()}
            >
              <Ic name="check" size={12} /> Set as current
            </button>
          ) : null}
          <button
            className="pc-button"
            disabled={!inspection?.exists}
            data-testid="project-open-terminal"
            onClick={() => void openTerminal()}
          >
            <Ic name="terminal" size={12} /> Terminal
          </button>
          <button
            className="pc-button primary"
            disabled={!inspection?.exists}
            data-testid="project-new-session"
            onClick={() => void newSession()}
          >
            <Ic name="plus" size={12} /> New Session
          </button>
          <button
            className="pc-icon-button"
            title="Reveal project in Finder"
            aria-label="Reveal project in Finder"
            disabled={!inspection?.exists}
            onClick={() => void rpcResult('app.revealPath', { path: projectPath })}
          >
            <Ic name="folder-open" size={14} />
          </button>
          <button
            className={`pc-icon-button pc-refresh-button ${refreshing ? 'is-refreshing' : ''}`}
            title={refreshing ? 'Refreshing project data…' : 'Refresh project data'}
            aria-label={refreshing ? 'Refreshing project data' : 'Refresh project data'}
            aria-busy={refreshing}
            data-testid="project-refresh"
            disabled={refreshing}
            onClick={() => void manualRefresh()}
          >
            <Ic name="refresh" size={14} className={refreshing ? 'is-spinning' : undefined} />
          </button>
        </div>
      </header>

      <nav className="pc-tabs" role="tablist" aria-label="Project center">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={center.tab === tab.id}
            className={center.tab === tab.id ? 'active' : ''}
            data-testid={`project-center-tab-${tab.id}`}
            onClick={() => setTab(tab.id)}
          >
            {tab.label}
            {tab.id === 'sessions' && projectHistory.length > 0 ? (
              <span>{projectHistory.length}</span>
            ) : null}
            {tab.id === 'changes' && (inspection?.git.entries.length ?? 0) > 0 ? (
              <span>{inspection?.git.entries.length}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="pc-body">
        {loading && !inspection ? (
          <div className="pc-loading">Loading project…</div>
        ) : error ? (
          <EmptyState
            icon="alert"
            title="Project data unavailable"
            detail={error}
            action={
              <button className="pc-button" onClick={() => void refresh()}>
                Try again
              </button>
            }
          />
        ) : inspection && !inspection.exists && center.tab !== 'sessions' ? (
          <EmptyState
            icon="folder"
            title="Project folder unavailable"
            detail="The saved folder no longer exists at this path. Sessions remain visible, but files, changes, and setup cannot be inspected."
          />
        ) : inspection ? (
          center.tab === 'overview' ? (
            <OverviewTab
              inspection={inspection}
              tasks={projectSessionTasks}
              history={projectHistory}
              onTab={setTab}
              onNewSession={() => void newSession()}
            />
          ) : center.tab === 'sessions' ? (
            <SessionsTab
              items={projectHistory}
              onBrowseAll={() => useAppStore.getState().openArchaeology(null)}
            />
          ) : center.tab === 'files' ? (
            <FilesTab projectPath={projectPath} onOpenEditor={(file) => void openEditor(file)} />
          ) : center.tab === 'changes' ? (
            <ChangesTab inspection={inspection} onOpenChanges={() => void openChanges()} />
          ) : (
            <SetupTab
              inspection={inspection}
              onTrust={(trusted) => void setTrust(trusted)}
              onOpenEditor={(file) => void openEditor(file)}
            />
          )
        ) : null}
      </div>
    </main>
  );
}
