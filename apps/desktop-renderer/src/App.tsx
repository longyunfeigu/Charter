import React, { useEffect, useState } from 'react';
import type { AppInfoDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from './bridge.js';

/** Milestone-1 shell: proves the isolated renderer ↔ typed IPC pipeline end to end.
 * Replaced by the full IDE workbench in Milestone 2/3. */
export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfoDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void rpcResult('app.getInfo', {}).then((res) => {
      if (res.ok) setInfo(res.data);
      else setError(`${res.error.code}: ${res.error.userMessage}`);
    });
  }, []);

  return (
    <div className="m1-shell" data-testid="app-shell">
      <h1>Pi IDE</h1>
      <p>Engineering baseline (Milestone 1)</p>
      {error ? <p role="alert">{error}</p> : null}
      {info ? (
        <dl data-testid="app-info">
          <dt>App</dt>
          <dd data-testid="app-version">{info.appVersion}</dd>
          <dt>Electron</dt>
          <dd>{info.electron}</dd>
          <dt>Node</dt>
          <dd>{info.node}</dd>
          <dt>Platform</dt>
          <dd>
            {info.platform}/{info.arch}
          </dd>
        </dl>
      ) : (
        <p data-testid="loading">Loading…</p>
      )}
    </div>
  );
}
