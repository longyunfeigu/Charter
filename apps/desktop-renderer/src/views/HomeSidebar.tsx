import React, { useEffect, useMemo, useState } from 'react';
import type { RecentWorkspaceDto, TaskDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useTaskStore, RUNNING_TASK_STATES } from '../store/taskStore.js';
import { useActivityStore, currentActionLine, type TaskActivity } from '../store/activityStore.js';
import { useGlowTasks } from './useGlow.js';
import { HomeProjectTree } from './HomeProjectTree.js';
import { Ic } from './home-icons.js';
import { canArchiveTask, isAnswered, presentedMeta, stateTone } from './labels.js';
import { ArmedIconButton } from './ui.js';

/** Attention = the amber Inbox: states that block on the user (ADR-0009:
 * zero-change "Answered" tasks are excluded — they ask for nothing). */
export const ATTENTION_STATES = [
  'AWAITING_PERMISSION',
  'AWAITING_PLAN_APPROVAL',
  'REVIEW_READY',
  'INTERRUPTED',
  'FAILED',
];

export function needsAttention(t: TaskDto): boolean {
  return ATTENTION_STATES.includes(t.state) && !isAnswered(t);
}

function dotClass(t: TaskDto): string {
  const tone = isAnswered(t) ? 'ok' : stateTone(t.state);
  return tone === 'idle' ? 'done' : tone;
}

/** One-line "what is it doing" ticker for a running task (heartbeat layer). */
function tickerLine(activity: TaskActivity | undefined): { icon: string; text: string } | null {
  const action = currentActionLine(activity);
  if (!action) return null;
  const icon =
    action.kind === 'write'
      ? 'pencil'
      : action.kind === 'command' || action.kind === 'verification'
        ? 'play'
        : action.kind === 'read'
          ? 'search'
          : 'bot';
  return { icon, text: action.label };
}

/**
 * Persistent shell sidebar (PIVOT-028): always mounted — Launcher and Task
 * Room swap in the content area next to it. Global across projects
 * (ADR-0009): the heartbeat layer keeps every running task visible.
 */
export function HomeSidebar(): React.JSX.Element {
  const app = useAppStore();
  const workspaceStore = useWorkspaceStore();
  const taskStore = useTaskStore();
  const workspace = workspaceStore.workspace;
  const perTask = useActivityStore((s) => s.perTask);
  const glowTasks = useGlowTasks();
  const taskRoomTaskId = useAppStore((s) => s.taskRoomTaskId);

  const [recent, setRecent] = useState<RecentWorkspaceDto[]>([]);
  const [treeOpen, setTreeOpen] = useState(false);

  useEffect(() => {
    void rpcResult('workspace.recent', {}).then((res) => {
      if (res.ok) setRecent(res.data.items);
    });
  }, [workspace]);

  const tasks = taskStore.tasks;
  const inbox = tasks.filter(needsAttention);
  const activePerProject = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      if (RUNNING_TASK_STATES.has(t.state) || needsAttention(t)) {
        map.set(t.projectPath, (map.get(t.projectPath) ?? 0) + 1);
      }
    }
    return map;
  }, [tasks]);

  // Grouped global task list: project headers only when tasks span projects.
  const visible = tasks.filter((t) => !t.archived).slice(0, 14);
  const multiProject = new Set(visible.map((t) => t.projectPath)).size > 1;
  const groups = useMemo(() => {
    const list: Array<{ path: string; name: string; tasks: TaskDto[] }> = [];
    for (const t of visible) {
      const last = list[list.length - 1];
      if (last && last.path === t.projectPath) last.tasks.push(t);
      else list.push({ path: t.projectPath, name: t.projectName, tasks: [t] });
    }
    return list;
  }, [visible]);

  const openTask = (t: TaskDto): void => {
    void taskStore.openTask(t.id);
    app.openTaskRoom(t.id);
  };

  const taskRow = (t: TaskDto): React.JSX.Element => {
    const running = RUNNING_TASK_STATES.has(t.state);
    const ticker = running ? tickerLine(perTask[t.id]) : null;
    const meta = presentedMeta(t);
    const attention = needsAttention(t) || isAnswered(t);
    return (
      <div key={t.id} className="hm-trww">
        <button
          className={`hm-trow ${taskRoomTaskId === t.id ? 'sel' : ''} ${glowTasks.has(t.id) ? 'glow-pulse' : ''}`}
          data-testid={`home-task-${t.id}`}
          data-state={t.state}
          title={`${t.title} — ${meta.label}`}
          onClick={() => openTask(t)}
        >
          <span className="hm-trow-l1">
            <span className={`hm-dot ${dotClass(t)}`} />
            <span className="hm-tt">{t.title}</span>
            {attention && !running ? (
              <span
                className={`hm-stchip mini ${meta.tone === 'ok' ? 'ok' : meta.tone === 'err' ? 'err' : 'warn'}`}
              >
                {meta.short}
              </span>
            ) : null}
          </span>
          {ticker ? (
            <span className="hm-trow-l2" data-testid={`home-task-ticker-${t.id}`}>
              <Ic name={ticker.icon} size={10} />
              <span className="hm-ticker-text">{ticker.text}</span>
            </span>
          ) : null}
        </button>
        {canArchiveTask(t) ? (
          <ArmedIconButton
            icon="archive"
            className="hm-archx"
            testid={`home-archive-${t.id}`}
            title={isAnswered(t) ? 'Close out and archive' : 'Archive task'}
            armedTitle="Click again to archive"
            onConfirm={() => void taskStore.archiveTask(t.id)}
          />
        ) : null}
      </div>
    );
  };

  return (
    <aside className="hm-side" data-testid="home-sidebar">
      <div className="hm-side-drag" />
      <div className="hm-brand">
        <Ic name="flag" size={17} />
        <b>Charter</b>
        <span className="hm-sp" />
      </div>

      <button
        className="hm-nav-item"
        data-testid="home-new-task"
        title="Start a new task from the composer"
        onClick={() => {
          app.closeTaskRoom();
          app.focusComposer();
        }}
      >
        <Ic name="pencil" />
        <span>New task</span>
        <span className="hm-kbd">⌘N</span>
      </button>
      <button
        className="hm-nav-item"
        data-testid="home-reviews"
        title="Jump to the next task waiting on you"
        onClick={() => {
          const next = inbox[0];
          if (next) openTask(next);
          else app.pushToast('info', 'Nothing needs you right now.');
        }}
      >
        <Ic name="inbox" />
        <span>Inbox</span>
        {inbox.length > 0 ? <span className="hm-badge">{inbox.length}</span> : null}
      </button>

      <div className="hm-sec">Projects</div>
      {recent.slice(0, 6).map((r) => {
        const active = workspace?.path === r.path;
        const busy = activePerProject.get(r.path) ?? 0;
        return (
          <React.Fragment key={r.path}>
            <button
              className={`hm-row ${active ? 'active' : ''}`}
              data-testid={`home-recent-${r.path}`}
              title={active ? `${r.path} — click to browse files` : r.path}
              onClick={() => {
                if (active) {
                  setTreeOpen(!treeOpen);
                  return;
                }
                setTreeOpen(false);
                app.setHomePick(true);
                void workspaceStore.openPath(r.path);
              }}
            >
              <Ic name="folder" />
              <span className="hm-tt">{r.displayName}</span>
              {busy > 0 ? (
                <span className="hm-projbadge" title={`${busy} active task(s)`}>
                  {busy}
                </span>
              ) : null}
              {active ? (
                <span className={`hm-check hm-caret ${treeOpen ? 'open' : ''}`}>
                  <Ic name="chevron" size={13} strokeWidth={2} />
                </span>
              ) : null}
            </button>
            {active && treeOpen ? <HomeProjectTree /> : null}
          </React.Fragment>
        );
      })}
      <button
        className="hm-row"
        data-testid="home-open-folder"
        title="Open an existing folder as a project"
        onClick={() => {
          app.setHomePick(true);
          void workspaceStore.openViaDialog();
        }}
      >
        <Ic name="folder" />
        <span className="hm-tt" style={{ color: 'var(--fg-muted)' }}>
          Open folder…
        </span>
      </button>
      <button
        className="hm-row"
        data-testid="home-new-project"
        title="Create an empty project or clone a repository"
        onClick={() => app.setNewProjectOpen(true)}
      >
        <Ic name="plus" />
        <span className="hm-tt" style={{ color: 'var(--fg-muted)' }}>
          New project…
        </span>
      </button>

      {groups.length > 0 ? <div className="hm-sec">Tasks</div> : null}
      {groups.map((g, i) => (
        <React.Fragment key={`${g.path}-${i}`}>
          {multiProject ? (
            <div className="hm-taskgroup" title={g.path}>
              {g.name}
            </div>
          ) : null}
          {g.tasks.map(taskRow)}
        </React.Fragment>
      ))}

      <div className="hm-grow" />
      <div className="hm-side-bottom">
        <button
          className="hm-row"
          data-testid="home-open-ide"
          title="Open the full editor (file tree, terminal, git)"
          onClick={() => app.setSurface('workspace')}
        >
          <Ic name="layout" size={15} />
          <span>Editor</span>
          <span className="hm-kbd">⌘E</span>
        </button>
        <button
          className="hm-row"
          data-testid="home-settings"
          onClick={() => app.setOverlay('settings')}
        >
          <Ic name="sliders" size={15} />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}
