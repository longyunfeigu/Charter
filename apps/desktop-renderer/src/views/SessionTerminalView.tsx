import React, { useEffect, useRef, useState } from 'react';
import { navigationSnapshotLabel, useAppStore } from '../store/appStore.js';
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
import { useTaskStore } from '../store/taskStore.js';
import { openRemoteSession } from './remote-session.js';
import {
  defaultExternalTerminalTools,
  externalAgentLifecycle,
  externalSessionTitle,
  externalTerminalLifecycle,
  isExternalCli,
} from './external-terminal-lifecycle.js';
import { canResumeExternal } from './labels.js';
import { agentDisplayName } from '../store/agentCatalogStore.js';
import { useAgentPresenceStore } from '../store/agentPresenceStore.js';
import { AgentPresenceBadge } from './AgentPresenceBadge.js';
import { TerminalImagePasteButton } from './TerminalImagePasteButton.js';

function launchName(launch: string): string {
  return launch === 'shell' ? 'Terminal' : agentDisplayName(launch);
}

/** ADR-0047: remote-session header controls (Reconnect / Disconnect). Reconnect
 * starts a fresh session on the same host + launch; the exited tile stays as
 * history because a dropped shell channel cannot be resurrected. */
function RemoteControls({
  hostId,
  hostLabel,
  launch,
  exited,
  onAllTerminals,
}: {
  hostId: string;
  hostLabel: string;
  launch: string;
  exited: boolean;
  onAllTerminals?(): void;
}): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const reconnect = async (): Promise<void> => {
    await openRemoteSession(hostId, launch);
  };
  const createSession = async (): Promise<void> => {
    setCreating(true);
    try {
      await openRemoteSession(hostId, 'shell');
    } finally {
      setCreating(false);
    }
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
        <>
          <button
            data-testid="ssh-new-session"
            disabled={creating}
            onClick={() => void createSession()}
            title={`Open another shell on ${hostLabel}`}
          >
            <Ic name="plus" size={12} /> {creating ? 'Opening…' : 'New SSH Session'}
          </button>
          {onAllTerminals ? (
            <button
              data-testid="ssh-all-terminals"
              onClick={onAllTerminals}
              title="Leave this host context and open the global terminal manager"
            >
              <Ic name="terminal" size={12} /> All Terminals
            </button>
          ) : null}
          <button
            data-testid="ssh-disconnect"
            onClick={disconnect}
            title={`Disconnect ${hostLabel}`}
          >
            Disconnect
          </button>
        </>
      )}
    </>
  );
}

export function SessionTerminalView({ terminalId }: { terminalId: string }): React.JSX.Element {
  const app = useAppStore();
  const item = useTerminalStore((state) => state.items.find((entry) => entry.id === terminalId));
  const workspace = useWorkspaceStore((state) => state.workspace);
  const remoteContext = Boolean(item?.remote && app.remotesOpen);
  const backTarget = app.navigationBack.at(-1) ?? null;
  const backLabel = backTarget
    ? navigationSnapshotLabel(backTarget)
    : remoteContext
      ? 'Host'
      : 'Sessions';
  const goBack = (): void => {
    if (backTarget) app.navigateBack();
    else if (remoteContext && item?.remote) app.selectRemoteHost(item.remote.hostId);
    else app.closeTaskRoom();
  };
  const allTerminals = !remoteContext && app.sessionTerminalScope === 'all';
  const singleSession = !remoteContext && !allTerminals;
  const promotedTerminalId = useExternalStore((state) => state.promoted?.terminalId ?? null);
  const dockItemCount = useTerminalStore(
    (state) =>
      state.items.filter((entry) => !entry.hidden && entry.id !== promotedTerminalId).length,
  );
  const remoteDockItemCount = useTerminalStore((state) =>
    item?.remote
      ? state.items.filter(
          (entry) =>
            !entry.hidden &&
            entry.id !== promotedTerminalId &&
            entry.remote?.hostId === item.remote?.hostId,
        ).length
      : 0,
  );
  const liveTerminalCount = useTerminalStore(
    (state) => state.items.filter((entry) => !entry.hidden && !entry.exited).length,
  );
  const mappedTaskId = useExternalStore((state) => state.taskByTerminal[terminalId]);
  const agent = useExternalStore((state) => state.agentByTerminal[terminalId] ?? null);
  const sessions = useExternalStore((state) => state.sessions);
  const tasks = useTaskStore((state) => state.tasks);
  const relatedTask =
    (mappedTaskId ? tasks.find((task) => task.id === mappedTaskId) : undefined) ??
    tasks
      .filter((task) => task.external?.terminalId === terminalId)
      .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const relatedSession =
    (mappedTaskId ? sessions[mappedTaskId] : undefined) ??
    Object.values(sessions).find((session) => session.terminalId === terminalId);
  const cliCandidate = agent ?? relatedSession?.cli ?? relatedTask?.external?.cli ?? item?.launch;
  const cli = isExternalCli(cliCandidate) ? cliCandidate : null;
  const agentStatus =
    relatedSession?.status ??
    relatedTask?.external?.status ??
    (agent !== null ? 'active' : item?.exited ? 'ended' : 'active');
  const lifecycle =
    item && cli
      ? externalTerminalLifecycle({
          cli,
          agent: externalAgentLifecycle(agentStatus, relatedTask?.state),
          terminalExited: item.exited,
          shellTitle: item.title,
        })
      : null;
  const terminalReadOnly = item !== undefined && (item.exited || lifecycle?.interactive === false);
  const changedFiles = relatedSession?.files.length ?? relatedTask?.changedFiles ?? 0;
  const defaultTools = defaultExternalTerminalTools(lifecycle?.agent ?? 'active', changedFiles);
  const viewRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const toolPreferenceTouched = useRef(false);
  const [tool, setTool] = useState<'editor' | 'changes'>(() => defaultTools.tool);
  const [toolOpen, setToolOpen] = useState(() => defaultTools.open);
  const presence = useAgentPresenceStore((state) => state.byTerminal[terminalId]);

  useEffect(() => useAgentPresenceStore.getState().init(), []);
  useEffect(() => {
    if (
      presence?.attention === 'done' &&
      useAppStore.getState().sessionTerminalId === terminalId &&
      viewRef.current?.isConnected
    ) {
      void useAgentPresenceStore.getState().markSeen(terminalId, 'terminal-header');
    }
  }, [presence?.attention, terminalId]);

  useEffect(() => {
    if (toolPreferenceTouched.current || !lifecycle) return;
    const next = defaultExternalTerminalTools(lifecycle.agent, changedFiles);
    setToolOpen(next.open);
    if (next.open) setTool(next.tool);
  }, [changedFiles, lifecycle?.agent]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !item) return;
    mountTerminal(host, item, 'normal', terminalReadOnly);
    return observeTerminalFit(host, item);
  }, [item, terminalReadOnly, toolOpen]);

  if (!item) {
    return (
      <main className="stv-root" data-testid="session-terminal-view" data-terminal-id={terminalId}>
        <div className="empty-state">
          <div className="es-title">This terminal session is no longer available.</div>
          <button className="btn" onClick={goBack}>
            Back to {backLabel}
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
    const managerEnded = allTerminals ? liveTerminalCount === 0 : item.exited;
    const managerStatusText = remoteContext
      ? item.exited
        ? 'remote process ended'
        : `${remoteDockItemCount} session${remoteDockItemCount === 1 ? '' : 's'} on ${item.remote!.hostLabel}`
      : allTerminals
        ? managerEnded
          ? 'all processes ended'
          : `live sessions · ${liveTerminalCount} active`
        : item.exited
          ? 'process ended'
          : 'session live';
    const managerDockItemCount = remoteContext
      ? remoteDockItemCount
      : allTerminals
        ? dockItemCount
        : item.id === promotedTerminalId
          ? 0
          : 1;
    const terminalScope = remoteContext ? 'remote-host' : allTerminals ? 'all' : 'single';
    return (
      <main
        className="stv-root stv-manager"
        data-testid="session-terminal-view"
        data-terminal-id={terminalId}
        data-terminal-scope={terminalScope}
      >
        <header className="stv-header">
          <ProviderMark provider="shell" size={19} />
          <div className="stv-title">
            <strong>
              {remoteContext || (singleSession && item.remote)
                ? `SSH · ${item.remote!.hostLabel}`
                : allTerminals
                  ? 'All Terminals'
                  : item.title}
            </strong>
            <span>
              {remoteContext || (singleSession && item.remote)
                ? `${item.remote!.username}@${item.remote!.host}:${item.remote!.port}`
                : allTerminals
                  ? 'Local and remote sessions'
                  : `${item.projectName} · ${item.contextLabel}`}
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
          {remoteContext ? (
            <RemoteControls
              hostId={item.remote!.hostId}
              hostLabel={item.remote!.hostLabel}
              launch={item.launch}
              exited={item.exited}
              onAllTerminals={() => {
                useTerminalStore.getState().setActive(item.id);
                app.openAllTerminals(item.id);
              }}
            />
          ) : null}
          {singleSession ? (
            <button
              data-testid="session-all-terminals"
              title="Open the global terminal manager"
              onClick={() => app.openAllTerminals(item.id)}
            >
              <Ic name="terminal" size={12} /> All Terminals
            </button>
          ) : null}
          <button data-testid="session-terminal-back" onClick={goBack}>
            <Ic name="chevron" size={12} /> {backLabel}
          </button>
        </header>
        <OrchestrationWorkerBand terminalId={terminalId} />
        <div className={`stv-manager-body ${managerDockItemCount === 0 ? 'only-external' : ''}`}>
          {managerDockItemCount > 0 ? (
            <section className="stv-terminal-dock" data-testid="bottom-panel">
              <TerminalPanel
                scope={
                  remoteContext
                    ? {
                        kind: 'remote-host',
                        terminalId: item.id,
                        hostId: item.remote!.hostId,
                        hostLabel: item.remote!.hostLabel,
                      }
                    : allTerminals
                      ? { kind: 'all' }
                      : { kind: 'single', terminalId: item.id }
                }
              />
            </section>
          ) : null}
          <ExternalPanel />
        </div>
        <footer className="stv-footer" data-testid="session-terminal-manager-footer">
          <span>
            <i className={managerEnded ? 'ended' : ''} />{' '}
            {remoteContext
              ? 'SSH sessions'
              : allTerminals
                ? 'Terminal manager'
                : 'Terminal session'}{' '}
            · {managerStatusText}
          </span>
          <span className="stv-spacer" />
          <span>PTYs stay alive while you switch Sessions</span>
        </footer>
      </main>
    );
  }

  const sessionTitle = cli ? externalSessionTitle(cli, item.title, relatedTask?.title) : item.title;
  const providerName = lifecycle?.providerLabel ?? launchName(item.launch);
  const primaryTitle =
    sessionTitle === `${providerName} session` ? sessionTitle : `${providerName} · ${sessionTitle}`;

  return (
    <main
      ref={viewRef}
      className="stv-root"
      data-testid="session-terminal-view"
      data-terminal-id={terminalId}
      data-agent-state={lifecycle?.agent}
      data-terminal-state={lifecycle?.terminal}
    >
      <header className="stv-header">
        <ProviderMark provider={item.launch === 'shell' ? 'shell' : item.launch} size={19} />
        <div className="stv-title">
          <strong>{primaryTitle}</strong>
          <span>
            {item.remote
              ? `${item.remote.username}@${item.remote.host} · ${launchName(item.launch)}`
              : `${item.contextLabel} · ${item.projectName}`}
          </span>
        </div>
        <AgentPresenceBadge terminalId={terminalId} explainable />
        {lifecycle ? (
          <>
            <span
              className={`stv-status agent ${lifecycle.agent}`}
              data-testid="session-agent-status"
            >
              <i />
              {lifecycle.agentLabel}
            </span>
            <span
              className={`stv-status terminal ${
                lifecycle.terminal === 'ended'
                  ? 'ended'
                  : lifecycle.agent === 'active'
                    ? 'live'
                    : 'shell'
              }`}
              data-testid="session-terminal-status"
            >
              <i />
              {lifecycle.terminalLabel}
            </span>
          </>
        ) : (
          <span className={`stv-status ${item.exited ? 'ended' : ''}`}>
            <i />
            {item.exited ? 'Ended' : 'Live'}
          </span>
        )}
        <span className="stv-spacer" />
        {item.remote ? (
          <RemoteControls
            hostId={item.remote.hostId}
            hostLabel={item.remote.hostLabel}
            launch={item.launch}
            exited={item.exited}
          />
        ) : null}
        {!terminalReadOnly ? <TerminalImagePasteButton terminalId={terminalId} /> : null}
        <button
          className={toolOpen ? 'active' : ''}
          data-testid="session-tools-toggle"
          onClick={() => {
            toolPreferenceTouched.current = true;
            setToolOpen((open) => !open);
          }}
        >
          <Ic name="layout" size={13} /> {toolOpen ? 'Hide tools' : 'Show tools'}
        </button>
        <button data-testid="session-terminal-back" onClick={goBack}>
          <Ic name="chevron" size={12} /> {backLabel}
        </button>
      </header>
      <OrchestrationWorkerBand terminalId={terminalId} />

      <div className={`stv-body ${toolOpen ? 'with-tools' : ''}`}>
        <section className="stv-terminal" aria-label={`${launchName(item.launch)} terminal`}>
          <div className="stv-terminal-bar">
            <span data-testid="session-terminal-headline">
              {lifecycle?.terminalHeadline ?? `${launchName(item.launch)} PTY`}
            </span>
            <span data-testid="session-terminal-detail">
              {item.remote?.workerSessionId
                ? 'remote SSH · Worker-tracked changes · state preserved'
                : (lifecycle?.terminalDetail ?? 'external · unmanaged · state preserved')}
            </span>
            <span className="stv-spacer" />
            <span>{item.projectName} · main</span>
          </div>
          <div ref={hostRef} className="stv-terminal-host" data-testid="session-terminal-host" />
          {terminalReadOnly ? (
            <div
              className="stv-terminal-readonly"
              data-testid="session-terminal-readonly"
              role="status"
            >
              <span>
                <strong>Session stopped</strong>
                Transcript is read-only.
              </span>
              {relatedTask && canResumeExternal(relatedTask) ? (
                <button
                  type="button"
                  onClick={() => void useExternalStore.getState().resumeTask(relatedTask)}
                >
                  Resume Session
                </button>
              ) : null}
            </div>
          ) : null}
        </section>

        {toolOpen ? (
          <aside className="stv-tools" data-testid="session-tools">
            <div className="stv-tool-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tool === 'editor'}
                className={tool === 'editor' ? 'active' : ''}
                onClick={() => {
                  toolPreferenceTouched.current = true;
                  setTool('editor');
                }}
              >
                Editor
              </button>
              <button
                role="tab"
                aria-selected={tool === 'changes'}
                className={tool === 'changes' ? 'active' : ''}
                onClick={() => {
                  toolPreferenceTouched.current = true;
                  setTool('changes');
                }}
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
                <ScmView
                  onDidOpenTarget={() => {
                    // The diff/file opened in the editor tool — reveal it.
                    toolPreferenceTouched.current = true;
                    setTool('editor');
                  }}
                />
              </div>
            )}
          </aside>
        ) : null}
      </div>
      <footer className="stv-footer">
        <span className={lifecycle?.agent === 'active' ? 'active' : 'settled'}>
          <i className={lifecycle?.agent === 'active' ? '' : 'ended'} />{' '}
          {lifecycle?.summary ??
            `${launchName(item.launch)} · ${item.exited ? 'process ended' : 'live session'}`}
        </span>
        <span>{item.cwd}</span>
        <span className="stv-spacer" />
        <span>PTY remains alive while you edit, preview or switch Sessions</span>
      </footer>
    </main>
  );
}
