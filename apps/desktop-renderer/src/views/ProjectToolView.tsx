import React, { useState } from 'react';
import type { ProjectTool } from '../store/appStore.js';
import { useAppStore } from '../store/appStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { EditorArea } from '../workbench/EditorArea.js';
import { ExplorerView } from './ExplorerView.js';
import { SearchView, focusSearchView } from './SearchView.js';
import { ScmView } from './ScmView.js';
import { ProblemsPanel } from './ProblemsPanel.js';
import { Ic } from './home-icons.js';

const TOOLS: Array<{ id: ProjectTool; label: string; icon: 'file' | 'search' | 'branch' }> = [
  { id: 'files', label: 'Files', icon: 'file' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'changes', label: 'Changes', icon: 'branch' },
];

/**
 * Project tools before a collaboration Session exists. This is a content state
 * of the persistent shell—not the retired Full workspace: there is no second
 * Activity Bar, global Sidebar, Agent Panel, or alternate navigation model.
 * Once a Session is active the same editor model is embedded in its File tool.
 */
export function ProjectToolView({ tool }: { tool: ProjectTool }): React.JSX.Element {
  const app = useAppStore();
  const bottomTab = useAppStore((state) => state.projectBottomTab);
  const workspace = useWorkspaceStore((state) => state.workspace);
  const editorGroups = useEditorStore((state) => state.groups.length);
  const splitEditor = useEditorStore((state) => state.split);
  const joinEditors = useEditorStore((state) => state.unsplit);
  const [contextCollapsed, setContextCollapsed] = useState(false);

  const choose = (next: ProjectTool): void => {
    setContextCollapsed(false);
    app.setProjectTool(next);
    if (next === 'search') window.setTimeout(focusSearchView, 0);
  };

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
        <button
          data-testid="project-context-toggle"
          aria-label={contextCollapsed ? 'Show project context' : 'Hide project context'}
          aria-pressed={!contextCollapsed}
          title={contextCollapsed ? 'Show Files, Search or Changes' : 'Hide project context'}
          onClick={() => setContextCollapsed((collapsed) => !collapsed)}
        >
          <i
            className={`project-codicon ${contextCollapsed ? 'project-codicon-sidebar' : 'project-codicon-sidebar-off'}`}
            aria-hidden
          />
          <span>{contextCollapsed ? 'Show context' : 'Hide context'}</span>
        </button>
      </header>

      <div className={`project-tool-body ${contextCollapsed ? 'context-collapsed' : ''}`}>
        <aside
          className="project-tool-context"
          data-testid="project-tool-context"
          aria-label={`${tool} context`}
          aria-hidden={contextCollapsed}
          inert={contextCollapsed}
        >
          {tool === 'files' ? <ExplorerView /> : tool === 'search' ? <SearchView /> : <ScmView />}
        </aside>
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
