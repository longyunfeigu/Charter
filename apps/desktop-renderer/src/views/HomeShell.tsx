import React, { useEffect } from 'react';
import { useAppStore } from '../store/appStore.js';
import { useTaskStore, RUNNING_TASK_STATES } from '../store/taskStore.js';
import { useActivityStore } from '../store/activityStore.js';
import { needsAttention } from './labels.js';
import { useExternalStore } from '../store/externalStore.js';
import { HomeView } from './HomeView.js';
import { TaskRoomView } from './TaskRoomView.js';
import { SessionTerminalView } from './SessionTerminalView.js';
import { ProjectToolView } from './ProjectToolView.js';
import { ArchaeologyView } from './ArchaeologyView.js';
import { useTerminalStore } from './TerminalPanel.js';
import { FileLens } from './FileLens.js';
import { NewProjectDialog } from './NewProjectDialog.js';
import '../styles/home.css';
import '../styles/room.css';
import '../styles/context-refs.css';
import '../styles/session-workbench.css';
import '../styles/session-canvas.css';

/**
 * Persistent Session shell: the rail is the app's skeleton and never unmounts.
 * The content area swaps between the shared Composer, a managed Session Canvas
 * and a native-agent terminal without creating another application frame.
 */
export function HomeShell(): React.JSX.Element {
  const taskRoomTaskId = useAppStore((s) => s.taskRoomTaskId);
  const sessionTerminalId = useAppStore((s) => s.sessionTerminalId);
  const projectTool = useAppStore((s) => s.projectTool);
  const archaeology = useAppStore((s) => s.archaeology);
  const lens = useAppStore((s) => s.lens);
  const setLens = useAppStore((s) => s.setLens);
  const newProjectOpen = useAppStore((s) => s.newProjectOpen);
  const setNewProjectOpen = useAppStore((s) => s.setNewProjectOpen);
  const taskStore = useTaskStore();
  const taskByTerminal = useExternalStore((s) => s.taskByTerminal);
  const selectedTerminal = useTerminalStore((s) =>
    sessionTerminalId ? s.items.find((item) => item.id === sessionTerminalId) : undefined,
  );
  const hydrate = useActivityStore((s) => s.hydrate);

  useEffect(() => {
    taskStore.init();
    useActivityStore.getState().init();
    // ADR-0017: external session toasts/badges/glow work from any surface.
    useExternalStore.getState().init();
    void taskStore.refreshTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Heartbeat hydration: live/attention tasks get their activity backfilled so
  // the sidebar ticker and mission-control cards are truthful after reloads.
  useEffect(() => {
    for (const t of taskStore.tasks) {
      if (RUNNING_TASK_STATES.has(t.state) || needsAttention(t)) {
        void hydrate(t.id);
      }
    }
  }, [taskStore.tasks, hydrate]);

  // A freshly launched Claude/Codex PTY is selectable immediately. When the
  // host detects the agent and creates its accounting task, migrate the active
  // selection to the richer Task Room without recreating or moving the PTY.
  useEffect(() => {
    if (!sessionTerminalId) return;
    // A plain shell may later launch several external agents and remains the
    // user's Terminal Session manager. Composer-launched Claude/Codex sessions
    // can migrate directly into their richer evidence room.
    if (selectedTerminal?.launch === 'shell') return;
    const detectedTaskId = taskByTerminal[sessionTerminalId];
    if (!detectedTaskId || !taskStore.tasks.some((task) => task.id === detectedTaskId)) return;
    void taskStore.openTask(detectedTaskId);
    useAppStore.getState().openTaskRoom(detectedTaskId);
  }, [sessionTerminalId, selectedTerminal?.launch, taskByTerminal, taskStore]);

  return (
    <div className="hm-root" data-testid="home-shell">
      <div className="hm-content">
        {sessionTerminalId ? (
          <SessionTerminalView key={sessionTerminalId} terminalId={sessionTerminalId} />
        ) : taskRoomTaskId ? (
          <TaskRoomView key={taskRoomTaskId} />
        ) : archaeology ? (
          <ArchaeologyView />
        ) : projectTool ? (
          <ProjectToolView tool={projectTool} />
        ) : (
          <HomeView />
        )}
      </div>
      {lens ? (
        <FileLens taskId={lens.taskId} path={lens.path} onClose={() => setLens(null)} />
      ) : null}
      {newProjectOpen ? <NewProjectDialog onClose={() => setNewProjectOpen(false)} /> : null}
    </div>
  );
}
