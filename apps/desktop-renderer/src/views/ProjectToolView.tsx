import React, { useEffect, useRef, useState } from 'react';
import type { ProjectTool } from '../store/appStore.js';
import { useAppStore } from '../store/appStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { EditorArea } from '../workbench/EditorArea.js';
import { SearchView, focusSearchView } from './SearchView.js';
import { ScmView } from './ScmView.js';
import { ProblemsPanel } from './ProblemsPanel.js';
import { Ic } from './home-icons.js';

const TOOLS: Array<{ id: ProjectTool; label: string; icon: 'search' | 'branch' }> = [
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'changes', label: 'Changes', icon: 'branch' },
];

// User-resizable Search/Changes column (2026-08-09 acceptance feedback) —
// same pointer/keyboard idiom as the rail's .sr-rail-resize handle.
const CONTEXT_WIDTH_KEY = 'charter.projectTool.contextWidth.v1';
const CONTEXT_WIDTH_DEFAULT = 278;
const CONTEXT_WIDTH_MIN = 200;
const CONTEXT_WIDTH_MAX = 640;

function clampContextWidth(width: number): number {
  return Math.min(CONTEXT_WIDTH_MAX, Math.max(CONTEXT_WIDTH_MIN, Math.round(width)));
}

function loadContextWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(CONTEXT_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) return clampContextWidth(saved);
  } catch {
    // best-effort UI state
  }
  return CONTEXT_WIDTH_DEFAULT;
}

function saveContextWidth(width: number): void {
  try {
    window.localStorage.setItem(CONTEXT_WIDTH_KEY, String(clampContextWidth(width)));
  } catch {
    // best-effort UI state
  }
}

/**
 * Project tools before a collaboration Session exists. This is a content state
 * of the persistent shell—not the retired Full workspace: there is no second
 * Activity Bar, global Sidebar, Agent Panel, or alternate navigation model.
 * ADR-0029: the file tree lives in the rail's Files pane — 'editor' renders
 * the plain editor, and the context column exists only for Search/Changes.
 * Clicking the active tool tab collapses back to the plain editor.
 */
export function ProjectToolView({ tool }: { tool: ProjectTool }): React.JSX.Element {
  const app = useAppStore();
  const bottomTab = useAppStore((state) => state.projectBottomTab);
  const workspace = useWorkspaceStore((state) => state.workspace);
  const editorGroups = useEditorStore((state) => state.groups.length);
  const splitEditor = useEditorStore((state) => state.split);
  const joinEditors = useEditorStore((state) => state.unsplit);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [contextWidth, setContextWidth] = useState(loadContextWidth);
  const [resizing, setResizing] = useState(false);
  const resizingRef = useRef(false);
  const widthRef = useRef(contextWidth);

  const choose = (next: ProjectTool): void => {
    if (tool === next) {
      // Toggling the active tool off gives its width back to the editor.
      app.setProjectTool('editor');
      return;
    }
    app.setProjectTool(next);
    if (next === 'search') window.setTimeout(focusSearchView, 0);
  };

  // The editor stage keeps a usable minimum no matter how far the user drags.
  const contextWidthLimit = (): number => {
    const bodyWidth = bodyRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.max(CONTEXT_WIDTH_MIN, Math.min(CONTEXT_WIDTH_MAX, bodyWidth - 420));
  };

  const updateContextWidth = (width: number, persist = false): void => {
    const next = Math.min(contextWidthLimit(), clampContextWidth(width));
    widthRef.current = next;
    setContextWidth(next);
    if (persist) saveContextWidth(next);
  };

  const resizeFromPointer = (clientX: number): void => {
    const left = bodyRef.current?.getBoundingClientRect().left ?? 0;
    updateContextWidth(clientX - left);
  };

  useEffect(() => {
    if (!resizing) return;
    document.documentElement.classList.add('sr-resizing');
    return () => document.documentElement.classList.remove('sr-resizing');
  }, [resizing]);

  // Keep the editor stage usable when the window shrinks under a wide column
  // (replaces the old fixed 256px narrow-viewport CSS override).
  useEffect(() => {
    const clamp = (): void => updateContextWidth(widthRef.current);
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="project-tool-root" data-testid="project-tool-view">
      <header className="project-tool-head">
        <button data-testid="project-tool-back" onClick={() => app.setProjectTool(null)}>
          <Ic name="chevron" size={12} /> Sessions
        </button>
        <div className="project-tool-title">
          <strong>{workspace?.displayName ?? 'Project tools'}</strong>
          <span title={workspace?.path}>{workspace?.path ?? 'Open a project to edit files'}</span>
        </div>
        <nav role="tablist" aria-label="Project tools">
          {TOOLS.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tool === item.id}
              className={tool === item.id ? 'active' : ''}
              data-testid={`project-tool-${item.id}`}
              onClick={() => choose(item.id)}
            >
              <Ic name={item.icon} size={12} /> {item.label}
            </button>
          ))}
        </nav>
        <button
          data-testid="project-editor-split"
          title={editorGroups > 1 ? 'Join editor groups' : 'Split editor'}
          onClick={() => (editorGroups > 1 ? joinEditors() : splitEditor())}
        >
          <i className="project-codicon project-codicon-split" aria-hidden />
          <span>{editorGroups > 1 ? 'Join' : 'Split'}</span>
        </button>
      </header>

      <div
        ref={bodyRef}
        className={`project-tool-body ${tool === 'editor' ? 'context-collapsed' : ''} ${
          resizing ? 'is-resizing' : ''
        }`}
        style={{ '--ptc-width': `${contextWidth}px` } as React.CSSProperties}
      >
        <aside
          className="project-tool-context"
          data-testid="project-tool-context"
          aria-label={tool === 'editor' ? 'Project context' : `${tool} context`}
          aria-hidden={tool === 'editor'}
          inert={tool === 'editor'}
        >
          {tool === 'search' ? <SearchView /> : tool === 'changes' ? <ScmView /> : null}
        </aside>
        {tool !== 'editor' ? (
          <div
            className="ptc-resize"
            data-testid="project-context-resize"
            role="separator"
            aria-label="Resize the tool column"
            aria-orientation="vertical"
            aria-valuemin={CONTEXT_WIDTH_MIN}
            aria-valuemax={CONTEXT_WIDTH_MAX}
            aria-valuenow={contextWidth}
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            onDoubleClick={() => updateContextWidth(CONTEXT_WIDTH_DEFAULT, true)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                updateContextWidth(contextWidth + (event.key === 'ArrowRight' ? 10 : -10), true);
              } else if (event.key === 'Home') {
                event.preventDefault();
                updateContextWidth(CONTEXT_WIDTH_DEFAULT, true);
              }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              resizingRef.current = true;
              setResizing(true);
              resizeFromPointer(event.clientX);
            }}
            onPointerMove={(event) => {
              if (!resizingRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) {
                return;
              }
              resizeFromPointer(event.clientX);
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              saveContextWidth(widthRef.current);
              resizingRef.current = false;
              setResizing(false);
            }}
            onPointerCancel={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              saveContextWidth(widthRef.current);
              resizingRef.current = false;
              setResizing(false);
            }}
          />
        ) : null}
        <div className={`project-tool-stage ${bottomTab ? 'with-bottom' : ''}`}>
          <section className="project-tool-editor" data-testid="project-tool-editor">
            <EditorArea />
          </section>
          {bottomTab ? (
            <section className="project-tool-bottom" data-testid="project-bottom-panel">
              <header>
                <strong>{bottomTab === 'problems' ? 'Problems' : 'Project output'}</strong>
                <span>Context for the current project</span>
                <button
                  type="button"
                  aria-label="Close project panel"
                  onClick={() => app.setProjectBottomTab(null)}
                >
                  <Ic name="x" size={12} />
                </button>
              </header>
              <div className="project-tool-bottom-body">
                {bottomTab === 'problems' ? (
                  <ProblemsPanel />
                ) : (
                  <div className="empty-state">No output for this project yet.</div>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </div>
      <footer className="project-tool-foot">
        <span>
          <i /> Project tool · {workspace?.displayName ?? 'no project'}
        </span>
        <span>Start a Session when you want an agent, evidence ledger, or review</span>
      </footer>
    </main>
  );
}
