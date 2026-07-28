import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore.js';
import { useExternalStore } from '../store/externalStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { EditorArea } from '../workbench/EditorArea.js';
import { ProjectTree } from './ProjectTree.js';
import { ScmView } from './ScmView.js';
import { ExternalPanel } from './ExternalPanel.js';
import { Ic, ProviderMark } from './home-icons.js';
import {
  mountTerminal,
  observeTerminalFit,
  TerminalPanel,
  useTerminalStore,
} from './TerminalPanel.js';
import { OrchestrationWorkerBand } from './OrchestrationFleet.js';
import { useSshStore } from '../store/sshStore.js';
import { openRemoteSession } from './remote-session.js';

function launchName(launch: 'shell' | 'claude' | 'codex'): string {
  if (launch === 'claude') return 'Claude Code';
  if (launch === 'codex') return 'Codex';
  return 'Terminal';
}

/** ADR-0047: remote-session header controls (Reconnect / Disconnect). Reconnect
 * starts a fresh session on the same host + launch; the exited tile stays as
 * history because a dropped shell channel cannot be resurrected. */
function RemoteControls({
  hostId,
  hostLabel,
  launch,
  exited,
}: {
  hostId: string;
  hostLabel: string;
  launch: 'shell' | 'claude' | 'codex';
  exited: boolean;
}): React.JSX.Element {
  const reconnect = async (): Promise<void> => {
    await openRemoteSession(hostId, launch);
  };
  const disconnect = (): void => {
    void useSshStore.getState().disconnect(hostId);
  };
  return (
    <>
      {exited ? (
        <button data-testid="ssh-reconnect" onClick={() => void reconnect()}>
          <Ic name="terminal" size={12} /> Reconnect
        </button>
      ) : (
        <button data-testid="ssh-disconnect" onClick={disconnect} title={`Disconnect ${hostLabel}`}>
          Disconnect
        </button>
      )}
    </>
  );
}

export function SessionTerminalView({ terminalId }: { terminalId: string }): React.JSX.Element {
  const app = useAppStore();
  const item = useTerminalStore((state) => state.items.find((entry) => entry.id === terminalId));
  const workspace = useWorkspaceStore((state) => state.workspace);
  const promotedTerminalId = useExternalStore((state) => state.promoted?.terminalId ?? null);
  const dockItemCount = useTerminalStore(
    (state) =>
      state.items.filter((entry) => !entry.hidden && entry.id !== promotedTerminalId).length,
  );
  const liveTerminalCount = useTerminalStore(
    (state) => state.items.filter((entry) => !entry.hidden && !entry.exited).length,
  );
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
      <main className="stv-root" data-testid="session-terminal-view" data-terminal-id={terminalId}>
        <div className="empty-state">
          <div className="es-title">This terminal session is no longer available.</div>
          <button className="btn" onClick={app.closeTaskRoom}>
            Back to Sessions
          </button>
        </div>
      </main>
    );
  }

  if (item.launch === 'shell') {
    // A plain-shell Session is a manager for the terminal dock. Its original
    // route PTY may have exited while a newly created neighbour is live.
    // A terminal promoted into the side slot leaves the dock but remains a
    // live PTY owned by this manager, so lifecycle truth must include it.
    const managerEnded = item.remote ? item.exited : liveTerminalCount === 0;
    const managerStatusText = item.remote
      ? item.exited
        ? 'remote process ended'
        : 'remote session live'
      : managerEnded
        ? 'all processes ended'
        : `live sessions · ${liveTerminalCount} active`;
    return (
      <main
        className="stv-root stv-manager"
        data-testid="session-terminal-view"
        data-terminal-id={terminalId}
      >
        <header className="stv-header">
          <ProviderMark provider="shell" size={19} />
          <div className="stv-title">
            <strong>{item.remote ? `SSH · ${item.remote.hostLabel}` : 'Terminal Session'}</strong>
            <span>
              {item.remote
                ? `${item.remote.username}@${item.remote.host}:${item.remote.port}`
                : `${item.contextLabel} · ${item.projectName}`}
            </span>
          </div>
          <span
            className={`stv-status ${managerEnded ? 'ended' : ''}`}
            data-testid="session-terminal-manager-status"
          >
            <i />
            {managerEnded ? 'Ended' : 'Live'}
          </span>
          <span className="stv-spacer" />
          {item.remote ? (
            <RemoteControls
              hostId={item.remote.hostId}
              hostLabel={item.remote.hostLabel}
              launch={item.launch}
              exited={item.exited}
            />
          ) : null}
          <button
            onClick={
              item.remote ? () => app.selectRemoteHost(item.remote!.hostId) : app.closeTaskRoom
            }
          >
            <Ic name="chevron" size={12} /> {item.remote ? 'Host' : 'Sessions'}
          </button>
        </header>
        <OrchestrationWorkerBand terminalId={terminalId} />
        <div className={`stv-manager-body ${dockItemCount === 0 ? 'only-external' : ''}`}>
          {dockItemCount > 0 ? (
            <section className="stv-terminal-dock" data-testid="bottom-panel">
              <TerminalPanel />
            </section>
          ) : null}
          <ExternalPanel />
        </div>
        <footer className="stv-footer" data-testid="session-terminal-manager-footer">
          <span>
            <i className={managerEnded ? 'ended' : ''} /> Terminal manager · {managerStatusText}
          </span>
          <span className="stv-spacer" />
          <span>PTYs stay alive while you switch Sessions</span>
        </footer>
      </main>
    );
  }

  return (
    <main className="stv-root" data-testid="session-terminal-view" data-terminal-id={terminalId}>
      <header className="stv-header">
        <ProviderMark
          provider={item.launch === 'claude' || item.launch === 'codex' ? item.launch : 'shell'}
          size={19}
        />
        <div className="stv-title">
          <strong>
            {launchName(item.launch)} · {item.title}
          </strong>
          <span>
            {item.remote
              ? `${item.remote.username}@${item.remote.host} · ${launchName(item.launch)}`
              : `${item.contextLabel} · ${item.projectName}`}
          </span>
        </div>
        <span className={`stv-status ${item.exited ? 'ended' : ''}`}>
          <i />
          {item.exited ? 'Ended' : 'Live'}
        </span>
        <span className="stv-spacer" />
        {item.remote ? (
          <RemoteControls
            hostId={item.remote.hostId}
            hostLabel={item.remote.hostLabel}
            launch={item.launch}
            exited={item.exited}
          />
        ) : null}
        <button className={toolOpen ? 'active' : ''} onClick={() => setToolOpen((open) => !open)}>
          <Ic name="layout" size={13} /> {toolOpen ? 'Hide tools' : 'Show tools'}
        </button>
      </header>
      <OrchestrationWorkerBand terminalId={terminalId} />

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
                <section
                  className="stv-explorer"
                  style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
                >
                  <div className="stv-pane-title">Files</div>
                  <ProjectTree />
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
