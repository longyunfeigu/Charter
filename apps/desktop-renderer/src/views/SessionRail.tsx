import React, { useEffect, useMemo, useState } from 'react';
import type { RecentWorkspaceDto, TaskDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useActivityStore, currentActionLine } from '../store/activityStore.js';
import { useAppStore } from '../store/appStore.js';
import { useExternalStore } from '../store/externalStore.js';
import { RUNNING_TASK_STATES, useTaskStore } from '../store/taskStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useTerminalStore, type TerminalLaunch } from './TerminalPanel.js';
import { HomeProjectTree } from './HomeProjectTree.js';
import { Ic } from './home-icons.js';
import { canArchiveTask, isAnswered, presentedMeta } from './labels.js';
import { ArmedIconButton } from './ui.js';
import { needsAttention } from './HomeSidebar.js';
import { useGlowTasks } from './useGlow.js';

type SessionEntry =
  | { key: string; kind: 'task'; task: TaskDto }
  | { key: string; kind: 'terminal'; terminalId: string; launch: 'claude' | 'codex' };

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

function sessionTitle(task: TaskDto, provider: 'pi' | 'claude' | 'codex'): string {
  const withoutFixtureDirective = task.title.replace(/^\[scenario:[^\]]+\]\s*/i, '');
  const withoutRepeatedProvider = withoutFixtureDirective.replace(
    /^(?:claude(?: code)?|codex|pi)\s*[·:—-]\s*/i,
    '',
  );
  return `${providerLabel(provider)} · ${withoutRepeatedProvider || 'Session'}`;
}

function ProviderMark({ provider }: { provider: 'pi' | 'claude' | 'codex' }): React.JSX.Element {
  return (
    <span className={`sr-provider ${provider}`} aria-hidden>
      {provider === 'pi' ? 'Pi' : provider === 'claude' ? 'CC' : 'CX'}
    </span>
  );
}

function SessionTaskRow({ task }: { task: TaskDto }): React.JSX.Element {
  const app = useAppStore();
  const taskStore = useTaskStore();
  const activity = useActivityStore((state) => state.perTask[task.id]);
  const glowTasks = useGlowTasks();
  const selected = app.taskRoomTaskId === task.id;
  const provider = providerForTask(task);
  const displayTitle = sessionTitle(task, provider);
  const running = RUNNING_TASK_STATES.has(task.state);
  const meta = presentedMeta(task);
  const action = running ? currentActionLine(activity) : null;
  const externalSession = useExternalStore((state) => state.sessions[task.id]);
  const live = task.external ? externalSession?.status === 'active' : running;

  const open = (): void => {
    void taskStore.openTask(task.id);
    app.openTaskRoom(task.id);
  };

  return (
    <div className="sr-row-wrap">
      <button
        className={`sr-session ${selected ? 'selected' : ''} ${glowTasks.has(task.id) ? 'glow-pulse' : ''}`}
        data-testid={`home-task-${task.id}`}
        data-session-key={`task:${task.id}`}
        data-state={task.state}
        title={`${displayTitle} — ${meta.label}`}
        onClick={open}
      >
        <ProviderMark provider={provider} />
        <span className="sr-session-copy">
          <span className="sr-session-title">
            <span className={`sr-live-dot ${live ? 'live' : ''}`} />
            <b>{displayTitle}</b>
            <span className={`sr-state ${meta.tone}`}>{live ? 'LIVE' : meta.short}</span>
          </span>
          <span className="sr-session-meta">
            <span className="sr-session-project">{task.projectName}</span>
            <span className="sr-session-branch">
              <Ic name="branch" size={10} />
              {task.worktree?.branch ?? 'main'}
            </span>
          </span>
          <span className="sr-session-detail">
            {action?.label ?? (isAnswered(task) ? 'Answered · no file changes' : meta.label)}
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
          onConfirm={() => void taskStore.archiveTask(task.id)}
        />
      ) : null}
    </div>
  );
}

function TerminalSessionRow({
  terminalId,
  launch,
}: {
  terminalId: string;
  launch: 'claude' | 'codex';
}): React.JSX.Element | null {
  const app = useAppStore();
  const item = useTerminalStore((state) => state.items.find((entry) => entry.id === terminalId));
  if (!item) return null;
  const selected = app.sessionTerminalId === terminalId;
  const provider = launch;
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
          <b>
            {providerLabel(provider)} · {sessionName}
          </b>
          <span className="sr-state run">{item.exited ? 'ENDED' : 'LIVE'}</span>
        </span>
        <span className="sr-session-meta">
          <span className="sr-session-project">{item.projectName}</span>
          <span className="sr-session-branch">
            <Ic name="branch" size={10} /> main
          </span>
        </span>
        <span className="sr-session-detail">
          {item.exited
            ? 'Process ended · session state retained'
            : 'PTY starting · state preserved'}
        </span>
      </span>
    </button>
  );
}

function NewSessionDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const workspace = useWorkspaceStore((state) => state.workspace);
  const app = useAppStore();
  const [kind, setKind] = useState<'pi' | 'claude' | 'codex'>('pi');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const create = async (): Promise<void> => {
    if (kind === 'pi') {
      app.closeTaskRoom();
      app.setSurface('home');
      app.focusComposer();
      onClose();
      return;
    }
    setCreating(true);
    try {
      const id = await useTerminalStore.getState().create({
        launch: kind as TerminalLaunch,
        context: workspace ? { kind: 'focused' } : { kind: 'scratch' },
        title: kind === 'claude' ? 'Claude Code' : 'Codex',
        reveal: false,
      });
      if (id) {
        app.openTerminalSession(id);
        onClose();
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="sr-modal-backdrop"
      data-testid="session-create-dialog"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="sr-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sr-modal-title"
      >
        <header>
          <div>
            <h2 id="sr-modal-title">New Session</h2>
            <p>
              Choose how this working session should execute. Files, process state and review stay
              attached to it.
            </p>
          </div>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <Ic name="x" size={14} />
          </button>
        </header>
        <div className="sr-kind-grid">
          {(
            [
              ['pi', 'Pi Session', 'Managed multi-run task with plans, tools, review and steer.'],
              [
                'claude',
                'Claude Code',
                'A preserved external PTY with Claude’s native interactive surface.',
              ],
              [
                'codex',
                'Codex',
                'A preserved external PTY for implementation or independent review.',
              ],
            ] as const
          ).map(([value, title, detail]) => (
            <button
              key={value}
              className={kind === value ? 'selected' : ''}
              data-testid={`session-kind-${value}`}
              onClick={() => setKind(value)}
            >
              <ProviderMark provider={value} />
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="sr-context">
          <span>Working context</span>
          <strong>{workspace?.displayName ?? 'Scratch session'}</strong>
          <small>{workspace?.path ?? 'A temporary host-resolved directory'}</small>
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="session-create-submit"
            disabled={creating}
            onClick={() => void create()}
          >
            {creating
              ? 'Creating…'
              : `Create ${kind === 'pi' ? 'Pi Session' : kind === 'claude' ? 'Claude Session' : 'Codex Session'}`}
          </button>
        </footer>
      </section>
    </div>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest('input, textarea, [contenteditable="true"], .xterm-helper-textarea'),
  );
}

export function SessionRail(): React.JSX.Element {
  const app = useAppStore();
  const workspaceStore = useWorkspaceStore();
  const taskStore = useTaskStore();
  const terminalStore = useTerminalStore();
  const taskByTerminal = useExternalStore((state) => state.taskByTerminal);
  const inbox = taskStore.tasks.filter(needsAttention);
  const [recent, setRecent] = useState<RecentWorkspaceDto[]>([]);
  const [treeOpen, setTreeOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    taskStore.init();
    void taskStore.refreshTasks();
    terminalStore.init();
    useExternalStore.getState().init();
    void rpcResult('workspace.recent', {}).then((result) => {
      if (result.ok) setRecent(result.data.items);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceStore.workspace?.path]);

  const entries = useMemo<SessionEntry[]>(() => {
    const taskEntries: SessionEntry[] = taskStore.tasks
      .filter((task) => !task.archived)
      .slice(0, 20)
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
      }));
    return [...terminalEntries.toReversed(), ...taskEntries];
  }, [taskStore.tasks, terminalStore.items, taskByTerminal]);

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
        const current = entries.findIndex((entry) => entry.key === currentKey);
        index =
          event.key === '['
            ? current <= 0
              ? entries.length - 1
              : current - 1
            : current < 0 || current >= entries.length - 1
              ? 0
              : current + 1;
      }
      const entry = entries[index];
      if (!entry) return;
      event.preventDefault();
      if (entry.kind === 'task') {
        void taskStore.openTask(entry.task.id);
        app.openTaskRoom(entry.task.id);
      } else {
        app.openTerminalSession(entry.terminalId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app, entries, taskStore]);

  return (
    <>
      <aside className="sr-rail" data-testid="home-sidebar" aria-label="Sessions">
        <div className="sr-head">
          <strong>Sessions</strong>
          <span className="sr-shortcuts">⌘[ ⌘]</span>
          <div className="sr-new-wrap">
            <button
              className="sr-new"
              data-testid="home-new-task"
              title="Start from the task composer"
              onClick={() => {
                app.closeTaskRoom();
                app.setSurface('home');
                app.focusComposer();
              }}
            >
              <Ic name="plus" size={13} /> New Session
            </button>
            <button
              className="sr-new-menu"
              data-testid="session-new-menu"
              aria-label="Choose session type"
              title="Choose Pi, Claude or Codex"
              onClick={() => setDialogOpen(true)}
            >
              <Ic name="chevron" size={12} />
            </button>
          </div>
        </div>

        <div className="sr-scroll">
          {entries.length === 0 ? (
            <div className="sr-empty">No sessions yet. Start with Pi, Claude or Codex.</div>
          ) : (
            entries.map((entry) =>
              entry.kind === 'task' ? (
                <SessionTaskRow key={entry.key} task={entry.task} />
              ) : (
                <TerminalSessionRow
                  key={entry.key}
                  terminalId={entry.terminalId}
                  launch={entry.launch}
                />
              ),
            )
          )}

          <div className="sr-section-title">Project</div>
          {recent.slice(0, 5).map((project) => {
            const active = workspaceStore.workspace?.path === project.path;
            return (
              <React.Fragment key={project.path}>
                <button
                  className={`sr-project ${active ? 'active' : ''}`}
                  data-testid={`home-recent-${project.path}`}
                  title={project.path}
                  onClick={() => {
                    if (active) setTreeOpen(!treeOpen);
                    else {
                      app.setHomePick(true);
                      void workspaceStore.openPath(project.path);
                    }
                  }}
                >
                  <Ic name="folder" size={13} />
                  <span>{project.displayName}</span>
                  {active ? (
                    <Ic name="chevron" size={12} className={treeOpen ? 'sr-chevron-open' : ''} />
                  ) : null}
                </button>
                {active && treeOpen ? <HomeProjectTree /> : null}
              </React.Fragment>
            );
          })}
          <button
            className="sr-project muted"
            data-testid="home-open-folder"
            onClick={() => void workspaceStore.openViaDialog()}
          >
            <Ic name="folder" size={13} />
            <span>Open folder…</span>
          </button>
          <button
            className="sr-project muted"
            data-testid="home-new-project"
            onClick={() => app.setNewProjectOpen(true)}
          >
            <Ic name="plus" size={13} />
            <span>New project…</span>
          </button>
        </div>

        <div className="sr-foot">
          <button
            data-testid="home-reviews"
            onClick={() => {
              const task = inbox[0];
              if (task) {
                void taskStore.openTask(task.id);
                app.openTaskRoom(task.id);
              } else app.pushToast('info', 'Nothing needs you right now.');
            }}
          >
            <Ic name="inbox" size={14} /> Inbox
            {inbox.length > 0 ? <span>{inbox.length}</span> : null}
          </button>
          <button
            className={app.surface === 'workspace' ? 'active' : ''}
            data-testid="home-open-ide"
            title="Open the editor while the Session Rail stays visible"
            onClick={() => app.setSurface('workspace')}
          >
            <Ic name="layout" size={14} /> Workspace <kbd>⌘E</kbd>
          </button>
          <button onClick={() => app.openSettings()}>
            <Ic name="sliders" size={14} /> Settings
          </button>
        </div>
      </aside>
      {dialogOpen ? <NewSessionDialog onClose={() => setDialogOpen(false)} /> : null}
    </>
  );
}
