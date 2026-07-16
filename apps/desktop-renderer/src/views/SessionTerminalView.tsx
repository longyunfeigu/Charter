import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { EditorArea } from '../workbench/EditorArea.js';
import { ExplorerView } from './ExplorerView.js';
import { ScmView } from './ScmView.js';
import { Ic } from './home-icons.js';
import { mountTerminal, observeTerminalFit, useTerminalStore } from './TerminalPanel.js';

function launchName(launch: 'shell' | 'claude' | 'codex'): string {
  if (launch === 'claude') return 'Claude Code';
  if (launch === 'codex') return 'Codex';
  return 'Terminal';
}

export function SessionTerminalView({ terminalId }: { terminalId: string }): React.JSX.Element {
  const app = useAppStore();
  const item = useTerminalStore((state) => state.items.find((entry) => entry.id === terminalId));
  const workspace = useWorkspaceStore((state) => state.workspace);
  const hostRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<'editor' | 'changes'>('editor');
  const [toolOpen, setToolOpen] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !item) return;
    mountTerminal(host, item);
    return observeTerminalFit(host, item);
  }, [item, toolOpen]);

  if (!item) {
    return (
      <main className="stv-root" data-testid="session-terminal-view">
        <div className="empty-state">
          <div className="es-title">This terminal session is no longer available.</div>
          <button className="btn" onClick={app.closeTaskRoom}>
            Back to Sessions
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="stv-root" data-testid="session-terminal-view">
      <header className="stv-header">
        <span
          className={`sr-provider ${item.launch === 'claude' ? 'claude' : item.launch === 'codex' ? 'codex' : 'pi'}`}
        >
          {item.launch === 'claude' ? 'CC' : item.launch === 'codex' ? 'CX' : '›_'}
        </span>
        <div className="stv-title">
          <strong>
            {launchName(item.launch)} · {item.title}
          </strong>
          <span>
            {item.contextLabel} · {item.projectName}
          </span>
        </div>
        <span className={`stv-status ${item.exited ? 'ended' : ''}`}>
          <i />
          {item.exited ? 'Ended' : 'Live'}
        </span>
        <span className="stv-spacer" />
        <button className={toolOpen ? 'active' : ''} onClick={() => setToolOpen((open) => !open)}>
          <Ic name="layout" size={13} /> {toolOpen ? 'Hide tools' : 'Show tools'}
        </button>
        <button onClick={() => app.setSurface('workspace')}>
          <Ic name="folder" size={13} /> Workspace
        </button>
      </header>

      <div className={`stv-body ${toolOpen ? 'with-tools' : ''}`}>
        <section className="stv-terminal" aria-label={`${launchName(item.launch)} terminal`}>
          <div className="stv-terminal-bar">
            <span>{launchName(item.launch)} PTY</span>
            <span>external · unmanaged · state preserved</span>
            <span className="stv-spacer" />
            <span>{item.projectName} · main</span>
          </div>
          <div ref={hostRef} className="stv-terminal-host" data-testid="session-terminal-host" />
        </section>

        {toolOpen ? (
          <aside className="stv-tools" data-testid="session-tools">
            <div className="stv-tool-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tool === 'editor'}
                className={tool === 'editor' ? 'active' : ''}
                onClick={() => setTool('editor')}
              >
                Editor
              </button>
              <button
                role="tab"
                aria-selected={tool === 'changes'}
                className={tool === 'changes' ? 'active' : ''}
                onClick={() => setTool('changes')}
              >
                Changes
              </button>
              <span className="stv-spacer" />
              <span className="stv-context" title={workspace?.path}>
                {workspace?.displayName ?? 'No workspace'}
              </span>
            </div>
            {tool === 'editor' ? (
              <div className="stv-editor-layout">
                <section className="stv-explorer">
                  <div className="stv-pane-title">Files</div>
                  <ExplorerView />
                </section>
                <section className="stv-editor">
                  <EditorArea />
                </section>
              </div>
            ) : (
              <div className="stv-changes">
                <ScmView />
              </div>
            )}
          </aside>
        ) : null}
      </div>
      <footer className="stv-footer">
        <span>
          <i className={item.exited ? 'ended' : ''} /> {launchName(item.launch)} ·{' '}
          {item.exited ? 'process ended' : 'live session'}
        </span>
        <span>{item.cwd}</span>
        <span className="stv-spacer" />
        <span>PTY remains alive while you edit, preview or switch Sessions</span>
      </footer>
    </main>
  );
}
