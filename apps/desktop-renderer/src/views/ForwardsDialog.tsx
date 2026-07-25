import React, { useState } from 'react';
import type { SshForwardRecord, SshHostDto } from '@pi-ide/ipc-contracts';
import { forwardKey, useSshStore } from '../store/sshStore.js';
import { Ic } from './home-icons.js';

/** Numeric port field parse: '' → null, otherwise clamp to int. */
function parsePort(value: string): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function ForwardRow(props: {
  host: SshHostDto;
  forward: SshForwardRecord;
  onError: (message: string) => void;
}): React.JSX.Element {
  const { host, forward, onError } = props;
  const state = useSshStore((s) => s.forwardStates[forwardKey(host.id, forward.id)]);
  const startForward = useSshStore((s) => s.startForward);
  const stopForward = useSshStore((s) => s.stopForward);
  const deleteForward = useSshStore((s) => s.deleteForward);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const active = state !== undefined && state.status !== 'stopped';

  const toggle = async (): Promise<void> => {
    setBusy(true);
    onError('');
    if (active) {
      await stopForward(host.id, forward.id);
    } else {
      const err = await startForward(host.id, forward.id);
      if (err) onError(err);
    }
    setBusy(false);
  };

  return (
    <div className={`fwd-row${active ? ' live' : ''}`} data-testid={`fwd-row-${forward.id}`}>
      <span
        className={`rm-dot ${state?.status === 'error' ? 'reconnecting' : active ? 'connected' : ''}`}
        title={state?.status ?? 'stopped'}
      />
      <div className="fwd-route">
        <b>
          {forward.bindHost}:{forward.bindPort}
          <span className="fwd-arr"> → {host.label} → </span>
          {forward.targetHost}:{forward.targetPort}
        </b>
        <small className={active && state?.status !== 'error' ? 'live' : ''}>
          {active
            ? state?.status === 'error'
              ? (state.error ?? 'error')
              : `active · ${state?.connections ?? 0} connection${(state?.connections ?? 0) === 1 ? '' : 's'}`
            : 'stopped'}
        </small>
      </div>
      <button
        className={`btn sm${active ? '' : ' primary'}`}
        disabled={busy}
        data-testid={`fwd-toggle-${forward.id}`}
        onClick={() => void toggle()}
      >
        {busy ? '…' : active ? 'Stop' : 'Start'}
      </button>
      <button
        className="rm-icon-btn danger"
        title={confirmDelete ? 'Click again to delete' : 'Delete forward'}
        aria-label="Delete forward"
        onClick={() => {
          if (!confirmDelete) {
            setConfirmDelete(true);
            window.setTimeout(() => setConfirmDelete(false), 3000);
            return;
          }
          void deleteForward(host.id, forward.id);
        }}
      >
        <Ic name={confirmDelete ? 'check' : 'trash'} size={13} />
      </button>
    </div>
  );
}

/**
 * Port-forward manager for one host (PR3, tunnel-diagram redesign). Local (-L)
 * forwards only: the composer draws local port → host → target as one editable
 * tunnel, so the direction explains itself. Forwards are saved on the host
 * record; start/stop is runtime state.
 */
export function ForwardsDialog(props: {
  host: SshHostDto;
  onClose?: () => void;
  embedded?: boolean;
}): React.JSX.Element {
  const { host, onClose, embedded = false } = props;
  const live = useSshStore((s) => s.hosts.find((h) => h.id === host.id)) ?? host;
  const saveForward = useSshStore((s) => s.saveForward);
  const startForward = useSshStore((s) => s.startForward);

  const [error, setError] = useState('');
  const [bindPort, setBindPort] = useState('');
  const [targetHost, setTargetHost] = useState('127.0.0.1');
  const [targetPort, setTargetPort] = useState('');
  const [startNow, setStartNow] = useState(true);
  const [busy, setBusy] = useState(false);

  const bind = parsePort(bindPort);
  const target = parsePort(targetPort);
  const ready = bind !== null && target !== null && targetHost.trim().length > 0 && !busy;

  const add = async (): Promise<void> => {
    if (bind === null || target === null) return;
    setBusy(true);
    setError('');
    const record = await saveForward(host.id, {
      bindHost: '127.0.0.1',
      bindPort: bind,
      targetHost: targetHost.trim(),
      targetPort: target,
    });
    if (!record) {
      setError('Could not save the forward.');
      setBusy(false);
      return;
    }
    if (startNow) {
      const err = await startForward(host.id, record.id);
      if (err) setError(err);
    }
    setBindPort('');
    setTargetPort('');
    setBusy(false);
  };

  return (
    <div
      className={embedded ? 'rm-forwards-embedded' : 'rm-backdrop'}
      role={embedded ? 'region' : 'dialog'}
      aria-label={`Port forwards for ${host.label}`}
    >
      <div className={embedded ? 'rm-forwards-surface' : 'rm-dialog wide'} data-testid="fwd-dialog">
        <div className="rm-dialog-head">
          <h2>
            Forwards
            <span className="fwd-head-addr">
              {host.label} · {host.username}@{host.host}
            </span>
          </h2>
          {onClose ? (
            <button className="rm-icon-btn" aria-label="Close" onClick={onClose}>
              <Ic name="x" size={15} />
            </button>
          ) : null}
        </div>
        <div className="rm-dialog-body">
          {live.forwards.length === 0 ? (
            <div className="fwd-empty">
              <div className="fwd-empty-diagram" aria-hidden="true">
                <span className="fwd-node">This Mac :8080</span>
                <span className="fwd-dash">╌╌▶</span>
                <span className="fwd-node">{host.label}</span>
                <span className="fwd-dash">╌╌▶</span>
                <span className="fwd-node">127.0.0.1:80</span>
              </div>
              <p>
                Map a remote service to a local port — reach a database or dashboard that only
                listens on the server. Active forwards keep the connection alive.
              </p>
            </div>
          ) : (
            <div className="fwd-list">
              {live.forwards.map((f) => (
                <ForwardRow key={f.id} host={live} forward={f} onError={setError} />
              ))}
            </div>
          )}

          <div className="fwd-tunnel">
            <div className="fwd-endpoint">
              <span className="fwd-ep-who">
                <span className="rm-dot" />
                This Mac
              </span>
              <div className="fwd-addr-line">
                <span className="fixed">127.0.0.1 :</span>
                <input
                  className="port"
                  inputMode="numeric"
                  placeholder="8080"
                  value={bindPort}
                  aria-label="Local port"
                  data-testid="fwd-field-bindport"
                  onChange={(e) => setBindPort(e.target.value)}
                />
              </div>
              <small>Local listen port</small>
            </div>
            <div className="fwd-via" aria-hidden="true">
              <div className="fwd-pipe">
                <span className="fwd-line" />
                <span className="fwd-hostchip" title={host.label}>
                  ⚿ {host.label}
                </span>
                <span className="fwd-line" />
                <span className="fwd-arrowhead">▶</span>
              </div>
              <small>ssh tunnel</small>
            </div>
            <div className="fwd-endpoint remote">
              <span className="fwd-ep-who">
                <span className="rm-dot connected" />
                From {host.label}
              </span>
              <div className="fwd-addr-line">
                <input
                  value={targetHost}
                  aria-label="Target host"
                  data-testid="fwd-field-targethost"
                  onChange={(e) => setTargetHost(e.target.value)}
                />
                <span className="fixed">:</span>
                <input
                  className="port"
                  inputMode="numeric"
                  placeholder="80"
                  value={targetPort}
                  aria-label="Target port"
                  data-testid="fwd-field-targetport"
                  onChange={(e) => setTargetPort(e.target.value)}
                />
              </div>
              <small>Target host and port, as seen from the server</small>
            </div>
          </div>

          <div className="fwd-composer-foot">
            <label className="fwd-switch">
              <input
                type="checkbox"
                checked={startNow}
                onChange={(e) => setStartNow(e.target.checked)}
              />
              <span className="track" aria-hidden="true" />
              Start immediately
            </label>
            <button
              className="btn primary"
              disabled={!ready}
              data-testid="fwd-add"
              onClick={() => void add()}
            >
              {busy ? 'Adding…' : 'Add Forward'}
            </button>
          </div>

          {error ? <div className="rm-error">{error}</div> : null}
        </div>
        {onClose ? (
          <div className="rm-dialog-foot">
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
