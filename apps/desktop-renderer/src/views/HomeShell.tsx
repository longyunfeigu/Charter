import React, { useEffect } from 'react';
import { useAppStore } from '../store/appStore.js';
import { useTaskStore, RUNNING_TASK_STATES } from '../store/taskStore.js';
import { useActivityStore } from '../store/activityStore.js';
import { HomeSidebar, needsAttention } from './HomeSidebar.js';
import { HomeView } from './HomeView.js';
import { TaskRoomView } from './TaskRoomView.js';
import { FileLens } from './FileLens.js';
import '../styles/home.css';
import '../styles/room.css';

/**
 * Persistent shell (ADR-0009, PIVOT-028): the sidebar is the app's skeleton —
 * it never unmounts. The content area swaps between the Launcher (composer +
 * mission control) and a Task Room. Being inside a room no longer costs you
 * the global picture: other tasks' heartbeats stay one glance away.
 */
export function HomeShell(): React.JSX.Element {
  const taskRoomTaskId = useAppStore((s) => s.taskRoomTaskId);
  const lens = useAppStore((s) => s.lens);
  const setLens = useAppStore((s) => s.setLens);
  const taskStore = useTaskStore();
  const hydrate = useActivityStore((s) => s.hydrate);

  useEffect(() => {
    taskStore.init();
    useActivityStore.getState().init();
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

  return (
    <div className="hm-root" data-testid="home-shell">
      <HomeSidebar />
      <div className="hm-content">{taskRoomTaskId ? <TaskRoomView /> : <HomeView />}</div>
      {lens ? (
        <FileLens taskId={lens.taskId} path={lens.path} onClose={() => setLens(null)} />
      ) : null}
    </div>
  );
}
