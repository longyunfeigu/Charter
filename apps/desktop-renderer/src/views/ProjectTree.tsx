import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import type { DirEntryDto } from '@pi-ide/ipc-contracts';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { useAppStore } from '../store/appStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { useGitStatusStore, MARK_COLOR } from '../store/gitStatusStore.js';
import { rpcResult } from '../bridge.js';
import { useGlowPaths } from './useGlow.js';
import { Ic } from './home-icons.js';
import { setDragRef } from './dragRefs.js';

interface Row {
  path: string;
  name: string;
  depth: number;
  kind: DirEntryDto['kind'];
  ignored: boolean;
  expanded: boolean;
}

const ROW_HEIGHT = 24;

function buildRows(
  dirs: Record<string, DirEntryDto[] | undefined>,
  expanded: Record<string, boolean>,
): Row[] {
  const rows: Row[] = [];
  const visit = (dir: string, depth: number) => {
    const entries = dirs[dir];
    if (!entries) return;
    for (const entry of entries) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      const isDir = entry.kind === 'dir' || entry.kind === 'symlink';
      const isExpanded = Boolean(expanded[path]);
      rows.push({
        path,
        name: entry.name,
        depth,
        kind: entry.kind,
        ignored: entry.ignored,
        expanded: isExpanded,
      });
      if (isDir && isExpanded) visit(path, depth + 1);
    }
  };
  visit('', 0);
  return rows;
}

interface EditingState {
  kind: 'create-file' | 'create-dir' | 'rename';
  parentDir: string;
  path?: string;
  initial: string;
}

export interface ProjectTreeHandle {
  /** Start an inline create at the workspace root (the pane's "+" button). */
  startCreate(kind: 'file' | 'dir'): void;
}

/**
 * ADR-0029: the one project tree. Lives in the rail's Files pane and carries
 * both roles that used to be split across two trees — context feeding for the
 * open room (drag, hover "+", click-to-peek: ADR-0024/PIVOT-027r) and file
 * management (context menu, inline create/rename, git marks, virtualization)
 * from the retired Files tool column.
 */
export const ProjectTree = forwardRef<ProjectTreeHandle, { onQuickAdd?: (rel: string) => void }>(
  function ProjectTree(props, ref): React.JSX.Element | null {
    const workspace = useWorkspaceStore((s) => s.workspace);
    const dirs = useWorkspaceStore((s) => s.dirs);
    const expanded = useWorkspaceStore((s) => s.expanded);
    const toggleExpand = useWorkspaceStore((s) => s.toggleExpand);
    const loadDir = useWorkspaceStore((s) => s.loadDir);
    const selection = useWorkspaceStore((s) => s.selection);
    const setSelection = useWorkspaceStore((s) => s.setSelection);
    const openFile = useEditorStore((s) => s.openFile);
    const pushToast = useAppStore((s) => s.pushToast);
    // PIVOT-016: agent writes make the touched rows glow while the change is fresh.
    const glowPaths = useGlowPaths();
    // ADR-0013: git status decorations (A/M/D letters, ±line counts, dirty-folder dots).
    const gitMarks = useGitStatusStore((s) => s.byPath);
    const gitStats = useGitStatusStore((s) => s.statByPath);
    const gitDirty = useGitStatusStore((s) => s.dirty);

    const [scrollTop, setScrollTop] = useState(0);
    const [viewportH, setViewportH] = useState(600);
    const [menu, setMenu] = useState<{ x: number; y: number; row: Row | null } | null>(null);
    const [editing, setEditing] = useState<EditingState | null>(null);

    const rows = useMemo(() => buildRows(dirs, expanded), [dirs, expanded]);

    // Root loads on mount (the pane can mount after the workspace event).
    useEffect(() => {
      if (dirs[''] === undefined) void loadDir('');
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(ref, () => ({
      startCreate(kind) {
        setEditing({
          kind: kind === 'dir' ? 'create-dir' : 'create-file',
          parentDir: '',
          initial: '',
        });
      },
    }));

    if (!workspace) return null;

    const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 10);
    const last = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + 10);
    const visible = rows.slice(first, last);

    // PIVOT-027r (ADR-0014): while a room of THIS project is open, a plain
    // click peeks beside the conversation; ⌘/alt-click keeps the Editor jump.
    const openFromTree = (path: string, e?: React.MouseEvent | React.KeyboardEvent): void => {
      const explicit = e ? e.metaKey || e.altKey || e.ctrlKey : false;
      const app = useAppStore.getState();
      if (!explicit && app.taskRoomTaskId) {
        const task = useTaskStore.getState().tasks.find((t) => t.id === app.taskRoomTaskId);
        if (task && task.projectPath === workspace.path) {
          app.openPeek(task.id, path, 'file');
          return;
        }
      }
      void openFile(path);
      app.closeTaskRoom();
      app.setProjectTool('editor');
    };

    const activateRow = (row: Row, e?: React.MouseEvent | React.KeyboardEvent): void => {
      setSelection(row.path);
      if (row.kind === 'dir' || row.kind === 'symlink') toggleExpand(row.path);
      else openFromTree(row.path, e);
    };

    const submitEditing = async (value: string) => {
      if (!editing || value.trim() === '') {
        setEditing(null);
        return;
      }
      if (editing.kind === 'rename' && editing.path) {
        const res = await rpcResult('fs.rename', { path: editing.path, newName: value.trim() });
        if (!res.ok) pushToast('error', res.error.userMessage);
      } else {
        const res = await rpcResult('fs.create', {
          parentDir: editing.parentDir,
          name: value.trim(),
          kind: editing.kind === 'create-dir' ? 'dir' : 'file',
        });
        if (!res.ok) pushToast('error', res.error.userMessage);
        else if (editing.kind === 'create-file') {
          openFromTree(res.data.path);
        }
      }
      setEditing(null);
      void loadDir(editing.parentDir);
    };

    const menuItems = (row: Row | null) => {
      const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
      const targetDir = row ? (row.kind === 'dir' ? row.path : parentOf(row.path)) : '';
      return [
        {
          label: 'New File…',
          run: () => setEditing({ kind: 'create-file', parentDir: targetDir, initial: '' }),
        },
        {
          label: 'New Folder…',
          run: () => setEditing({ kind: 'create-dir', parentDir: targetDir, initial: '' }),
        },
        ...(row && row.kind === 'file' && /\.html?$/i.test(row.name)
          ? [
              {
                label: 'Open in Browser',
                run: async () => {
                  const res = await rpcResult('fs.openInBrowser', { path: row.path });
                  if (!res.ok) pushToast('error', res.error.userMessage);
                },
              },
            ]
          : []),
        ...(row
          ? [
              {
                label: 'Rename…',
                run: () =>
                  setEditing({
                    kind: 'rename' as const,
                    parentDir: parentOf(row.path),
                    path: row.path,
                    initial: row.name,
                  }),
              },
              {
                label: 'Delete (move to Trash)',
                run: async () => {
                  const res = await rpcResult('fs.trash', { path: row.path });
                  if (!res.ok) pushToast('error', res.error.userMessage);
                },
              },
              {
                label: 'Copy Relative Path',
                run: () => void navigator.clipboard.writeText(row.path),
              },
              {
                label: 'Copy Absolute Path',
                run: () => void navigator.clipboard.writeText(`${workspace.path}/${row.path}`),
              },
            ]
          : []),
      ];
    };

    return (
      <div
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        data-testid="explorer"
      >
        {editing && editing.parentDir === '' && editing.kind !== 'rename' ? (
          <InlineInput
            editing={editing}
            onSubmit={submitEditing}
            onCancel={() => setEditing(null)}
            depth={0}
          />
        ) : null}
        <div
          style={{ flex: 1, overflow: 'auto', position: 'relative' }}
          onScroll={(e) => {
            setScrollTop(e.currentTarget.scrollTop);
            setViewportH(e.currentTarget.clientHeight);
          }}
          onContextMenu={(e) => {
            if (e.target === e.currentTarget) {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, row: null });
            }
          }}
          role="tree"
          aria-label="Files"
        >
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            {visible.map((row, i) => {
              const index = first + i;
              const isDir = row.kind === 'dir' || row.kind === 'symlink';
              const relPayload = isDir ? `${row.path}/` : row.path;
              const mark = isDir ? undefined : gitMarks[row.path];
              // Counts accompany modified/renamed letters only — a new file is
              // just "A"; binary and untracked files have no stats to show.
              const stat = mark === 'M' || mark === 'R' ? gitStats[row.path] : undefined;
              return (
                <React.Fragment key={row.path}>
                  <div
                    role="treeitem"
                    aria-expanded={isDir ? row.expanded : undefined}
                    aria-selected={selection === row.path}
                    tabIndex={0}
                    data-testid={`tree-item-${row.path}`}
                    className={`pt-row ${selection === row.path ? 'selected' : ''} ${glowPaths.has(row.path) ? 'glow-pulse' : ''}`}
                    title={row.path}
                    draggable
                    onDragStart={(e) => setDragRef(e, relPayload)}
                    onClick={(e) => activateRow(row, e)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        activateRow(row, e);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelection(row.path);
                      setMenu({ x: e.clientX, y: e.clientY, row });
                    }}
                    style={{
                      position: 'absolute',
                      top: index * ROW_HEIGHT,
                      left: 0,
                      right: 0,
                      height: ROW_HEIGHT,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      paddingLeft: 8 + row.depth * 14,
                      paddingRight: 4,
                      cursor: 'pointer',
                      fontSize: 12.5,
                      whiteSpace: 'nowrap',
                      color: row.ignored ? 'var(--fg-faint)' : undefined,
                    }}
                  >
                    <span style={{ width: 12, textAlign: 'center', flex: 'none' }} aria-hidden>
                      {isDir ? (row.expanded ? '▾' : '▸') : ''}
                    </span>
                    <span aria-hidden style={{ color: 'var(--fg-muted)', display: 'flex' }}>
                      <Ic name={isDir ? 'folder' : 'file'} size={13} />
                    </span>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        flex: 1,
                        minWidth: 0,
                        color: mark ? MARK_COLOR[mark] : undefined,
                      }}
                    >
                      {row.name}
                    </span>
                    {stat ? (
                      <span
                        className="mono"
                        data-testid={`tree-diff-${row.path}`}
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          fontVariantNumeric: 'tabular-nums',
                          flex: 'none',
                        }}
                      >
                        <span style={{ color: 'var(--success)' }}>+{stat.insertions}</span>
                        <span style={{ color: 'var(--danger)', marginLeft: 4 }}>
                          −{stat.deletions}
                        </span>
                      </span>
                    ) : null}
                    {mark ? (
                      <span
                        className="mono"
                        data-testid={`tree-git-${row.path}`}
                        style={{
                          color: MARK_COLOR[mark],
                          fontSize: 10,
                          fontWeight: 700,
                          flex: 'none',
                        }}
                      >
                        {mark}
                      </span>
                    ) : isDir && gitDirty[row.path] ? (
                      <span
                        aria-hidden
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          background: 'var(--warning)',
                          marginRight: 2,
                          opacity: 0.8,
                          flex: 'none',
                        }}
                      />
                    ) : null}
                    {props.onQuickAdd ? (
                      <button
                        type="button"
                        className="pt-add"
                        aria-label={`Attach ${row.path} to the conversation`}
                        data-testid={`tree-add-${row.path}`}
                        title="Attach to the conversation"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onQuickAdd?.(relPayload);
                        }}
                      >
                        <Ic name="plus" size={11} />
                      </button>
                    ) : null}
                  </div>
                  {editing &&
                  editing.kind !== 'rename' &&
                  editing.parentDir === row.path &&
                  row.expanded ? (
                    <div
                      style={{
                        position: 'absolute',
                        top: (index + 1) * ROW_HEIGHT,
                        left: 0,
                        right: 0,
                      }}
                    >
                      <InlineInput
                        editing={editing}
                        onSubmit={submitEditing}
                        onCancel={() => setEditing(null)}
                        depth={row.depth + 1}
                      />
                    </div>
                  ) : null}
                  {editing && editing.kind === 'rename' && editing.path === row.path ? (
                    <div
                      style={{
                        position: 'absolute',
                        top: index * ROW_HEIGHT,
                        left: 0,
                        right: 0,
                        zIndex: 2,
                      }}
                    >
                      <InlineInput
                        editing={editing}
                        onSubmit={submitEditing}
                        onCancel={() => setEditing(null)}
                        depth={row.depth}
                      />
                    </div>
                  ) : null}
                </React.Fragment>
              );
            })}
          </div>
          {rows.length === 0 ? (
            <div className="empty-state">
              <div>This folder is empty.</div>
            </div>
          ) : null}
        </div>
        {menu ? (
          <>
            <div
              className="overlay-backdrop"
              onClick={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu(null);
              }}
            />
            <div
              className="quickpick"
              style={{ top: menu.y, left: menu.x, transform: 'none', width: 240 }}
              role="menu"
            >
              {menuItems(menu.row).map((item) => (
                <button
                  key={item.label}
                  className="quickpick-item"
                  role="menuitem"
                  onClick={() => {
                    void item.run();
                    setMenu(null);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    );
  },
);

function InlineInput(props: {
  editing: EditingState;
  depth: number;
  onSubmit(value: string): void;
  onCancel(): void;
}): React.JSX.Element {
  const [value, setValue] = useState(props.editing.initial);
  return (
    <input
      autoFocus
      data-testid="explorer-inline-input"
      value={value}
      placeholder={props.editing.kind === 'create-dir' ? 'folder name' : 'file name'}
      style={{
        marginLeft: 8 + props.depth * 14,
        width: `calc(100% - ${24 + props.depth * 14}px)`,
        background: 'var(--bg-input)',
        border: '1px solid var(--accent)',
        borderRadius: 3,
        padding: '2px 6px',
      }}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') props.onSubmit(value);
        if (e.key === 'Escape') props.onCancel();
      }}
      onBlur={() => props.onCancel()}
    />
  );
}
