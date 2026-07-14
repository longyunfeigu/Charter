import React from 'react';
import { useAppStore } from '../store/appStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';

/**
 * Open a workspace-relative file reference (PIVOT-015/015r). While a Task Room
 * of the focused project is open (and nothing renders above it), a plain
 * activation peeks in place — the conversation is the anchor (ADR-0014).
 * ⌘/alt-click, any other surface, or launcher context goes to the Editor.
 */
export function openWorkspaceFile(
  path: string,
  e?: { metaKey?: boolean; altKey?: boolean; ctrlKey?: boolean },
): void {
  const app = useAppStore.getState();
  const explicit = e?.metaKey === true || e?.altKey === true || e?.ctrlKey === true;
  if (!explicit && app.surface === 'home' && app.taskRoomTaskId) {
    const tasks = useTaskStore.getState();
    const task = tasks.tasks.find((t) => t.id === app.taskRoomTaskId);
    const focused = useWorkspaceStore.getState().workspace?.path;
    const overlayAbove = tasks.reviewOpen || tasks.replayOpen || app.lens !== null;
    // Peek reads through the task's mount — only route there when the file
    // reference actually belongs to that project.
    if (task && !overlayAbove && task.projectPath === focused) {
      app.openPeek(task.id, path, 'file');
      return;
    }
  }
  app.setSurface('workspace');
  void useEditorStore.getState().openFile(path);
}

/** Clickable mono chips for workspace-relative paths in timeline/report cards. */
export function PathChips(props: {
  paths: string[];
  testidPrefix?: string;
}): React.JSX.Element | null {
  if (props.paths.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
      {props.paths.slice(0, 8).map((path) => (
        <button
          key={path}
          className="mono"
          data-testid={`${props.testidPrefix ?? 'path-link'}-${path}`}
          title={`Open ${path}`}
          onClick={(e) => {
            e.stopPropagation();
            openWorkspaceFile(path, e);
          }}
          style={{
            fontSize: 10.5,
            border: '1px solid var(--border)',
            background: 'var(--bg-hover)',
            color: 'var(--fg)',
            borderRadius: 5,
            padding: '1px 6px',
            cursor: 'pointer',
            maxWidth: 260,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {path}
        </button>
      ))}
    </div>
  );
}
