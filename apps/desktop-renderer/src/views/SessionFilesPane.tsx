import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SftpEntry, TaskDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { ProjectTree, type ProjectTreeHandle } from './ProjectTree.js';
import { setDragRef } from './dragRefs.js';
import { addFileRefWithToast, refFromRel } from './roomFileRefs.js';
import { Ic } from './home-icons.js';

type RemoteWorkspace = NonNullable<NonNullable<TaskDto['external']>['remote']>;

interface RemoteFileRow {
  path: string;
  name: string;
  depth: number;
  entry: SftpEntry;
  expanded: boolean;
}

function remoteFileRows(
  root: string,
  dirs: Record<string, SftpEntry[] | undefined>,
  expanded: Record<string, boolean>,
): RemoteFileRow[] {
  const rows: RemoteFileRow[] = [];
  const visit = (dir: string, depth: number): void => {
    for (const entry of dirs[dir] ?? []) {
      const path = dir.endsWith('/') ? `${dir}${entry.name}` : `${dir}/${entry.name}`;
      const open = Boolean(expanded[path]);
      rows.push({ path, name: entry.name, depth, entry, expanded: open });
      if (entry.type === 'dir' && !entry.symlink && open) visit(path, depth + 1);
    }
  };
  visit(root, 0);
  return rows;
}

/** Canonical Files surface for a server-owned workspace. It reads the actual
 * directory over SFTP; the Session's local sparse review mirror is never
 * opened as a Workspace or exposed in product copy. */
function RemoteSessionFilesPane({ remote }: { remote: RemoteWorkspace }): React.JSX.Element {
  const [dirs, setDirs] = useState<Record<string, SftpEntry[] | undefined>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(
    async (path: string): Promise<void> => {
      setLoading((current) => new Set(current).add(path));
      setError(null);
      const result = await rpcResult('ssh.sftpList', { hostId: remote.hostId, path });
      setLoading((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      if (!result.ok) {
        setError(result.error.userMessage);
        return;
      }
      setDirs((current) => ({ ...current, [result.data.path]: result.data.entries }));
    },
    [remote.hostId],
  );

  useEffect(() => {
    setDirs({});
    setExpanded({});
    setQuery('');
    void load(remote.root);
    return () => {
      void rpcResult('ssh.sftpClose', { hostId: remote.hostId });
    };
  }, [load, remote.hostId, remote.root]);

  const rows = useMemo(
    () => remoteFileRows(remote.root, dirs, expanded),
    [dirs, expanded, remote.root],
  );
  const visibleRows = query.trim()
    ? rows.filter((row) => row.path.toLowerCase().includes(query.trim().toLowerCase()))
    : rows;

  const toggle = (row: RemoteFileRow): void => {
    if (row.entry.type !== 'dir' || row.entry.symlink) return;
    const open = !expanded[row.path];
    setExpanded((current) => ({ ...current, [row.path]: open }));
    if (open && dirs[row.path] === undefined) void load(row.path);
  };

  const download = async (row: RemoteFileRow): Promise<void> => {
    if (row.entry.type === 'dir') return;
    const result = await rpcResult('ssh.sftpDownload', {
      hostId: remote.hostId,
      remotePath: row.path,
      name: row.name,
    });
    if (!result.ok) setError(result.error.userMessage);
  };

  return (
    <div className="sr-files-pane sr-remote-files" data-testid="session-remote-files-pane">
      <div className="sr-files-project" title={`${remote.hostLabel}:${remote.root}`}>
        <Ic name="server" size={13} />
        <strong>{remote.hostLabel}</strong>
        <small className="mono" data-testid="session-remote-files-root">
          {remote.root}
        </small>
        <span className="sr-remote-files-badge">SSH</span>
        <span className="sr-files-actions">
          <button
            type="button"
            className="sr-files-action"
            title="Refresh remote files"
            aria-label="Refresh remote files"
            onClick={() => {
              const paths = [
                remote.root,
                ...Object.keys(expanded).filter((path) => expanded[path]),
              ];
              for (const path of paths) void load(path);
            }}
          >
            ↺
          </button>
        </span>
      </div>
      <label className="sr-search-box sr-files-search">
        <Ic name="search" size={13} />
        <input
          data-testid="session-remote-files-search"
          value={query}
          placeholder={`Filter loaded files on ${remote.hostLabel}…`}
          aria-label="Filter loaded remote files"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div className="sr-files-scroll sr-files-tree-host">
        {error ? <div className="sr-remote-files-error">{error}</div> : null}
        {loading.has(remote.root) && dirs[remote.root] === undefined ? (
          <div className="sr-files-empty">Loading {remote.root}…</div>
        ) : null}
        <div className="hm-tree" data-testid="session-remote-files-tree">
          {visibleRows.map((row) => {
            const directory = row.entry.type === 'dir';
            return (
              <div
                key={row.path}
                className="hm-tree-row sr-remote-file-row"
                data-testid={`session-remote-file-${row.name}`}
                title={row.path}
                style={{ paddingLeft: 8 + row.depth * 14 }}
                role="button"
                tabIndex={0}
                onClick={() => (directory ? toggle(row) : undefined)}
                onDoubleClick={() => (directory ? toggle(row) : void download(row))}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  if (directory) toggle(row);
                  else void download(row);
                }}
              >
                {directory ? (
                  <span className="hm-tree-chevron">{row.expanded ? '⌄' : '›'}</span>
                ) : (
                  <span className="hm-tree-chevron" />
                )}
                <Ic name={directory ? 'folder' : 'file'} size={12} />
                <span className="hm-tree-name mono">{row.name}</span>
                {!directory ? (
                  <button
                    type="button"
                    className="sr-remote-download"
                    title={`Download ${row.name}`}
                    aria-label={`Download ${row.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void download(row);
                    }}
                  >
                    ↓
                  </button>
                ) : null}
                {loading.has(row.path) ? <span className="sr-remote-loading">…</span> : null}
              </div>
            );
          })}
        </div>
      </div>
      <p className="sr-files-tip">
        <Ic name="server" size={12} />
        Live server files via SFTP · double-click a file to download it.
      </p>
    </div>
  );
}

/**
 * ADR-0024 (mock B+D) + ADR-0029: the persistent Files pane in the session
 * rail — the one project tree. It is both the drag source for context feeding
 * and, since the Files tool column retired, the canonical file manager
 * (create/rename/delete via the tree's context menu, plus the actions here).
 * Searching routes through search.files and returns flat draggable rows.
 * The hover “+” lands a chip directly in the open room's composer.
 */
export function SessionFilesPane(): React.JSX.Element {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const showIgnored = useWorkspaceStore((s) => s.showIgnored);
  const setShowIgnored = useWorkspaceStore((s) => s.setShowIgnored);
  const refreshAll = useWorkspaceStore((s) => s.refreshAll);
  const roomTaskId = useAppStore((s) => s.taskRoomTaskId);
  const task = useTaskStore((s) => (roomTaskId ? s.tasks.find((t) => t.id === roomTaskId) : null));
  const remoteWorkspace =
    task?.external?.remote && (task.external.remote.workspaceKind ?? 'remote') === 'remote'
      ? task.external.remote
      : null;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const treeRef = useRef<ProjectTreeHandle>(null);

  const sameProject = Boolean(task && workspace && task.projectPath === workspace.path);
  const quickAddTaskId = task && sameProject && !task.external ? task.id : null;

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || !workspace || remoteWorkspace) {
      setResults([]);
      return;
    }
    const handle = setTimeout(() => {
      void rpcResult('search.files', { query: trimmed }).then((res) => {
        if (res.ok) setResults(res.data.items.slice(0, 30).map((item) => item.path));
      });
    }, 80);
    return () => clearTimeout(handle);
  }, [query, remoteWorkspace, workspace]);

  const quickAdd = quickAddTaskId
    ? (rel: string): void => {
        addFileRefWithToast(quickAddTaskId, refFromRel(rel));
      }
    : undefined;

  if (remoteWorkspace) return <RemoteSessionFilesPane remote={remoteWorkspace} />;

  if (!workspace) {
    return (
      <div className="sr-files-empty" data-testid="session-files-empty">
        <p>Pick a project to browse its files.</p>
        <button
          className="btn primary"
          onClick={() => void useWorkspaceStore.getState().openViaDialog()}
        >
          Open Folder…
        </button>
      </div>
    );
  }

  const searching = Boolean(query.trim());

  return (
    <div className="sr-files-pane" data-testid="session-files-pane">
      <div className="sr-files-project" title={workspace.path}>
        <Ic name="folder" size={13} />
        <strong>{workspace.displayName}</strong>
        <small className="mono">{workspace.path}</small>
        {searching ? null : (
          <span className="sr-files-actions">
            <button
              type="button"
              className="sr-files-action"
              title="New File"
              aria-label="New File"
              data-testid="explorer-new-file"
              onClick={() => treeRef.current?.startCreate('file')}
            >
              <Ic name="plus" size={12} />
            </button>
            <button
              type="button"
              className="sr-files-action"
              title="Refresh"
              aria-label="Refresh"
              onClick={() => refreshAll()}
            >
              ↺
            </button>
            <button
              type="button"
              className={`sr-files-action ${showIgnored ? 'active' : ''}`}
              title={showIgnored ? 'Hide ignored' : 'Show ignored'}
              aria-label="Toggle ignored files"
              aria-pressed={showIgnored}
              onClick={() => setShowIgnored(!showIgnored)}
            >
              <Ic name="eye" size={12} />
            </button>
          </span>
        )}
      </div>
      <label className="sr-search-box sr-files-search">
        <Ic name="search" size={13} />
        <input
          data-testid="session-files-search"
          value={query}
          placeholder={`Search files in ${workspace.displayName}…`}
          aria-label="Search project files"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div className={`sr-files-scroll ${searching ? '' : 'sr-files-tree-host'}`}>
        {searching ? (
          <div className="sr-files-results" data-testid="session-files-results">
            {results.map((path) => (
              <div
                key={path}
                className="hm-tree-row sr-files-result"
                role="button"
                tabIndex={0}
                title={path}
                draggable
                data-testid={`session-files-hit-${path}`}
                onDragStart={(e) => setDragRef(e, path)}
                onClick={() => quickAdd?.(path)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') quickAdd?.(path);
                }}
              >
                <Ic name="file" size={12} />
                <span className="hm-tree-name mono">{path}</span>
                {quickAdd ? (
                  <span className="hm-tree-add" aria-hidden>
                    <Ic name="plus" size={11} />
                  </span>
                ) : null}
              </div>
            ))}
            {results.length === 0 ? (
              <div className="sr-files-empty">No files match “{query.trim()}”.</div>
            ) : null}
          </div>
        ) : (
          <ProjectTree ref={treeRef} {...(quickAdd ? { onQuickAdd: quickAdd } : {})} />
        )}
      </div>
      <p className="sr-files-tip">
        <Ic name="file" size={12} />
        {quickAddTaskId
          ? 'Drag files, folders or images into the conversation — or tap + to attach.'
          : 'Open a Session of this project, then drag files into its conversation.'}
      </p>
    </div>
  );
}
