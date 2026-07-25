import React, { useEffect, useMemo, useState } from 'react';
import type { SshConfigCandidate, SshHostDto } from '@pi-ide/ipc-contracts';
import { useAppStore, type RailView } from '../store/appStore.js';
import { useSshStore } from '../store/sshStore.js';
import { ActivityBar } from './ActivityBar.js';
import { Ic } from './home-icons.js';
import { ImportPanel } from './RemotesView.js';
import { RemoteHostDialog } from './RemoteHostDialog.js';
import { useTerminalStore } from './TerminalPanel.js';
import { focusRemoteSession } from './remote-session.js';

function isConnected(host: SshHostDto): boolean {
  return host.connection.state !== 'disconnected';
}

export function RemoteRail(): React.JSX.Element {
  const app = useAppStore();
  const hosts = useSshStore((state) => state.hosts);
  const loaded = useSshStore((state) => state.loaded);
  const importConfig = useSshStore((state) => state.importConfig);
  const terminals = useTerminalStore((state) => state.items);
  const [query, setQuery] = useState('');
  const [newHostOpen, setNewHostOpen] = useState(false);
  const [importState, setImportState] = useState<
    { status: 'loading' } | { status: 'open'; candidates: SshConfigCandidate[] } | null
  >(null);

  useEffect(() => {
    useSshStore.getState().init();
    useTerminalStore.getState().init();
  }, []);

  const orderedHosts = useMemo(
    () => [...hosts].sort((a, b) => Number(isConnected(b)) - Number(isConnected(a))),
    [hosts],
  );

  useEffect(() => {
    if (!loaded || orderedHosts.length === 0) return;
    if (!orderedHosts.some((host) => host.id === app.remoteSelectedHostId)) {
      app.selectRemoteHost(orderedHosts[0]!.id);
    }
  }, [app, loaded, orderedHosts]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return orderedHosts;
    return orderedHosts.filter((host) => {
      const sessions = terminals.filter((terminal) => terminal.remote?.hostId === host.id);
      return [
        host.label,
        host.host,
        host.username,
        ...host.tags,
        ...sessions.map((session) => session.title),
      ]
        .join(' ')
        .toLowerCase()
        .includes(normalized);
    });
  }, [orderedHosts, query, terminals]);

  const leaveRemote = (view: Exclude<RailView, 'files'>): void => {
    app.closeRemotes();
    app.setRailView(view);
  };

  const openImport = async (): Promise<void> => {
    setImportState({ status: 'loading' });
    const candidates = await importConfig();
    setImportState({ status: 'open', candidates });
  };

  const renderGroup = (label: string, group: SshHostDto[]): React.JSX.Element | null => {
    if (group.length === 0) return null;
    return (
      <section className="rr-group" aria-label={`${label} hosts`}>
        <div className="rr-group-label">
          <span>{label}</span>
          <span>{group.length}</span>
        </div>
        {group.map((host) => {
          const sessions = terminals.filter(
            (terminal) =>
              terminal.remote?.hostId === host.id && !terminal.hidden && !terminal.exited,
          );
          const selectedHost = app.remoteSelectedHostId === host.id;
          return (
            <div className="rr-host-group" key={host.id} data-testid={`rm-host-${host.id}`}>
              <button
                className={`rr-host ${selectedHost && !app.sessionTerminalId ? 'selected' : ''}`}
                data-testid={`remote-host-${host.id}`}
                title={`${host.username}@${host.host}:${host.port}`}
                onClick={() => app.selectRemoteHost(host.id)}
              >
                <Ic name="server" size={14} />
                <span className={`rr-status ${host.connection.state}`} />
                <span className="rr-host-copy">
                  <strong>{host.label}</strong>
                  <small>
                    {host.username}@{host.host}
                  </small>
                </span>
                {sessions.length > 0 ? <span className="rr-count">{sessions.length}</span> : null}
              </button>
              {sessions.length > 0 ? (
                <div className="rr-sessions" data-testid={`rm-sessions-${host.id}`}>
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      className={`rr-session ${app.sessionTerminalId === session.id ? 'selected' : ''}`}
                      data-testid={`rm-session-${session.id}`}
                      title={`${session.title} · Live`}
                      onClick={() => focusRemoteSession(session.id, host.id)}
                    >
                      <span className="rr-branch" aria-hidden="true" />
                      <Ic name="terminal" size={12} />
                      <span className="rr-session-copy">
                        <strong>{session.title}</strong>
                        <small>Live</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </section>
    );
  };

  const connected = filtered.filter(isConnected);
  const saved = filtered.filter((host) => !isConnected(host));

  return (
    <aside className="sr-rail remote-rail" data-testid="remote-explorer-rail" aria-label="Remote">
      <ActivityBar
        active="remotes"
        onSelect={leaveRemote}
        onProjects={() => leaveRemote('projects')}
        onRemotes={() => undefined}
      />
      <section className="sr-panel rr-panel">
        <header className="rr-head">
          <div className="rr-title-row">
            <span>
              <small>Infrastructure</small>
              <strong>Remote Explorer</strong>
            </span>
            <button title="New Host" aria-label="New Host" onClick={() => setNewHostOpen(true)}>
              <Ic name="plus" size={14} />
            </button>
          </div>
          <label className="rr-search">
            <Ic name="search" size={13} />
            <input
              value={query}
              placeholder="Search hosts or sessions"
              aria-label="Search remote hosts and sessions"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button aria-label="Clear search" onClick={() => setQuery('')}>
                <Ic name="x" size={11} />
              </button>
            ) : null}
          </label>
        </header>
        <div className="rr-tree">
          {!loaded ? (
            <div className="rr-loading">Loading hosts…</div>
          ) : filtered.length === 0 ? (
            <div className="rr-empty">
              <Ic name="server" size={22} />
              <strong>{hosts.length === 0 ? 'No remote hosts' : 'No matches'}</strong>
              <span>
                {hosts.length === 0
                  ? 'Add a host or import your SSH config.'
                  : 'Try a host name, address or session title.'}
              </span>
            </div>
          ) : (
            <>
              {renderGroup('Connected', connected)}
              {renderGroup('Saved', saved)}
            </>
          )}
        </div>
        <footer className="rr-foot">
          <button onClick={() => setNewHostOpen(true)}>
            <Ic name="plus" size={12} /> New Host
          </button>
          <button onClick={() => void openImport()} disabled={importState?.status === 'loading'}>
            <Ic name="folder-open" size={12} />
            {importState?.status === 'loading' ? 'Scanning…' : 'Import'}
          </button>
        </footer>
      </section>
      {newHostOpen ? (
        <RemoteHostDialog mode="create" onClose={() => setNewHostOpen(false)} />
      ) : null}
      {importState?.status === 'open' ? (
        <ImportPanel candidates={importState.candidates} onClose={() => setImportState(null)} />
      ) : null}
    </aside>
  );
}
