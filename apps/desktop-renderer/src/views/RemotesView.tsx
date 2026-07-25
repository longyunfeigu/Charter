import React, { useEffect, useState } from 'react';
import type { SshConfigCandidate, SshHostDto, SshHostInput } from '@pi-ide/ipc-contracts';
import { useAppStore } from '../store/appStore.js';
import { forwardKey, useSshStore } from '../store/sshStore.js';
import { useTerminalStore } from './TerminalPanel.js';
import { Ic } from './home-icons.js';
import { RemoteHostDialog } from './RemoteHostDialog.js';
import { ForwardsDialog } from './ForwardsDialog.js';
import { SftpPanel } from './SftpPanel.js';
import { focusRemoteSession, openRemoteSession } from './remote-session.js';

/** The trailing path segment of an identity file, for the auth badge. */
function baseName(path: string | null): string {
  if (!path) return '';
  return (
    path
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? ''
  );
}

/** Coarse "x ago" for the last-connected line; exact time isn't important here. */
function relativeTime(iso: string | null): string {
  if (!iso) return 'never connected';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'never connected';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'last: just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `last: ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `last: ${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `last: ${days}d ago`;
  return `last: ${new Date(then).toLocaleDateString()}`;
}

function authLabel(host: SshHostDto): string {
  if (host.auth === 'agent') return 'agent';
  if (host.auth === 'key') {
    const file = baseName(host.identityFile);
    return file ? `key · ${file}` : 'key';
  }
  return host.hasPassword ? 'password · keychain' : 'password';
}

/** Import preview: choose ~/.ssh/config entries to add to the host book. */
export function ImportPanel(props: {
  candidates: SshConfigCandidate[];
  onClose: () => void;
}): React.JSX.Element {
  const { candidates, onClose } = props;
  const applyImport = useSshStore((s) => s.applyImport);
  const [picked, setPicked] = useState<Set<number>>(
    () => new Set(candidates.map((c, i) => (c.alreadyImported ? -1 : i)).filter((i) => i >= 0)),
  );
  const [usernames, setUsernames] = useState<string[]>(() =>
    candidates.map((c) => c.username ?? ''),
  );
  const [busy, setBusy] = useState(false);

  const toggle = (i: number): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const selected = [...picked];
  const missingUser = selected.some((i) => (usernames[i] ?? '').trim().length === 0);
  const ready = selected.length > 0 && !missingUser && !busy;

  const apply = async (): Promise<void> => {
    setBusy(true);
    const hosts: SshHostInput[] = selected.flatMap((i) => {
      const c = candidates[i];
      if (!c) return [];
      return [
        {
          label: c.alias,
          host: c.host,
          port: c.port,
          username: (usernames[i] ?? '').trim(),
          auth: c.identityFile ? ('key' as const) : ('agent' as const),
          identityFile: c.identityFile,
          proxyJump: c.proxyJump,
          tags: [],
          remoteWorkdir: null,
        },
      ];
    });
    const added = await applyImport(hosts);
    useAppStore.getState().pushToast('info', `Imported ${added} host${added === 1 ? '' : 's'}.`);
    setBusy(false);
    onClose();
  };

  return (
    <div className="rm-backdrop" role="dialog" aria-label="Import SSH hosts">
      <div className="rm-dialog wide">
        <div className="rm-dialog-head">
          <h2>Import from ~/.ssh/config</h2>
          <button className="rm-icon-btn" aria-label="Close" onClick={onClose}>
            <Ic name="x" size={15} />
          </button>
        </div>
        <div className="rm-dialog-body">
          {candidates.length === 0 ? (
            <p className="rm-hint">No hosts found in ~/.ssh/config.</p>
          ) : (
            <>
              <p className="rm-hint">
                Keys and ProxyJump are mapped automatically. Fill a username where your config omits
                one.
              </p>
              <div className="rm-imp-list">
                {candidates.map((c, i) => (
                  <div
                    className={`rm-imp-row${c.alreadyImported ? ' dim' : ''}`}
                    key={`${c.alias}-${i}`}
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(i)}
                      aria-label={`Select ${c.alias}`}
                      onChange={() => toggle(i)}
                    />
                    <div>
                      <strong>
                        {c.alias}
                        {c.alreadyImported ? ' · already imported' : ''}
                      </strong>
                      <small>
                        {c.host}:{c.port}
                        {c.proxyJump ? ` · jump ${c.proxyJump}` : ''}
                        {c.identityFile ? ` · ${baseName(c.identityFile)}` : ''}
                      </small>
                    </div>
                    <input
                      className={`rm-imp-user${(usernames[i] ?? '').trim() ? '' : ' missing'}`}
                      placeholder="username"
                      value={usernames[i] ?? ''}
                      onChange={(e) =>
                        setUsernames((prev) => {
                          const next = [...prev];
                          next[i] = e.target.value;
                          return next;
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="rm-dialog-foot">
          {missingUser ? (
            <span className="rm-spacer rm-error-line">Some selected hosts need a username.</span>
          ) : null}
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ready} onClick={() => void apply()}>
            {busy ? 'Importing…' : `Import ${selected.length || ''}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The main surface for the host selected in Remote Explorer. */
export function RemotesView(): React.JSX.Element {
  const app = useAppStore();
  const hosts = useSshStore((s) => s.hosts);
  const loaded = useSshStore((s) => s.loaded);
  const importConfig = useSshStore((s) => s.importConfig);
  const disconnect = useSshStore((s) => s.disconnect);
  const deleteHost = useSshStore((s) => s.deleteHost);
  const forwardStates = useSshStore((s) => s.forwardStates);
  const terminals = useTerminalStore((s) => s.items);
  const [dialog, setDialog] = useState<{ mode: 'create' | 'edit'; host?: SshHostDto } | null>(null);
  const [importState, setImportState] = useState<
    { status: 'loading' } | { status: 'open'; candidates: SshConfigCandidate[] } | null
  >(null);
  const [busy, setBusy] = useState<'open' | 'disconnect' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    useSshStore.getState().init();
  }, []);

  useEffect(() => {
    if (!loaded || hosts.length === 0) return;
    if (!hosts.some((host) => host.id === app.remoteSelectedHostId)) {
      const connected = hosts.find((host) => host.connection.state !== 'disconnected');
      app.selectRemoteHost((connected ?? hosts[0]!).id);
    }
  }, [app, hosts, loaded]);

  const host = hosts.find((candidate) => candidate.id === app.remoteSelectedHostId) ?? null;

  const openImport = async (): Promise<void> => {
    setImportState({ status: 'loading' });
    const candidates = await importConfig();
    setImportState({ status: 'open', candidates });
  };

  const launch = async (): Promise<void> => {
    if (!host) return;
    setBusy('open');
    await openRemoteSession(host.id);
    setBusy(null);
  };

  const remove = async (): Promise<void> => {
    if (!host) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      window.setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    await deleteHost(host.id);
    setConfirmDelete(false);
  };

  const dialogs = (
    <>
      {dialog ? (
        <RemoteHostDialog mode={dialog.mode} host={dialog.host} onClose={() => setDialog(null)} />
      ) : null}
      {importState?.status === 'open' ? (
        <ImportPanel candidates={importState.candidates} onClose={() => setImportState(null)} />
      ) : null}
    </>
  );

  if (!loaded || (hosts.length > 0 && !host)) {
    return (
      <div className="rm-page" data-testid="remotes-view">
        <div className="rm-host-loading">
          <span className="rm-dot connecting" /> Loading Remote Explorer…
        </div>
      </div>
    );
  }

  if (!host) {
    return (
      <div className="rm-page" data-testid="remotes-view">
        <div className="rm-empty rm-empty-hosts">
          <Ic name="server" size={28} />
          <strong>No remote hosts yet</strong>
          <p>Add an SSH host or import the hosts already defined in ~/.ssh/config.</p>
          <div className="rm-actions">
            <button className="btn primary" onClick={() => setDialog({ mode: 'create' })}>
              New Host
            </button>
            <button
              className="btn"
              onClick={() => void openImport()}
              disabled={importState?.status === 'loading'}
            >
              {importState?.status === 'loading' ? 'Scanning…' : 'Import SSH Config'}
            </button>
          </div>
        </div>
        {dialogs}
      </div>
    );
  }

  const state = host.connection.state;
  const connected = state === 'connected';
  const pending = state === 'connecting' || state === 'reconnecting';
  const sessions = terminals.filter(
    (terminal) => terminal.remote?.hostId === host.id && !terminal.hidden && !terminal.exited,
  );
  const activeForwards = host.forwards.filter((forward) => {
    const current = forwardStates[forwardKey(host.id, forward.id)];
    return current !== undefined && current.status !== 'stopped';
  });

  const subviewTitle =
    app.remoteSubview === 'overview'
      ? 'Overview'
      : app.remoteSubview === 'files'
        ? 'Files'
        : 'Forwards';

  return (
    <div className="rm-page" data-testid="remotes-view">
      <header className="rm-context-head">
        <div className="rm-breadcrumb">
          <span>Remote</span>
          <Ic name="chevron" size={10} />
          <strong>{host.label}</strong>
          <Ic name="chevron" size={10} />
          <span>{subviewTitle}</span>
        </div>
        <nav aria-label="Remote host views">
          {(['overview', 'files', 'forwards'] as const).map((view) => (
            <button
              key={view}
              className={app.remoteSubview === view ? 'active' : ''}
              data-testid={`remote-tab-${view}`}
              onClick={() => app.setRemoteSubview(view)}
            >
              {view === 'overview' ? 'Overview' : view === 'files' ? 'Files' : 'Forwards'}
              {view === 'forwards' && activeForwards.length > 0
                ? ` · ${activeForwards.length}`
                : ''}
            </button>
          ))}
        </nav>
      </header>

      {app.remoteSubview === 'files' ? (
        <div className="rm-subview rm-files-subview">
          <SftpPanel host={host} onBack={() => app.setRemoteSubview('overview')} />
        </div>
      ) : app.remoteSubview === 'forwards' ? (
        <div className="rm-subview">
          <ForwardsDialog host={host} embedded />
        </div>
      ) : (
        <div className="rm-overview" data-testid={`rm-host-overview-${host.id}`}>
          <section className="rm-overview-hero">
            <div className="rm-host-mark">
              <Ic name="server" size={24} />
              <span className={`rm-dot ${state}`} />
            </div>
            <div className="rm-overview-title">
              <span className="rm-eyebrow">Selected host</span>
              <h1>{host.label}</h1>
              <p>
                {host.username}@{host.host}:{host.port}
              </p>
              <div className="rm-badges">
                <span className="rm-badge auth">{authLabel(host)}</span>
                {host.tags.map((tag) => (
                  <span className="rm-badge tag" key={tag}>
                    {tag}
                  </span>
                ))}
                {host.proxyJump ? (
                  <span className="rm-badge jump">via {host.proxyJump}</span>
                ) : null}
              </div>
            </div>
            <div className="rm-overview-actions">
              <button
                className="btn primary"
                data-testid={connected ? `rm-new-session-${host.id}` : `rm-connect-${host.id}`}
                disabled={busy !== null || pending}
                onClick={() => void launch()}
              >
                <Ic name="terminal" size={13} />
                {pending
                  ? 'Connecting…'
                  : busy === 'open'
                    ? 'Opening…'
                    : connected
                      ? 'New Session'
                      : 'Connect'}
              </button>
              <button className="btn" onClick={() => setDialog({ mode: 'edit', host })}>
                <Ic name="pencil" size={13} /> Edit
              </button>
              {connected ? (
                <button
                  className="btn danger"
                  data-testid={`rm-disconnect-${host.id}`}
                  disabled={busy === 'disconnect'}
                  onClick={() => {
                    setBusy('disconnect');
                    void disconnect(host.id).finally(() => setBusy(null));
                  }}
                >
                  Disconnect
                </button>
              ) : (
                <button className="btn danger" onClick={() => void remove()}>
                  {confirmDelete ? 'Confirm delete' : 'Delete'}
                </button>
              )}
            </div>
          </section>

          {host.connection.error ? <div className="rm-error">{host.connection.error}</div> : null}

          <section className="rm-overview-grid">
            <article className="rm-info-card">
              <span className="rm-eyebrow">Connection</span>
              <strong className="rm-capitalize">{state}</strong>
              <p>
                {connected
                  ? `${sessions.filter((session) => !session.exited).length} live sessions`
                  : relativeTime(host.lastConnectedAt)}
              </p>
            </article>
            <article className="rm-info-card">
              <span className="rm-eyebrow">Remote workspace</span>
              <strong className="rm-mono">{host.remoteWorkdir ?? '~'}</strong>
              <p>{host.proxyJump ? `ProxyJump ${host.proxyJump}` : 'Direct SSH connection'}</p>
            </article>
            <button
              className="rm-info-card actionable"
              data-testid={`rm-files-${host.id}`}
              onClick={() => app.setRemoteSubview('files')}
            >
              <span className="rm-eyebrow">SFTP</span>
              <strong>Browse Files</strong>
              <p>Local and remote file transfer</p>
            </button>
            <button
              className="rm-info-card actionable"
              data-testid={`rm-forwards-${host.id}`}
              onClick={() => app.setRemoteSubview('forwards')}
            >
              <span className="rm-eyebrow">Port forwarding</span>
              <strong>{activeForwards.length} active</strong>
              <p>{host.forwards.length} saved tunnels</p>
            </button>
          </section>

          <section className="rm-overview-sessions">
            <div className="rm-section-head">
              <span>
                <span className="rm-eyebrow">On this host</span>
                <strong>Sessions</strong>
              </span>
              <button className="btn sm" disabled={busy !== null} onClick={() => void launch()}>
                <Ic name="plus" size={12} /> New Session
              </button>
            </div>
            {sessions.length === 0 ? (
              <div className="rm-session-empty">
                No sessions yet. Connect to open a shell on {host.label}.
              </div>
            ) : (
              <div className="rm-session-list">
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    data-testid={`rm-overview-session-${session.id}`}
                    onClick={() => focusRemoteSession(session.id, host.id)}
                  >
                    <span className="rm-dot connected" />
                    <Ic name="terminal" size={13} />
                    <span>
                      <strong>{session.title}</strong>
                      <small>{session.cwd || host.remoteWorkdir || '~'}</small>
                    </span>
                    <em>Live</em>
                    <Ic name="chevron" size={11} />
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      {dialogs}
    </div>
  );
}
