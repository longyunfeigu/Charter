import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RecentWorkspaceDto, TaskDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { openWorkspaceFile } from './PathLinks.js';
import { Ic } from './home-icons.js';
import { stateShort } from './labels.js';

interface Entry {
  id: string;
  group: 'Actions' | 'Tasks' | 'Files' | 'Projects';
  icon: string;
  label: string;
  sub?: string;
  badge?: string;
  run: () => void;
}

/**
 * ⌘K quick launcher (PIVOT-018): one keyboard-first search over projects,
 * recent tasks, project files and app actions.
 */
export function QuickLauncher(): React.JSX.Element | null {
  const open = useAppStore((s) => s.launcherOpen);
  const setOpen = useAppStore((s) => s.setLauncherOpen);
  const surface = useAppStore((s) => s.surface);
  const workspace = useWorkspaceStore((s) => s.workspace);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [recent, setRecent] = useState<RecentWorkspaceDto[]>([]);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    setFiles([]);
    void rpcResult('workspace.recent', {}).then((res) => {
      if (res.ok) setRecent(res.data.items);
    });
    if (workspace) {
      void rpcResult('task.list', { filter: 'all', includeArchived: false, scope: 'all' }).then(
        (res) => {
          if (res.ok) setTasks(res.data.tasks);
        },
      );
    } else {
      setTasks([]);
    }
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, workspace]);

  // Filename search follows the query (workspace only).
  useEffect(() => {
    if (!open || !workspace) return;
    const handle = setTimeout(() => {
      void rpcResult('search.files', { query }).then((res) => {
        if (res.ok) setFiles(res.data.items.slice(0, 8).map((i) => i.path));
      });
    }, 80);
    return () => clearTimeout(handle);
  }, [open, workspace, query]);

  const entries = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = (text: string) => q === '' || text.toLowerCase().includes(q);
    const list: Entry[] = [];

    const actions: Entry[] = [
      {
        id: 'action-new-task',
        group: 'Actions',
        icon: 'pencil',
        label: 'New Task',
        run: () => useAppStore.getState().setSurface('home'),
      },
      surface === 'home'
        ? {
            id: 'action-open-ide',
            group: 'Actions',
            icon: 'layout',
            label: 'Open IDE workspace',
            run: () => useAppStore.getState().setSurface('workspace'),
          }
        : {
            id: 'action-go-home',
            group: 'Actions',
            icon: 'flag',
            label: 'Go Home (task launcher)',
            run: () => useAppStore.getState().setSurface('home'),
          },
      {
        id: 'action-settings',
        group: 'Actions',
        icon: 'sliders',
        label: 'Open Settings',
        run: () => {
          useAppStore.getState().setSurface('workspace');
          useAppStore.getState().setOverlay('settings');
        },
      },
    ];
    list.push(...actions.filter((a) => matches(a.label)));

    for (const t of tasks.filter((t) => matches(t.title)).slice(0, 6)) {
      list.push({
        id: `task-${t.id}`,
        group: 'Tasks',
        icon: 'inbox',
        label: t.title,
        sub: stateShort(t.state),
        run: () => {
          // ADR-0008: tasks open in their Task Room, not the Editor.
          void useTaskStore.getState().openTask(t.id);
          useAppStore.getState().openTaskRoom(t.id);
        },
      });
    }

    if (q !== '') {
      for (const path of files) {
        list.push({
          id: `file-${path}`,
          group: 'Files',
          icon: 'file',
          label: path.split('/').pop() ?? path,
          sub: path,
          run: () => openWorkspaceFile(path),
        });
      }
    }

    for (const r of recent.filter((r) => matches(r.displayName)).slice(0, 5)) {
      list.push({
        id: `project-${r.path}`,
        group: 'Projects',
        icon: 'folder',
        label: r.displayName,
        sub: r.path,
        ...(r.kind ? { badge: r.kind } : {}),
        run: () => {
          if (workspace?.path !== r.path) {
            if (surface === 'home') useAppStore.getState().setHomePick(true);
            void useWorkspaceStore.getState().openPath(r.path);
          }
        },
      });
    }
    return list;
  }, [query, tasks, files, recent, surface, workspace]);

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  if (!open) return null;

  const runEntry = (entry: Entry | undefined): void => {
    if (!entry) return;
    setOpen(false);
    entry.run();
  };

  let lastGroup: string | null = null;

  return (
    <div
      data-testid="qk-view"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'var(--bg-overlay)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '14vh',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-label="Search everything"
        style={{
          width: 'min(560px, 92vw)',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '11px 14px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <Ic name="search" size={15} />
          <input
            ref={inputRef}
            data-testid="qk-input"
            placeholder="Search projects, tasks, files…"
            value={query}
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--fg)',
              fontSize: 14,
              fontFamily: 'inherit',
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex(Math.min(index + 1, entries.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex(Math.max(index - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runEntry(entries[index]);
              }
            }}
          />
        </div>
        <div style={{ maxHeight: 360, overflowY: 'auto', padding: '4px 6px 6px' }}>
          {entries.length === 0 ? (
            <div className="text-muted" style={{ padding: 14, fontSize: 12.5 }}>
              No matches{workspace ? '' : ' — open a project to search tasks and files'}.
            </div>
          ) : (
            entries.map((entry, i) => {
              const header = entry.group !== lastGroup ? entry.group : null;
              lastGroup = entry.group;
              return (
                <React.Fragment key={entry.id}>
                  {header ? (
                    <div
                      className="text-muted"
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.07em',
                        textTransform: 'uppercase',
                        padding: '8px 10px 3px',
                      }}
                    >
                      {header}
                    </div>
                  ) : null}
                  <button
                    data-testid={`qk-${entry.id}`}
                    onMouseMove={() => setIndex(i)}
                    onClick={() => runEntry(entry)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      width: '100%',
                      textAlign: 'left',
                      padding: '7px 10px',
                      borderRadius: 7,
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 13,
                      color: 'var(--fg)',
                      background: i === index ? 'var(--bg-hover)' : 'transparent',
                    }}
                  >
                    <Ic name={entry.icon} size={14} />
                    <span
                      style={{
                        flex: 'none',
                        maxWidth: '55%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {entry.label}
                    </span>
                    {entry.badge ? (
                      <span
                        className="mono text-muted"
                        style={{
                          fontSize: 9.5,
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          padding: '0 5px',
                          background: 'var(--bg-hover)',
                        }}
                      >
                        {entry.badge}
                      </span>
                    ) : null}
                    {entry.sub ? (
                      <span
                        className="text-muted"
                        style={{
                          marginLeft: 'auto',
                          fontSize: 11,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          maxWidth: '45%',
                        }}
                      >
                        {entry.sub}
                      </span>
                    ) : null}
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>
        <div
          className="text-muted"
          style={{
            borderTop: '1px solid var(--border)',
            padding: '7px 14px',
            fontSize: 11,
            display: 'flex',
            gap: 14,
          }}
        >
          <span>↑↓ navigate</span>
          <span>⏎ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
