import React, { useEffect, useMemo, useState } from 'react';
import type { TaskDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { navigationSnapshotLabel, useAppStore } from '../store/appStore.js';
import {
  type ArchaeologyFilter,
  unknownDirectories,
  useArchaeologyStore,
} from '../store/archaeologyStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { Ic, ProviderMark, type ProviderMarkKind } from './home-icons.js';
import { presentedMeta } from './labels.js';
import { timeAgo } from './SessionRail.js';
import {
  bucketSessionHistory,
  sessionHistoryItems,
  sessionHistoryMatches,
  type SessionHistoryItem,
} from './session-history.js';
import { agentDisplayName } from '../store/agentCatalogStore.js';

/**
 * Session Archive is the user-facing form of ADR-0038 archaeology. It merges
 * Charter's complete task catalog with read-only Claude/Codex transcript
 * discovery, then deduplicates linked sessions into one time-first history.
 */

const FILTER_CHIPS: Array<{ key: ArchaeologyFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'external', label: 'External' },
  { key: 'tracked', label: 'Tracked' },
];

function pathTail(path: string): string {
  const tail = path.replace(/\/+$/, '').split('/').pop();
  return tail || path;
}

function compactHome(path: string): string {
  const home = path.match(/^\/Users\/[^/]+|^\/home\/[^/]+/)?.[0];
  return home ? `~${path.slice(home.length)}` : path;
}

function providerForItem(item: SessionHistoryItem): ProviderMarkKind {
  if (item.kind === 'discovered') return item.session.cli;
  if (item.task.external) return item.task.external.cli;
  return 'pi';
}

function providerLabel(item: SessionHistoryItem): string {
  const provider = providerForItem(item);
  return agentDisplayName(provider);
}

function itemTitle(item: SessionHistoryItem): string {
  return item.kind === 'task' ? item.task.title || 'Untitled session' : item.session.title;
}

function itemPath(item: SessionHistoryItem): string {
  return item.kind === 'task'
    ? item.task.projectPath
    : (item.session.projectPath ?? item.session.cwd);
}

function formatDate(value: string | null): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Not recorded';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

async function openTask(task: TaskDto): Promise<void> {
  await useTaskStore.getState().openTask(task.id);
  useAppStore.getState().openTaskRoom(task.id);
}

function ItemAction({ item, compact = false }: { item: SessionHistoryItem; compact?: boolean }) {
  const adoptingId = useArchaeologyStore((state) => state.adoptingId);
  if (item.kind === 'task') {
    return (
      <button
        className={`arch-btn ${compact ? 'compact' : 'primary'}`}
        data-testid="arch-open"
        onClick={(event) => {
          event.stopPropagation();
          void openTask(item.task);
        }}
      >
        Open
      </button>
    );
  }
  const adopting = adoptingId === item.session.sessionId;
  return (
    <button
      className={`arch-btn primary ${compact ? 'compact' : ''}`}
      data-testid="arch-resume"
      disabled={adopting}
      onClick={(event) => {
        event.stopPropagation();
        void useArchaeologyStore.getState().adopt(item.session);
      }}
    >
      <Ic name="play" size={10} /> {adopting ? 'Resuming…' : 'Resume'}
    </button>
  );
}

function HistoryRow(props: {
  item: SessionHistoryItem;
  selected: boolean;
  onSelect(): void;
}): React.JSX.Element {
  const { item } = props;
  const meta =
    item.kind === 'task'
      ? [
          providerLabel(item),
          presentedMeta(item.task).label,
          `${item.task.changedFiles ?? 0} changed`,
        ]
      : [
          providerLabel(item),
          'ran outside Charter',
          `${item.session.turnCount} turn${item.session.turnCount === 1 ? '' : 's'}`,
        ];
  return (
    <article
      className={`arch-row ${props.selected ? 'selected' : ''}`}
      data-testid="arch-row"
      tabIndex={0}
      onClick={props.onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') props.onSelect();
      }}
    >
      <ProviderMark provider={providerForItem(item)} size={15} />
      <span className="arch-copy">
        <span className="arch-title">
          <b title={itemTitle(item)}>{itemTitle(item)}</b>
          <span className={`sr-state ${item.kind === 'task' ? 'neutral' : 'found'}`}>
            {item.kind === 'task' ? 'Tracked' : 'External'}
          </span>
        </span>
        <span className="arch-meta">
          <span title={itemPath(item)}>
            {compactHome(itemPath(item))} · {meta.join(' · ')}
          </span>
          {item.at ? <time dateTime={item.at}>{timeAgo(item.at, Date.now())}</time> : null}
        </span>
      </span>
      <span className="arch-acts">
        <ItemAction item={item} compact />
      </span>
    </article>
  );
}

function SessionInspector({ item }: { item: SessionHistoryItem | null }): React.JSX.Element {
  if (!item) {
    return (
      <section className="arch-card arch-inspector-empty">
        <Ic name="clock" size={20} />
        <strong>Select a conversation</strong>
        <span>Inspect its origin and recorded footprint before opening or resuming it.</span>
      </section>
    );
  }
  const task = item.kind === 'task' ? item.task : null;
  const session = item.kind === 'discovered' ? item.session : null;
  return (
    <section className="arch-card arch-inspector" data-testid="arch-inspector">
      <header>
        <ProviderMark provider={providerForItem(item)} size={18} />
        <div>
          <strong>{itemTitle(item)}</strong>
          <span>
            {providerLabel(item)} ·{' '}
            {item.kind === 'task' ? 'Tracked by Charter' : 'External transcript'}
          </span>
        </div>
      </header>
      <dl>
        <div>
          <dt>Location</dt>
          <dd title={itemPath(item)}>{compactHome(itemPath(item))}</dd>
        </div>
        <div>
          <dt>Last activity</dt>
          <dd>{formatDate(item.at)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{task ? presentedMeta(task).label : 'Available to resume'}</dd>
        </div>
        <div>
          <dt>Recorded work</dt>
          <dd>
            {session
              ? `${session.turnCount} turn${session.turnCount === 1 ? '' : 's'} · ${session.filesTouched.length} file${session.filesTouched.length === 1 ? '' : 's'}`
              : `${task?.changedFiles ?? 0} changed file${task?.changedFiles === 1 ? '' : 's'}`}
          </dd>
        </div>
      </dl>
      {session && session.filesTouched.length > 0 ? (
        <div className="arch-footprint">
          <strong>Files touched</strong>
          <ul>
            {session.filesTouched.slice(0, 8).map((file) => (
              <li key={file} title={file}>
                {file}
              </li>
            ))}
          </ul>
          {session.filesTouched.length > 8 ? (
            <small>+{session.filesTouched.length - 8} more</small>
          ) : null}
        </div>
      ) : null}
      {session && session.skills.length > 0 ? (
        <div className="arch-footprint">
          <strong>Skills observed</strong>
          <div className="arch-skill-list">
            {session.skills.map((skill) => (
              <span key={skill}>{skill}</span>
            ))}
          </div>
        </div>
      ) : null}
      <footer>
        <ItemAction item={item} />
      </footer>
    </section>
  );
}

export function ArchaeologyView(): React.JSX.Element {
  const archaeology = useAppStore((state) => state.archaeology);
  const scope = archaeology?.scope ?? null;
  const closeArchaeology = useAppStore((state) => state.closeArchaeology);
  const openArchaeology = useAppStore((state) => state.openArchaeology);
  const backTarget = useAppStore((state) => state.navigationBack.at(-1) ?? null);
  const backLabel = backTarget
    ? navigationSnapshotLabel(backTarget)
    : scope
      ? 'Session Archive'
      : 'Sessions';
  const store = useArchaeologyStore();
  const liveTasks = useTaskStore((state) => state.tasks);
  const [catalogTasks, setCatalogTasks] = useState<TaskDto[]>([]);
  const [filter, setFilter] = useState<ArchaeologyFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    void store.scan();
    void rpcResult('task.list', { filter: 'all', includeArchived: true, scope: 'all' }).then(
      (result) => {
        if (result.ok) setCatalogTasks(result.data.tasks);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tasks = useMemo(() => {
    const merged = new Map(catalogTasks.map((task) => [task.id, task]));
    for (const task of liveTasks) merged.set(task.id, task);
    return [...merged.values()];
  }, [catalogTasks, liveTasks]);
  const items = useMemo(
    () => sessionHistoryItems(tasks, store.sessions, scope),
    [scope, store.sessions, tasks],
  );
  const externalCount = items.filter((item) => item.kind === 'discovered').length;
  const trackedCount = items.length - externalCount;
  const directories = useMemo(
    () => (scope === null ? unknownDirectories(store.sessions) : []),
    [scope, store.sessions],
  );
  const visible = useMemo(
    () =>
      items.filter((item) => {
        if (filter === 'external' && item.kind !== 'discovered') return false;
        if (filter === 'tracked' && item.kind !== 'task') return false;
        return sessionHistoryMatches(item, query);
      }),
    [filter, items, query],
  );
  const buckets = useMemo(() => bucketSessionHistory(visible), [visible]);
  const selected = visible.find((item) => item.key === selectedKey) ?? visible[0] ?? null;

  const addProject = async (cwd: string): Promise<void> => {
    const app = useAppStore.getState();
    app.setHomePick(true);
    const result = await rpcResult('workspace.open', { path: cwd });
    if (!result.ok) {
      app.setHomePick(false);
      app.pushToast('error', result.error.userMessage);
      return;
    }
    app.pushToast('success', `${pathTail(cwd)} was added as a project.`);
    app.openProjectCenter(cwd);
  };

  return (
    <main className="arch-root" data-testid="archaeology-view">
      <header className="arch-head">
        <button
          className="arch-back"
          data-testid="arch-back"
          aria-label={`Back to ${backLabel}`}
          title={`Back to ${backLabel}`}
          onClick={() =>
            backTarget
              ? useAppStore.getState().navigateBack()
              : scope
                ? openArchaeology(null)
                : closeArchaeology()
          }
        >
          <Ic name="chevron" size={12} /> {backLabel}
        </button>
        <div className="arch-heading">
          <strong>{scope ? pathTail(scope) : 'Session Archive'}</strong>
          <span title={scope ?? undefined}>
            {scope
              ? compactHome(scope)
              : 'Find and resume work from Charter, Claude Code and Codex'}
          </span>
        </div>
        <button
          className="arch-btn"
          data-testid="arch-rescan"
          disabled={store.loading}
          onClick={() => void store.scan(true)}
        >
          <Ic name="refresh" size={11} /> {store.loading ? 'Scanning…' : 'Rescan'}
        </button>
      </header>

      <div className="arch-scroll">
        <div className="arch-shell">
          <section className="arch-metrics" aria-label="Archive coverage">
            <div>
              <span>Conversations</span>
              <strong>{items.length}</strong>
            </div>
            <div>
              <span>Tracked</span>
              <strong>{trackedCount}</strong>
            </div>
            <div>
              <span>External</span>
              <strong>{externalCount}</strong>
            </div>
            <div>
              <span>{scope ? 'Turns discovered' : 'Unregistered folders'}</span>
              <strong>
                {scope
                  ? items.reduce(
                      (total, item) =>
                        total + (item.kind === 'discovered' ? item.session.turnCount : 0),
                      0,
                    )
                  : directories.length}
              </strong>
            </div>
          </section>

          <div className="arch-toolbar">
            <label className="arch-search">
              <Ic name="search" size={13} />
              <input
                value={query}
                aria-label="Search session archive"
                placeholder="Search title, goal, project, file or skill…"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <div className="arch-filters">
              {FILTER_CHIPS.map((chip) => {
                const count =
                  chip.key === 'all'
                    ? items.length
                    : chip.key === 'external'
                      ? externalCount
                      : trackedCount;
                return (
                  <button
                    key={chip.key}
                    className={`arch-chip ${filter === chip.key ? 'active' : ''}`}
                    data-testid={`arch-filter-${chip.key}`}
                    onClick={() => setFilter(chip.key)}
                  >
                    {chip.label} · {count}
                  </button>
                );
              })}
            </div>
          </div>

          {!store.enabled ? (
            <div className="arch-empty" data-testid="arch-disabled">
              External transcript discovery is disabled in this run. Tracked Charter sessions remain
              available.
            </div>
          ) : store.loading && items.length === 0 ? (
            <div className="arch-empty">Scanning Claude Code and Codex history read-only…</div>
          ) : null}

          <div className="arch-layout">
            <section className="arch-timeline" aria-label="Session history">
              {buckets.map((bucket) => (
                <React.Fragment key={bucket.key}>
                  <div className="arch-sec">
                    {bucket.label} · {bucket.items.length}
                  </div>
                  {bucket.items.map((item) => (
                    <HistoryRow
                      key={item.key}
                      item={item}
                      selected={selected?.key === item.key}
                      onSelect={() => setSelectedKey(item.key)}
                    />
                  ))}
                </React.Fragment>
              ))}
              {visible.length === 0 ? (
                <div className="arch-empty" data-testid="arch-filter-empty">
                  No conversations match this search and filter.
                </div>
              ) : null}
            </section>

            <aside className="arch-side">
              <SessionInspector item={selected} />
              {scope === null && directories.length > 0 ? (
                <section className="arch-card arch-directories">
                  <header>
                    <div>
                      <strong>Unregistered folders</strong>
                      <span>Agent work found outside saved Charter projects</span>
                    </div>
                    <b>{directories.length}</b>
                  </header>
                  <div className="arch-directory-list">
                    {directories.map((dir) => (
                      <article className="arch-directory" key={dir.cwd} data-testid="arch-dir">
                        <button
                          className="arch-directory-main"
                          onClick={() => openArchaeology(dir.cwd)}
                        >
                          <Ic name="folder" size={13} />
                          <span>
                            <strong title={dir.cwd}>{compactHome(dir.cwd)}</strong>
                            <small>
                              {dir.clis.join(' + ')} · {dir.count} session
                              {dir.count === 1 ? '' : 's'}
                            </small>
                          </span>
                        </button>
                        <div className="arch-directory-actions">
                          <button
                            title="Reveal in Finder"
                            aria-label={`Reveal ${dir.cwd} in Finder`}
                            onClick={() => void rpcResult('app.revealPath', { path: dir.cwd })}
                          >
                            <Ic name="folder-open" size={11} />
                          </button>
                          <button
                            data-testid="arch-add-project"
                            onClick={() => void addProject(dir.cwd)}
                          >
                            Add project
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                  <footer>Codex discovery covers the last 30 days. Scanning is read-only.</footer>
                </section>
              ) : null}
            </aside>
          </div>
        </div>
      </div>
    </main>
  );
}
