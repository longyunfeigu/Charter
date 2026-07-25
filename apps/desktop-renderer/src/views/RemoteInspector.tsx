import React, { useState } from 'react';
import { useAppStore } from '../store/appStore.js';
import { useSshStore } from '../store/sshStore.js';
import { Ic } from './home-icons.js';
import { openRemoteSession } from './remote-session.js';
import { useTerminalStore } from './TerminalPanel.js';

export function RemoteInspector(): React.JSX.Element | null {
  const app = useAppStore();
  const host = useSshStore((state) =>
    state.hosts.find((candidate) => candidate.id === app.remoteSelectedHostId),
  );
  const terminal = useTerminalStore((state) =>
    app.sessionTerminalId
      ? state.items.find((candidate) => candidate.id === app.sessionTerminalId)
      : undefined,
  );
  const disconnect = useSshStore((state) => state.disconnect);
  const [busy, setBusy] = useState(false);

  if (!host) return null;

  const launch = async (): Promise<void> => {
    setBusy(true);
    await openRemoteSession(host.id, terminal?.launch ?? 'shell');
    setBusy(false);
  };

  return (
    <aside className="rm-inspector" data-testid="remote-inspector" aria-label="Remote context">
      <header>
        <span className={`rm-dot ${terminal?.exited ? '' : host.connection.state}`} />
        <span>
          <small>{terminal ? 'Remote session' : 'Remote host'}</small>
          <strong>{terminal?.title ?? host.label}</strong>
        </span>
      </header>

      {terminal ? (
        <>
          <section className="rm-inspector-callout">
            <Ic name="terminal" size={18} />
            <span>
              <strong>{terminal.exited ? 'Session ended' : 'Live shell'}</strong>
              <small>
                {terminal.exited ? 'Its output remains available.' : 'PTY state is preserved.'}
              </small>
            </span>
          </section>
          <dl>
            <dt>Host</dt>
            <dd>{host.label}</dd>
            <dt>Working directory</dt>
            <dd className="mono">{terminal.cwd || host.remoteWorkdir || '~'}</dd>
            <dt>Endpoint</dt>
            <dd className="mono">
              {host.username}@{host.host}:{host.port}
            </dd>
            <dt>Status</dt>
            <dd>{terminal.exited ? 'Ended' : 'Live'}</dd>
          </dl>
          <div className="rm-inspector-actions">
            {terminal.exited ? (
              <button className="btn primary" disabled={busy} onClick={() => void launch()}>
                Reconnect
              </button>
            ) : (
              <button className="btn primary" disabled={busy} onClick={() => void launch()}>
                New Session
              </button>
            )}
            <button className="btn" onClick={() => app.selectRemoteHost(host.id)}>
              Host Overview
            </button>
          </div>
        </>
      ) : (
        <>
          <section className="rm-inspector-callout">
            <Ic name="server" size={18} />
            <span>
              <strong className="rm-capitalize">{host.connection.state}</strong>
              <small>{host.connection.sessions} live SSH channels</small>
            </span>
          </section>
          <dl>
            <dt>Address</dt>
            <dd className="mono">{host.host}</dd>
            <dt>User</dt>
            <dd className="mono">{host.username}</dd>
            <dt>Port</dt>
            <dd className="mono">{host.port}</dd>
            <dt>Workspace</dt>
            <dd className="mono">{host.remoteWorkdir ?? '~'}</dd>
          </dl>
          <div className="rm-inspector-actions">
            <button className="btn primary" disabled={busy} onClick={() => void launch()}>
              <Ic name="terminal" size={12} />
              {busy
                ? 'Opening…'
                : host.connection.state === 'connected'
                  ? 'New Session'
                  : 'Connect'}
            </button>
            <button className="btn" onClick={() => app.setRemoteSubview('files')}>
              Files
            </button>
            <button className="btn" onClick={() => app.setRemoteSubview('forwards')}>
              Forwards
            </button>
            {host.connection.state === 'connected' ? (
              <button className="btn danger" onClick={() => void disconnect(host.id)}>
                Disconnect
              </button>
            ) : null}
          </div>
        </>
      )}
      <footer>
        Remote context remains visible while you switch between sessions and host tools.
      </footer>
    </aside>
  );
}
