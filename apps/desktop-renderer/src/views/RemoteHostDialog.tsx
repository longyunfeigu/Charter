import React, { useEffect, useRef, useState } from 'react';
import type { SshHostDto, SshHostInput } from '@pi-ide/ipc-contracts';
import { useSshStore } from '../store/sshStore.js';
import { Ic } from './home-icons.js';

type AuthMethod = SshHostDto['auth'];

const AUTH_METHODS: { value: AuthMethod; label: string }[] = [
  { value: 'agent', label: 'Agent' },
  { value: 'key', label: 'Key' },
  { value: 'password', label: 'Password' },
];

/**
 * Create or edit a saved SSH host. Non-sensitive fields go through saveHost;
 * passwords / passphrases are pushed separately via setSecret and are NEVER
 * read back — an edit only ever shows "saved · clear", never the value.
 */
export function RemoteHostDialog(props: {
  mode: 'create' | 'edit';
  host?: SshHostDto;
  onClose: () => void;
  onSaved?: (host: SshHostDto) => void;
}): React.JSX.Element {
  const { mode, host, onClose, onSaved } = props;
  const saveHost = useSshStore((s) => s.saveHost);
  const setSecret = useSshStore((s) => s.setSecret);
  const clearSecret = useSshStore((s) => s.clearSecret);

  const [label, setLabel] = useState(host?.label ?? '');
  const [hostname, setHostname] = useState(host?.host ?? '');
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? '');
  const [auth, setAuth] = useState<AuthMethod>(host?.auth ?? 'agent');
  const [identityFile, setIdentityFile] = useState(host?.identityFile ?? '');
  const [remoteWorkdir, setRemoteWorkdir] = useState(host?.remoteWorkdir ?? '');
  const [proxyJump, setProxyJump] = useState(host?.proxyJump ?? '');
  const [tags, setTags] = useState((host?.tags ?? []).join(', '));
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  // Reflect keychain state locally so "Clear" flips the row without a reload.
  const [hasPassword, setHasPassword] = useState(host?.hasPassword ?? false);
  const [hasPassphrase, setHasPassphrase] = useState(host?.hasPassphrase ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  useEffect(
    () => () => {
      returnFocus.current?.focus();
    },
    [],
  );

  const portNum = Number(port);
  const portValid = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const ready = hostname.trim().length > 0 && username.trim().length > 0 && portValid && !busy;

  const submit = async (): Promise<void> => {
    if (!ready) {
      setError('Fill host and username, with a port between 1 and 65535.');
      return;
    }
    setBusy(true);
    setError(null);
    const input: SshHostInput = {
      ...(host ? { id: host.id } : {}),
      label: label.trim() || hostname.trim(),
      host: hostname.trim(),
      port: portNum,
      username: username.trim(),
      auth,
      identityFile: auth === 'key' ? identityFile.trim() || null : null,
      remoteWorkdir: remoteWorkdir.trim() || null,
      proxyJump: proxyJump.trim() || null,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 8),
    };
    const saved = await saveHost(input);
    if (!saved) {
      setBusy(false);
      setError('Could not save this host. Check the fields and try again.');
      return;
    }
    // Secrets ride a second, main-only channel — only when the user typed one.
    if (auth === 'password' && password.trim()) {
      await setSecret(saved.id, 'password', password);
    }
    if (auth === 'key' && passphrase.trim()) {
      await setSecret(saved.id, 'passphrase', passphrase);
    }
    setBusy(false);
    onSaved?.(saved);
    onClose();
  };

  const clear = async (kind: 'password' | 'passphrase'): Promise<void> => {
    if (!host) return;
    const ok = await clearSecret(host.id, kind);
    if (ok && kind === 'password') setHasPassword(false);
    if (ok && kind === 'passphrase') setHasPassphrase(false);
  };

  return (
    <div
      className="rm-backdrop"
      role="dialog"
      aria-label={mode === 'edit' ? 'Edit host' : 'New host'}
      data-testid="rm-dialog"
    >
      <div className="rm-dialog">
        <div className="rm-dialog-head">
          <h2>{mode === 'edit' ? 'Edit host' : 'New host'}</h2>
          <button className="rm-icon-btn" aria-label="Close" onClick={onClose}>
            <Ic name="x" size={15} />
          </button>
        </div>

        <div className="rm-dialog-body">
          <div className="rm-field">
            <label>{mode === 'create' ? 'Name (optional)' : 'Name'}</label>
            <input
              type="text"
              value={label}
              autoFocus
              placeholder="prod-api-01"
              data-testid="rm-field-label"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className="rm-row">
            <div className="rm-field" style={{ flex: 2 }}>
              <label>Host</label>
              <input
                type="text"
                className="mono"
                value={hostname}
                placeholder="10.0.4.21"
                data-testid="rm-field-host"
                onChange={(e) => setHostname(e.target.value)}
              />
            </div>
            <div className="rm-field" style={{ flex: 1 }}>
              <label>Port</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                data-testid="rm-field-port"
                onChange={(e) => setPort(e.target.value)}
              />
            </div>
          </div>

          <div className="rm-field">
            <label>Username</label>
            <input
              type="text"
              className="mono"
              value={username}
              placeholder="edy"
              data-testid="rm-field-username"
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="rm-field">
            <label>Authentication</label>
            <div className="rm-seg" role="radiogroup" aria-label="Authentication method">
              {AUTH_METHODS.map((m) => (
                <button
                  key={m.value}
                  className={auth === m.value ? 'on' : ''}
                  role="radio"
                  aria-checked={auth === m.value}
                  data-testid={`rm-auth-${m.value}`}
                  onClick={() => setAuth(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {auth === 'key' ? (
            <>
              <div className="rm-field">
                <label>Identity file</label>
                <input
                  type="text"
                  className="mono"
                  value={identityFile}
                  placeholder="~/.ssh/id_ed25519"
                  onChange={(e) => setIdentityFile(e.target.value)}
                />
              </div>
              {mode === 'edit' && hasPassphrase ? (
                <div className="rm-secret-saved">
                  <Ic name="shield" size={13} />
                  <span>
                    Passphrase <b>saved</b> to keychain
                  </span>
                  <button className="btn sm" onClick={() => void clear('passphrase')}>
                    Clear
                  </button>
                </div>
              ) : (
                <div className="rm-field">
                  <label>Key passphrase (optional)</label>
                  <input
                    type="password"
                    value={passphrase}
                    placeholder="stored in system keychain"
                    autoComplete="off"
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                  <span className="rm-hint">
                    Only needed for an encrypted key. Saved to the OS keychain.
                  </span>
                </div>
              )}
            </>
          ) : null}

          {auth === 'password' ? (
            mode === 'edit' && hasPassword ? (
              <div className="rm-secret-saved">
                <Ic name="shield" size={13} />
                <span>
                  Password <b>saved</b> to keychain
                </span>
                <button className="btn sm" onClick={() => void clear('password')}>
                  Clear
                </button>
              </div>
            ) : (
              <div className="rm-field">
                <label>Password</label>
                <input
                  type="password"
                  value={password}
                  placeholder="stored in system keychain"
                  autoComplete="off"
                  data-testid="rm-field-password"
                  onChange={(e) => setPassword(e.target.value)}
                />
                <span className="rm-hint">
                  Saved to the OS keychain — never written to settings or shown again.
                </span>
              </div>
            )
          ) : null}

          <div className="rm-field">
            <label>Remote working directory (optional)</label>
            <input
              type="text"
              className="mono"
              value={remoteWorkdir}
              placeholder="/srv/api"
              onChange={(e) => setRemoteWorkdir(e.target.value)}
            />
          </div>

          <div className="rm-field">
            <label>Tags (optional)</label>
            <input
              type="text"
              value={tags}
              placeholder="prod, api"
              onChange={(e) => setTags(e.target.value)}
            />
          </div>

          <div className="rm-field">
            <label>ProxyJump (optional)</label>
            <input
              type="text"
              className="mono"
              value={proxyJump}
              placeholder="bastion"
              onChange={(e) => setProxyJump(e.target.value)}
            />
            <span className="rm-hint">
              Single hop. Use a saved host&apos;s name, or <code>user@host:port</code>.
            </span>
          </div>

          {error ? <div className="rm-error-line">{error}</div> : null}
        </div>

        <div className="rm-dialog-foot">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!ready}
            data-testid="rm-dialog-submit"
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : mode === 'edit' ? 'Save' : 'Add host'}
          </button>
        </div>
      </div>
    </div>
  );
}
