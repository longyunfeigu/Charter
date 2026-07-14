import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';

/**
 * Open the Editor carrying a task's context (ADR-0009/0014, PIVOT-006r):
 * agent panel visible, the task's project focused (switching when the room
 * belongs to a non-focused project). Used by the room header button and the
 * room-aware ⌘E toggle.
 */
export function openTaskInEditor(task: { projectPath: string }): void {
  const app = useAppStore.getState();
  const workspaceStore = useWorkspaceStore.getState();
  const go = (): void => {
    app.setLayout({ agentPanelVisible: true });
    app.setSurface('workspace');
  };
  if (workspaceStore.workspace?.path !== task.projectPath) {
    app.setHomePick(true);
    void workspaceStore.openPath(task.projectPath).then(go);
  } else {
    go();
  }
}
