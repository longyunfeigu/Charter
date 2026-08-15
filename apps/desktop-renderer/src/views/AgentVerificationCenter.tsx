import React, { useEffect, useMemo, useState } from 'react';
import type {
  AgentVerificationAgent,
  AgentVerificationRun,
  AgentVerificationSnapshot,
  SshHostDto,
} from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useTerminalStore } from './TerminalPanel.js';
import { Ic } from './home-icons.js';

const LEVEL_COPY = {
  unverified: 'Not verified',
  source_verified: 'Source verified',
  integration_tested: 'Integration tested',
  locally_verified: 'Locally verified',
} as const;

const RUNNING = new Set<AgentVerificationRun['status']>(['pending', 'running', 'needs_user']);

function latestRun(
  agent: AgentVerificationAgent,
  mode: AgentVerificationRun['mode'],
): AgentVerificationRun | null {
  return agent.latestRuns.find((run) => run.mode === mode) ?? null;
}

function runCopy(run: AgentVerificationRun | null): string {
  if (!run) return 'Not run';
  if (run.status === 'needs_user') return 'Needs you in terminal';
  if (run.status === 'passed') return run.mode === 'image' ? 'Image passed' : 'Live check passed';
  if (run.status === 'running' || run.status === 'pending') return 'Checking…';
  if (run.status === 'timed_out') return 'Timed out';
  if (run.status === 'cancelled') return 'Stopped';
  return 'Check failed';
}

export function AgentVerificationCenter(): React.JSX.Element {
  const pushToast = useAppStore((state) => state.pushToast);
  const openTerminalSession = useAppStore((state) => state.openTerminalSession);
  const [snapshot, setSnapshot] = useState<AgentVerificationSnapshot | null>(null);
  const [hosts, setHosts] = useState<SshHostDto[]>([]);
  const [target, setTarget] = useState('local');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (refresh = false): Promise<void> => {
    const result = await rpcResult('agents.verification.scan', { refresh });
    if (!result.ok) {
      setError(result.error.userMessage);
      return;
    }
    setError(null);
    setSnapshot(result.data);
  };

  useEffect(() => {
    void load(false);
    void rpcResult('ssh.listHosts', {}).then((result) => {
      if (result.ok) setHosts(result.data.hosts);
    });
  }, []);

  const activeRunIds = useMemo(
    () =>
      snapshot?.agents.flatMap((agent) =>
        agent.latestRuns.filter((run) => RUNNING.has(run.status)).map((run) => run.id),
      ) ?? [],
    [snapshot],
  );

  useEffect(() => {
    if (activeRunIds.length === 0) return;
    const timer = window.setInterval(() => void load(false), 1_000);
    return () => window.clearInterval(timer);
  }, [activeRunIds.join('|')]);

  const selectedHostId = target.startsWith('ssh:') ? target.slice(4) : null;

  const startCore = async (agent: AgentVerificationAgent): Promise<void> => {
    const targetKind = selectedHostId ? ('ssh' as const) : ('local' as const);
    setBusy(`${agent.agentId}:core`);
    setError(null);
    const begun = await rpcResult('agents.verification.begin', {
      agentId: agent.agentId,
      mode: 'core',
      target: targetKind,
    });
    if (!begun.ok) {
      setBusy(null);
      setError(begun.error.userMessage);
      return;
    }
    const terminalId = await useTerminalStore.getState().create({
      launch: agent.agentId,
      initialPrompt: begun.data.prompt,
      ...(selectedHostId
        ? {
            target: {
              kind: 'ssh' as const,
              hostId: selectedHostId,
              workspaceKind: 'remote' as const,
            },
          }
        : { context: { kind: 'focused' as const } }),
      reveal: true,
      title: `${agent.displayName} · compatibility check`,
    });
    if (!terminalId) {
      await rpcResult('agents.verification.cancel', { runId: begun.data.run.id });
      setBusy(null);
      setError('Charter could not create the verification terminal.');
      return;
    }
    const attached = await rpcResult('agents.verification.attach', {
      runId: begun.data.run.id,
      terminalId,
    });
    setBusy(null);
    if (!attached.ok) {
      setError(attached.error.userMessage);
      return;
    }
    pushToast(
      'success',
      'Live check started. Complete login, trust or approval prompts in the visible terminal.',
    );
    await load(false);
  };

  const startImage = async (
    agent: AgentVerificationAgent,
    core: AgentVerificationRun,
  ): Promise<void> => {
    if (!core.terminalId) return;
    setBusy(`${agent.agentId}:image`);
    setError(null);
    const begun = await rpcResult('agents.verification.begin', {
      agentId: agent.agentId,
      mode: 'image',
      target: core.target,
    });
    if (!begun.ok) {
      setBusy(null);
      setError(begun.error.userMessage);
      return;
    }
    const attached = await rpcResult('agents.verification.attach', {
      runId: begun.data.run.id,
      terminalId: core.terminalId,
    });
    if (!attached.ok) {
      await rpcResult('agents.verification.cancel', { runId: begun.data.run.id });
      setBusy(null);
      setError(attached.error.userMessage);
      return;
    }
    const pasted = await rpcResult('terminal.pasteClipboardImage', { id: core.terminalId });
    if (!pasted.ok) {
      await rpcResult('agents.verification.cancel', { runId: begun.data.run.id });
      setBusy(null);
      setError(pasted.error.userMessage);
      return;
    }
    const delivered = useTerminalStore.getState().write(core.terminalId, ` ${begun.data.prompt}\r`);
    if (!delivered) {
      await rpcResult('agents.verification.cancel', { runId: begun.data.run.id });
      setBusy(null);
      setError('The verification terminal is no longer accepting input.');
      return;
    }
    setBusy(null);
    pushToast('success', 'Image check sent to the existing Agent terminal.');
    await load(false);
  };

  const cancel = async (runId: string): Promise<void> => {
    setBusy(runId);
    const result = await rpcResult('agents.verification.cancel', { runId });
    setBusy(null);
    if (!result.ok) setError(result.error.userMessage);
    await load(false);
  };

  const exportReport = async (): Promise<void> => {
    setBusy('export');
    const result = await rpcResult('agents.verification.export', {});
    setBusy(null);
    if (!result.ok) {
      setError(result.error.userMessage);
      return;
    }
    if (result.data.markdownPath) {
      pushToast('success', 'Compatibility report exported as Markdown and JSON.');
    }
  };

  return (
    <div className="st-verification" data-testid="agent-verification-center">
      <div className="st-verification-head">
        <div>
          <div className="st-card-title">Agent Pack verification</div>
          <div className="st-card-sub">
            Free scan first. Live checks are explicit, visible, and may use one provider request.
          </div>
        </div>
        <span className="st-sp" />
        <select
          aria-label="Verification target"
          className="st-input st-verification-target"
          data-testid="agent-verification-target"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value="local">This Mac</option>
          {hosts.map((host) => (
            <option value={`ssh:${host.id}`} key={host.id}>
              SSH · {host.label}
            </option>
          ))}
        </select>
        <button className="btn" disabled={busy !== null} onClick={() => void load(true)}>
          Rescan
        </button>
        <button
          className="btn"
          data-testid="agent-verification-export"
          disabled={busy !== null || !snapshot}
          onClick={() => void exportReport()}
        >
          {busy === 'export' ? 'Exporting…' : 'Export report'}
        </button>
      </div>
      <div className="st-verification-levels">
        <span>Source verified · upstream contract reviewed</span>
        <span>Integration tested · Charter PTY/SSH contract passed</span>
        <span>Locally verified · your logged-in CLI answered a real challenge</span>
      </div>
      {error ? <div className="st-adapter-diagnostic error">{error}</div> : null}
      {!snapshot ? (
        <div className="st-pack-empty">Scanning Agent contracts…</div>
      ) : (
        <div className="st-verification-list">
          {snapshot.agents.map((agent) => {
            const core = latestRun(agent, 'core');
            const image = latestRun(agent, 'image');
            const coreActive = core ? RUNNING.has(core.status) : false;
            const imageSupported =
              agent.checks.find((check) => check.id === 'image_path')?.status !== 'unsupported';
            const targetAvailable = selectedHostId
              ? agent.checks.find((check) => check.id === 'ssh')?.status === 'available'
              : agent.installed;
            return (
              <div
                className="st-verification-agent"
                data-testid={`agent-verification-${agent.agentId}`}
                key={agent.agentId}
              >
                <div className="st-verification-agent-main">
                  <div className="st-verification-title">
                    <b>{agent.displayName}</b>
                    <span className={`st-verification-level ${agent.level}`}>
                      {LEVEL_COPY[agent.level]}
                    </span>
                    <span className={`st-verification-run ${core?.status ?? 'none'}`}>
                      {runCopy(core)}
                    </span>
                    {image ? (
                      <span className={`st-verification-run ${image.status}`}>
                        {runCopy(image)}
                      </span>
                    ) : null}
                  </div>
                  <div className="st-adapter-meta mono">
                    {agent.installed
                      ? (agent.version ?? 'Installed · version unavailable')
                      : 'Not installed locally'}
                  </div>
                  {core ? <div className="st-verification-message">{core.message}</div> : null}
                </div>
                <div className="st-verification-actions">
                  {coreActive && core ? (
                    <button
                      className="btn"
                      disabled={busy !== null}
                      onClick={() => void cancel(core.id)}
                    >
                      Stop check
                    </button>
                  ) : (
                    <button
                      className="btn"
                      data-testid={`agent-verification-run-${agent.agentId}`}
                      disabled={busy !== null || !targetAvailable}
                      title={
                        targetAvailable
                          ? 'Starts a visible, read-only compatibility Prompt that may consume one provider request'
                          : selectedHostId
                            ? 'This Adapter does not support SSH'
                            : 'Install this CLI first'
                      }
                      onClick={() => void startCore(agent)}
                    >
                      {busy === `${agent.agentId}:core` ? 'Starting…' : 'Run live check'}
                    </button>
                  )}
                  {core?.terminalId ? (
                    <button className="btn" onClick={() => openTerminalSession(core.terminalId!)}>
                      Open terminal
                    </button>
                  ) : null}
                  {imageSupported && core?.status === 'passed' ? (
                    <button
                      className="btn"
                      data-testid={`agent-verification-image-${agent.agentId}`}
                      disabled={busy !== null || (image ? RUNNING.has(image.status) : false)}
                      title="Copy an image first. This sends one additional provider request."
                      onClick={() => void startImage(agent, core)}
                    >
                      {image && RUNNING.has(image.status)
                        ? 'Checking image…'
                        : 'Test clipboard image'}
                    </button>
                  ) : null}
                </div>
                <details className="st-verification-details">
                  <summary>Evidence</summary>
                  <div className="st-verification-checks">
                    {agent.checks.map((check) => (
                      <div key={check.id}>
                        <span className={`st-verification-check ${check.status}`} />
                        <b>{check.label}</b>
                        <span>{check.detail}</span>
                      </div>
                    ))}
                    {core?.checks.map((check) => (
                      <div key={`core:${check.id}`}>
                        <span className={`st-verification-check ${check.status}`} />
                        <b>Live · {check.label}</b>
                        <span>{check.detail}</span>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            );
          })}
        </div>
      )}
      <div className="st-verification-privacy">
        <Ic name="shield" size={12} /> Reports never contain Prompts, terminal output, workspace or
        executable paths, SSH host details, tokens, or account identities.
      </div>
    </div>
  );
}
