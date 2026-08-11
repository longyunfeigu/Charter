import React, { useEffect, useMemo, useState } from 'react';
import type { GithubAuthStatusDto, TaskDto, WorkItemDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkItemStore } from '../store/workItemStore.js';
import {
  attentionItems,
  externalRef,
  incomingItems,
  isExternalItem,
  itemStatus,
  reviewItems,
  statusLabel,
  useForYouStore,
  type ForYouStatus,
  type ForYouTab,
} from '../store/forYouStore.js';
import { Ic } from './home-icons.js';
import { presentedMeta } from './labels.js';
import { ForYouImportDialog } from './ForYouImportDialog.js';
import '../styles/for-you.css';

/**
 * The work-rail of the external-work-inbox mock, replicated 1:1: Attention /
 * Incoming / Review buckets over one queue, source marks, search + source
 * filter + Import URL, and the connection footer. Every row is real: Attention
 * carries the app's session-decision signal and fired reminders; Incoming and
 * Review carry Work items.
 */

function relativeTime(iso: string, now: number): string {
  const delta = Math.max(0, now - Date.parse(iso));
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function Row(props: {
  id: string;
  testid: string;
  source: 'github' | 'charter';
  refLine: string;
  time: string;
  title: string;
  status: ForYouStatus;
  meta: string;
  selected: boolean;
  onSelect(): void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`fy-item ${props.selected ? 'selected' : ''}`}
      data-testid={props.testid}
      aria-pressed={props.selected}
      onClick={props.onSelect}
    >
      <span className={`fy-source-mark ${props.source}`}>
        {props.source === 'github' ? 'GH' : 'C'}
      </span>
      <span className="fy-item-main">
        <span className="fy-item-top">
          <span className="fy-item-ref mono" data-i18n-ignore>
            {props.refLine}
          </span>
          <span className="fy-item-time">{props.time}</span>
        </span>
        <span className="fy-item-title">{props.title}</span>
        <span className="fy-item-foot">
          <span className={`fy-status ${props.status}`}>
            <i /> {statusLabel(props.status)}
          </span>
          {props.meta ? (
            <span className="fy-item-meta" data-i18n-ignore>
              {props.meta}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

function ItemRow(props: { item: WorkItemDto; now: number }): React.JSX.Element {
  const { item, now } = props;
  const snapshot = useWorkItemStore((state) => state.snapshot);
  const selection = useForYouStore((state) => state.selection);
  const external = isExternalItem(item);
  const meta =
    item.labels.slice(0, 2).join(' · ') ||
    (typeof item.customFields.githubCommentCount === 'number' &&
    item.customFields.githubCommentCount > 0
      ? `${item.customFields.githubCommentCount} comments`
      : '');
  return (
    <Row
      id={item.id}
      testid={`fy-item-${item.id}`}
      source={external ? 'github' : 'charter'}
      refLine={externalRef(item) ?? String(item.customFields.repository ?? 'Local work')}
      time={relativeTime(item.updatedAt, now)}
      title={item.title}
      status={itemStatus(item, snapshot, snapshot.executions)}
      meta={meta}
      selected={selection?.kind === 'item' && selection.id === item.id}
      onSelect={() => void useForYouStore.getState().selectItem(item.id)}
    />
  );
}

function groupItems(items: WorkItemDto[]): Array<[string, WorkItemDto[]]> {
  const byProject = new Map<string, WorkItemDto[]>();
  for (const item of items) {
    const key =
      String(item.customFields.githubLocalProject ?? '') ||
      String(item.customFields.repository ?? '') ||
      'Local';
    byProject.set(key, [...(byProject.get(key) ?? []), item]);
  }
  return [...byProject.entries()];
}

function ItemList(props: { items: WorkItemDto[]; now: number }): React.JSX.Element {
  const groups = useMemo(() => groupItems(props.items), [props.items]);
  if (props.items.length === 0) {
    return (
      <div className="sr-empty" data-testid="fy-empty-list">
        No matching work
      </div>
    );
  }
  return (
    <>
      {groups.map(([project, items]) => (
        <section key={project} aria-label={`${project} work`}>
          <div className="fy-group-head">
            <span data-i18n-ignore>{project}</span>
            <span className="mono">{items.length}</span>
          </div>
          {items.map((item) => (
            <ItemRow key={item.id} item={item} now={props.now} />
          ))}
        </section>
      ))}
    </>
  );
}

/** Attention rows: sessions needing a decision + fired work reminders. */
function AttentionList(props: {
  tasks: TaskDto[];
  now: number;
  query: string;
  onClear(): void;
}): React.JSX.Element {
  const snapshot = useWorkItemStore((state) => state.snapshot);
  const selection = useForYouStore((state) => state.selection);
  const query = props.query.trim().toLowerCase();
  const tasks = props.tasks.filter(
    (task) => !query || `${task.title} ${task.projectName}`.toLowerCase().includes(query),
  );
  const reminders = attentionItems(snapshot).filter(
    (item) => !query || item.title.toLowerCase().includes(query),
  );
  if (tasks.length === 0 && reminders.length === 0) {
    return <div className="sr-empty">Nothing needs you right now.</div>;
  }
  return (
    <>
      <div className="fy-group-head">
        <span>Waiting on you</span>
        <button className="fy-clear-link" data-testid="rail-inbox-clear" onClick={props.onClear}>
          Clear all
        </button>
      </div>
      {tasks.map((task) => (
        <Row
          key={task.id}
          id={task.id}
          testid={`home-task-${task.id}`}
          source="charter"
          refLine={task.projectName || 'Session'}
          time={relativeTime(task.updatedAt, props.now)}
          title={task.title}
          status={task.state === 'REVIEW_READY' ? 'review' : 'blocked'}
          meta={`${presentedMeta(task).short} · ${task.external?.cli ?? 'Charter Agent'}`}
          selected={selection?.kind === 'task' && selection.id === task.id}
          onSelect={() => useForYouStore.getState().selectTask(task.id)}
        />
      ))}
      {reminders.map((item) => (
        <Row
          key={item.id}
          id={item.id}
          testid={`fy-item-${item.id}`}
          source={isExternalItem(item) ? 'github' : 'charter'}
          refLine={externalRef(item) ?? 'Reminder'}
          time={relativeTime(item.updatedAt, props.now)}
          title={item.title}
          status="blocked"
          meta="Reminder"
          selected={selection?.kind === 'item' && selection.id === item.id}
          onSelect={() => void useForYouStore.getState().selectItem(item.id)}
        />
      ))}
    </>
  );
}

export function ForYouRail(props: {
  attentionTasks: TaskDto[];
  now: number;
  onClearAttention(): void;
}): React.JSX.Element {
  const snapshot = useWorkItemStore((state) => state.snapshot);
  const initWorkItems = useWorkItemStore((state) => state.init);
  const tab = useForYouStore((state) => state.tab);
  const query = useForYouStore((state) => state.query);
  const source = useForYouStore((state) => state.source);
  const importOpen = useForYouStore((state) => state.importOpen);
  const [auth, setAuth] = useState<GithubAuthStatusDto | null>(null);

  useEffect(() => initWorkItems(), [initWorkItems]);
  useEffect(() => {
    void rpcResult('github.auth.status', {}).then((result) => {
      if (result.ok) setAuth(result.data);
    });
  }, [importOpen]);

  const incoming = useMemo(() => incomingItems(snapshot), [snapshot]);
  const review = useMemo(() => reviewItems(snapshot), [snapshot]);
  const reminderCount = useMemo(() => attentionItems(snapshot).length, [snapshot]);

  const filter = (items: WorkItemDto[]): WorkItemDto[] =>
    items.filter((item) => {
      if (source === 'github' && !isExternalItem(item)) return false;
      if (source === 'charter' && isExternalItem(item)) return false;
      const trimmed = query.trim().toLowerCase();
      if (!trimmed) return true;
      return [
        item.title,
        item.sourceUrl,
        String(item.customFields.repository ?? ''),
        ...item.labels,
      ]
        .join(' ')
        .toLowerCase()
        .includes(trimmed);
    });

  const counts: Record<ForYouTab, number> = {
    attention: props.attentionTasks.length + reminderCount,
    incoming: incoming.length,
    review: review.length,
  };
  const connection = !auth
    ? 'Checking GitHub connection…'
    : auth.method === 'pat'
      ? `GitHub connected · token${auth.tokenLogin ? ` @${auth.tokenLogin}` : ''}`
      : auth.method === 'gh-cli'
        ? 'GitHub connected · gh CLI'
        : 'GitHub not connected — public repos work';

  return (
    <>
      <header className="sr-head sr-head-plain fy-head">
        <div className="sr-heading-row">
          <strong>Work</strong>
          <div className="fy-tools">
            <button
              className="fy-icon-button"
              data-testid="fy-refresh"
              title="Refresh external work"
              aria-label="Refresh external work"
              onClick={() => void useWorkItemStore.getState().refresh()}
            >
              <Ic name="refresh" size={13} />
            </button>
            <button
              className="fy-icon-button"
              data-testid="fy-import-icon"
              title="Import issue from URL"
              aria-label="Import issue from URL"
              onClick={() => useForYouStore.getState().setImportOpen(true)}
            >
              <Ic name="plus" size={13} />
            </button>
          </div>
        </div>
        <p className="fy-subtitle">Requests, decisions, and finished work in one queue.</p>
        <div className="fy-tabs" role="tablist" aria-label="Work buckets">
          {(['attention', 'incoming', 'review'] as const).map((candidate) => (
            <button
              key={candidate}
              role="tab"
              aria-selected={tab === candidate}
              className={`fy-tab ${tab === candidate ? 'active' : ''}`}
              data-testid={`fy-tab-${candidate}`}
              onClick={() => useForYouStore.getState().setTab(candidate)}
            >
              {candidate === 'attention'
                ? 'Attention'
                : candidate === 'incoming'
                  ? 'Incoming'
                  : 'Review'}
              <span className="mono">{counts[candidate]}</span>
            </button>
          ))}
        </div>
      </header>
      <div className="fy-filter">
        <label className="fy-search">
          <Ic name="search" size={13} />
          <input
            data-testid="fy-search"
            value={query}
            placeholder="Find issue, project, or repo"
            onChange={(event) => useForYouStore.getState().setQuery(event.target.value)}
          />
        </label>
        <div className="fy-filter-row">
          <select
            data-testid="fy-source-filter"
            aria-label="Filter by source"
            value={source}
            onChange={(event) =>
              useForYouStore
                .getState()
                .setSource(event.target.value as 'all' | 'github' | 'charter')
            }
          >
            <option value="all">All sources</option>
            <option value="github">GitHub</option>
            <option value="charter">Charter</option>
          </select>
          <button
            className="fy-import-button"
            data-testid="fy-import-url"
            onClick={() => useForYouStore.getState().setImportOpen(true)}
          >
            <Ic name="external" size={12} /> Import URL
          </button>
        </div>
      </div>
      <div className="sr-scroll fy-scroll" data-testid="rail-inbox-panel">
        {tab === 'attention' ? (
          <AttentionList
            tasks={props.attentionTasks}
            now={props.now}
            query={query}
            onClear={props.onClearAttention}
          />
        ) : null}
        {tab === 'incoming' ? <ItemList items={filter(incoming)} now={props.now} /> : null}
        {tab === 'review' ? <ItemList items={filter(review)} now={props.now} /> : null}
      </div>
      <footer className="fy-foot">
        <span className="fy-sync">
          <i className={`fy-sync-dot ${auth && auth.method !== 'none' ? 'ok' : ''}`} />
          {connection}
        </span>
        <button
          className="fy-manage"
          data-testid="fy-manage"
          onClick={() => useAppStore.getState().openSettings('github')}
        >
          Manage
        </button>
      </footer>
      {importOpen ? (
        <ForYouImportDialog onClose={() => useForYouStore.getState().setImportOpen(false)} />
      ) : null}
    </>
  );
}
