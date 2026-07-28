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
  if (!iso) return 'Never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'Never';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'Just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
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
  const stateLabel = connected
    ? 'Connected'
    : pending
      ? state === 'reconnecting'
        ? 'Reconnecting'
        : 'Connecting'
      : 'Disconnected';

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
          <section className={`rm-overview-hero is-${state}`}>
            <div className="rm-host-mark">
              <Ic name="server" size={24} />
            </div>
            <div className="rm-overview-title">
              <div className="rm-overview-kicker">
                <span className="rm-eyebrow">Remote host</span>
                <span className={`rm-status-pill ${state}`}>
                  <span className={`rm-dot ${state}`} />
                  {stateLabel}
                </span>
              </div>
              <h1 data-testid="rm-overview-hostname">{host.label}</h1>
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
              {connected ? (
                <button
                  className="btn rm-disconnect"
                  data-testid={`rm-disconnect-${host.id}`}
                  disabled={busy === 'disconnect'}
                  onClick={() => {
                    setBusy('disconnect');
                    void disconnect(host.id).finally(() => setBusy(null));
                  }}
                >
                  {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                </button>
              ) : null}
              <details className="rm-host-menu">
                <summary aria-label="Host actions" title="Host actions">
                  <span aria-hidden="true">•••</span>
                </summary>
                <div role="menu">
                  <button role="menuitem" onClick={() => setDialog({ mode: 'edit', host })}>
                    <Ic name="pencil" size={13} /> Edit connection
                  </button>
                  <button
                    role="menuitem"
                    className={confirmDelete ? 'confirming' : 'danger'}
                    onClick={() => void remove()}
                  >
                    <Ic name={confirmDelete ? 'check' : 'trash'} size={13} />
                    {confirmDelete ? 'Confirm delete' : 'Delete host'}
                  </button>
                </div>
              </details>
            </div>
          </section>

          {host.connection.error ? <div className="rm-error">{host.connection.error}</div> : null}

          <section
            className={`rm-connection-stage ${connected ? 'connected' : pending ? 'pending' : 'disconnected'}`}
            data-testid="rm-connection-stage"
          >
            <div className="rm-stage-message">
              <span className="rm-stage-icon">
                <Ic name={connected ? 'checkCircle' : pending ? 'refresh' : 'terminal'} size={19} />
              </span>
              <span>
                <span className="rm-eyebrow">Connection</span>
                <strong>
                  {connected
                    ? 'Connection ready'
                    : pending
                      ? 'Establishing a secure connection'
                      : 'Ready when you are'}
                </strong>
                <p>
                  {connected
                    ? 'This SSH transport is ready for persistent shells, files and tunnels.'
                    : pending
                      ? 'Charter is verifying the host and preparing your remote workspace.'
                      : `Connect to open a persistent shell on ${host.label}. Your saved credentials are ready.`}
                </p>
              </span>
            </div>
            <dl className="rm-stage-facts">
              <div>
                <dt>{connected ? 'Live sessions' : 'Credential'}</dt>
                <dd>{connected ? sessions.length : authLabel(host)}</dd>
              </div>
              <div>
                <dt>Workspace</dt>
                <dd className="rm-mono">{host.remoteWorkdir ?? '~'}</dd>
              </div>
              <div>
                <dt>{connected ? 'Active forwards' : 'Last connected'}</dt>
                <dd>{connected ? activeForwards.length : relativeTime(host.lastConnectedAt)}</dd>
              </div>
            </dl>
          </section>

          <section className="rm-overview-sessions">
            <div className="rm-section-head">
              <span className="rm-section-title">
                <span className="rm-eyebrow">On this host</span>
                <span>
                  <strong>Sessions</strong>
                  <small>
                    {connected
                      ? 'Persistent shells on this SSH connection'
                      : 'Connect before opening a remote shell'}
                  </small>
                </span>
              </span>
            </div>
            {sessions.length === 0 ? (
              <div className="rm-session-empty" data-testid="rm-session-empty">
                <span className="rm-session-empty-icon">
                  <Ic name="terminal" size={18} />
                </span>
                <strong>No remote sessions</strong>
                <p>
                  {connected
                    ? 'Open a shell to start working on this host.'
                    : `Use Connect above to start a shell on ${host.label}.`}
                </p>
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
