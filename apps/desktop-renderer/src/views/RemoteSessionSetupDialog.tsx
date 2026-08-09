import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  DetectedAgentDto,
  SftpEntry,
  SshHostDto,
  SshHostInput,
  SshWorkerStatus,
  WorkspaceDto,
} from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAgentCatalogStore } from '../store/agentCatalogStore.js';
import { useAppStore } from '../store/appStore.js';
import { useSshStore } from '../store/sshStore.js';
import { remoteJoin, remoteParent } from '../store/sftpStore.js';
import { Ic, ProviderMark } from './home-icons.js';
import { RemoteHostDialog } from './RemoteHostDialog.js';

interface RemoteSessionSelectionBase {
  hostId: string;
  agentId: string;
  availableAgentIds: string[];
}

export type RemoteSessionSelection = RemoteSessionSelectionBase &
  (
    | { workspaceKind: 'remote'; remoteWorkdir: string }
    | { workspaceKind: 'local'; localProjectPath: string }
  );

type Phase = 'hosts' | 'connecting' | 'inspecting' | 'configure';
type ProbeStatus = 'checking' | 'found' | 'missing';

function hostInput(host: SshHostDto, remoteWorkdir: string): SshHostInput {
  return {
    id: host.id,
    label: host.label,
    host: host.host,
    port: host.port,
    username: host.username,
    auth: host.auth,
    identityFile: host.identityFile,
    proxyJump: host.proxyJump,
    tags: host.tags,
    remoteWorkdir,
  };
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return remoteJoin(home, path.slice(2));
  return path;
}

/**
 * First-use path for a remote Agent Session:
 * saved host (or add by IP/hostname) → SSH trust/auth → remote folder →
 * host-side Agent discovery. The dialog only selects a target; the Composer
 * remains the single boundary that actually launches the Session.
 */
export function RemoteSessionSetupDialog(props: {
  initialHostId?: string | null;
  preferredAgentId?: string | null;
  localWorkspace?: WorkspaceDto | null;
  onClose: () => void;
  onSelect: (selection: RemoteSessionSelection) => void;
}): React.ReactPortal {
  const {
    initialHostId = null,
    preferredAgentId = null,
    localWorkspace = null,
    onClose,
    onSelect,
  } = props;
  const hosts = useSshStore((state) => state.hosts);
  const loaded = useSshStore((state) => state.loaded);
  const connect = useSshStore((state) => state.connect);
  const saveHost = useSshStore((state) => state.saveHost);
  const catalogAgents = useAgentCatalogStore((state) => state.agents);
  const catalogCandidates = useMemo(
    () => catalogAgents.filter((agent) => agent.capabilities.remote),
    [catalogAgents],
  );

  const [phase, setPhase] = useState<Phase>('hosts');
  const [selectedHostId, setSelectedHostId] = useState<string | null>(initialHostId);
  const [newHostOpen, setNewHostOpen] = useState(false);
  const [inspectedAgents, setInspectedAgents] = useState<DetectedAgentDto[] | null>(null);
  const [probe, setProbe] = useState<Record<string, ProbeStatus>>({});
  const [availableAgentIds, setAvailableAgentIds] = useState<string[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [remoteHome, setRemoteHome] = useState('');
  const [remoteWorkdir, setRemoteWorkdir] = useState('');
  const [workspaceKind, setWorkspaceKind] = useState<'remote' | 'local'>('remote');
  const [localProjectPath, setLocalProjectPath] = useState(localWorkspace?.path ?? '');
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [folderEntries, setFolderEntries] = useState<SftpEntry[]>([]);
  const [folderLoading, setFolderLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [worker, setWorker] = useState<SshWorkerStatus | null>(null);
  const [workerInstalling, setWorkerInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inspectionGeneration = useRef(0);
  const autoStarted = useRef(false);
  const firstUseOpened = useRef(false);

  const candidateAgents = inspectedAgents ?? catalogCandidates;

  const activeHost = hosts.find((host) => host.id === selectedHostId) ?? null;

  useEffect(() => {
    useSshStore.getState().init();
    useAgentCatalogStore.getState().init();
  }, []);

  useEffect(() => {
    if (localWorkspace?.path) setLocalProjectPath(localWorkspace.path);
  }, [localWorkspace?.path]);

  // A first-time user chose “Connect remote”, so take them directly to the
  // IP/hostname form. If they cancel, the empty host chooser remains behind it.
  useEffect(() => {
    if (!loaded || initialHostId || hosts.length > 0 || firstUseOpened.current) return;
    firstUseOpened.current = true;
    setNewHostOpen(true);
  }, [hosts.length, initialHostId, loaded]);

  const closeSftp = useCallback(() => {
    const hostId = selectedHostId;
    if (hostId) void rpcResult('ssh.sftpClose', { hostId });
  }, [selectedHostId]);

  const close = (): void => {
    inspectionGeneration.current += 1;
    closeSftp();
    onClose();
  };

  const loadFolder = useCallback(async (hostId: string, path: string): Promise<boolean> => {
    setFolderLoading(true);
    setError(null);
    const result = await rpcResult('ssh.sftpList', { hostId, path });
    setFolderLoading(false);
    if (!result.ok) {
      setError(result.error.userMessage);
      return false;
    }
    setFolderPath(result.data.path);
    setFolderEntries(result.data.entries.filter((entry) => entry.type === 'dir'));
    return true;
  }, []);

  const inspectHost = useCallback(
    async (host: SshHostDto): Promise<void> => {
      const generation = ++inspectionGeneration.current;
      setPhase('inspecting');
      setError(null);
      setWorker(null);

      // Read the catalog at inspection time instead of assuming Home's async
      // catalog load already won the race with a fast saved-host click.
      const catalogResult = await rpcResult('agents.list', { refresh: false });
      if (inspectionGeneration.current !== generation) return;
      const agents = (
        catalogResult.ok ? catalogResult.data.agents : useAgentCatalogStore.getState().agents
      ).filter((agent) => agent.capabilities.remote);
      setInspectedAgents(agents);
      setProbe(Object.fromEntries(agents.map((agent) => [agent.id, 'checking'])));

      const [homeResult, workerResult, agentResults] = await Promise.all([
        rpcResult('ssh.sftpHome', { hostId: host.id }),
        rpcResult('ssh.workerStatus', { hostId: host.id }),
        Promise.all(
          agents.map(async (agent) => ({
            agent,
            result: await rpcResult('ssh.probeCli', { hostId: host.id, cli: agent.id }),
          })),
        ),
      ]);
      if (inspectionGeneration.current !== generation) return;

      const home = homeResult.ok ? homeResult.data.path : '';
      const nextWorkdir = expandHome(host.remoteWorkdir?.trim() || home || '~', home);
      const statuses: Record<string, ProbeStatus> = {};
      const found: string[] = [];
      for (const item of agentResults) {
        const isFound = item.result.ok && item.result.data.found;
        statuses[item.agent.id] = isFound ? 'found' : 'missing';
        if (isFound) found.push(item.agent.id);
      }
      const preferred =
        preferredAgentId && found.includes(preferredAgentId) ? preferredAgentId : null;
      setRemoteHome(home);
      setRemoteWorkdir(nextWorkdir);
      setFolderPath(nextWorkdir);
      setProbe(statuses);
      setAvailableAgentIds(found);
      setSelectedAgentId(preferred ?? found[0] ?? null);
      setWorker(
        workerResult.ok
          ? workerResult.data.worker
          : {
              state: 'error',
              version: null,
              protocol: null,
              message: workerResult.error.userMessage,
              installPath: null,
              nodePath: null,
            },
      );
      setPhase('configure');
      if (!homeResult.ok) {
        setError(
          'Connected, but the remote folder browser is unavailable. Enter an absolute path manually.',
        );
      }
    },
    [preferredAgentId],
  );

  const chooseHost = useCallback(
    async (host: SshHostDto): Promise<void> => {
      inspectionGeneration.current += 1;
      setSelectedHostId(host.id);
      setError(null);
      setFolderOpen(false);
      if (host.connection.state === 'connected') {
        await inspectHost(host);
        return;
      }
      setPhase('connecting');
      await connect(host.id);
    },
    [connect, inspectHost],
  );

  useEffect(() => {
    if (phase !== 'connecting' || !activeHost) return;
    if (activeHost.connection.state === 'connected') {
      void inspectHost(activeHost);
      return;
    }
    if (activeHost.connection.state === 'disconnected' && activeHost.connection.error) {
      setError(activeHost.connection.error);
      setPhase('hosts');
    }
  }, [activeHost, inspectHost, phase]);

  useEffect(() => {
    if (!loaded || !initialHostId || autoStarted.current) return;
    const host = hosts.find((item) => item.id === initialHostId);
    if (!host) return;
    autoStarted.current = true;
    void chooseHost(host);
  }, [chooseHost, hosts, initialHostId, loaded]);

  const openFolderBrowser = async (): Promise<void> => {
    if (!activeHost) return;
    const start = expandHome(remoteWorkdir.trim() || remoteHome || '~', remoteHome);
    if (await loadFolder(activeHost.id, start)) setFolderOpen(true);
  };

  const confirmSelection = async (): Promise<void> => {
    if (!activeHost || !selectedAgentId || busy) return;
    if (worker?.state !== 'ready') {
      setError('Install or update Charter Worker before starting this managed remote Session.');
      return;
    }
    if (workspaceKind === 'local') {
      if (!localProjectPath) {
        setError('Choose a local project to synchronize first.');
        return;
      }
      closeSftp();
      onSelect({
        hostId: activeHost.id,
        agentId: selectedAgentId,
        workspaceKind: 'local',
        localProjectPath,
        availableAgentIds,
      });
      return;
    }
    const path = expandHome(remoteWorkdir.trim(), remoteHome);
    if (!path) {
      setError('Choose a remote working folder first.');
      return;
    }
    if (!remoteHome && !path.startsWith('/')) {
      setError('Enter an absolute remote path because this server has no SFTP folder browser.');
      return;
    }
    setBusy(true);
    setError(null);
    let resolvedPath = path;
    if (remoteHome) {
      const checked = await rpcResult('ssh.sftpList', { hostId: activeHost.id, path });
      if (!checked.ok) {
        setBusy(false);
        setError(`That remote folder could not be opened: ${checked.error.userMessage}`);
        return;
      }
      resolvedPath = checked.data.path;
    }
    const saved = await saveHost(hostInput(activeHost, resolvedPath));
    setBusy(false);
    if (!saved) {
      setError('Could not save the remote working folder.');
      return;
    }
    void rpcResult('ssh.sftpClose', { hostId: activeHost.id });
    onSelect({
      hostId: activeHost.id,
      agentId: selectedAgentId,
      workspaceKind: 'remote',
      remoteWorkdir: resolvedPath,
      availableAgentIds,
    });
  };

  const chooseLocalProject = async (): Promise<void> => {
    setError(null);
    const result = await rpcResult('workspace.pickAndOpen', {});
    if (!result.ok) {
      setError(result.error.userMessage);
      return;
    }
    if (result.data.workspace) setLocalProjectPath(result.data.workspace.path);
  };

  const installWorker = async (): Promise<void> => {
    if (!activeHost || workerInstalling) return;
    setWorkerInstalling(true);
    setError(null);
    const result = await rpcResult('ssh.installWorker', { hostId: activeHost.id });
    setWorkerInstalling(false);
    if (!result.ok) {
      setError(result.error.userMessage);
      return;
    }
    setWorker(result.data.worker);
  };

  const goBack = (): void => {
    inspectionGeneration.current += 1;
    closeSftp();
    setPhase('hosts');
    setSelectedHostId(null);
    setError(null);
    setFolderOpen(false);
  };

  return createPortal(
    <div className="remote-setup-backdrop" data-testid="remote-session-setup">
      <section className="remote-setup-dialog" role="dialog" aria-modal="true">
        <header className="remote-setup-head">
          <div>
            <span className="rm-eyebrow">Remote Agent Session</span>
            <h2>Connect to an Agent over SSH</h2>
            <p>The Agent runs on the selected server. Choose where the project files live.</p>
          </div>
          <button className="rm-icon-btn" aria-label="Close" onClick={close}>
            <Ic name="x" size={15} />
          </button>
        </header>

        <div className="remote-setup-steps" aria-label="Setup progress">
          <span className={phase === 'hosts' || phase === 'connecting' ? 'active' : 'done'}>
            <b>1</b> SSH connection
          </span>
          <i />
          <span className={phase === 'inspecting' || phase === 'configure' ? 'active' : ''}>
            <b>2</b> Workspace, Agent &amp; Worker
          </span>
          <i />
          <span>
            <b>3</b> Start Session
          </span>
        </div>

        <div className="remote-setup-body">
          {phase === 'hosts' ? (
            <div data-testid="remote-setup-hosts">
              <div className="remote-setup-section-head">
                <span>
                  <strong>Choose a server</strong>
                  <small>Use a saved connection, or add a host by IP address or hostname.</small>
                </span>
                <button
                  className="btn primary"
                  data-testid="remote-setup-new-host"
                  onClick={() => setNewHostOpen(true)}
                >
                  <Ic name="plus" size={13} /> Add server
                </button>
              </div>
              {!loaded ? (
                <div className="remote-setup-wait">
                  <span className="rm-dot connecting" /> Loading saved hosts…
                </div>
              ) : hosts.length === 0 ? (
                <button className="remote-setup-empty" onClick={() => setNewHostOpen(true)}>
                  <Ic name="server" size={24} />
                  <strong>No SSH servers yet</strong>
                  <span>Enter an IP address or hostname to connect your first remote Agent.</span>
                </button>
              ) : (
                <div className="remote-host-choices">
                  {hosts.map((host) => (
                    <button
                      key={host.id}
                      className="remote-host-choice"
                      data-testid={`remote-setup-host-${host.id}`}
                      onClick={() => void chooseHost(host)}
                    >
                      <span className="remote-host-choice-icon">
                        <Ic name="server" size={17} />
                      </span>
                      <span>
                        <strong>{host.label}</strong>
                        <small>
                          {host.username}@{host.host}:{host.port}
                        </small>
                      </span>
                      <em className={host.connection.state}>
                        <span className={`rm-dot ${host.connection.state}`} />
                        {host.connection.state === 'connected' ? 'Connected' : 'Connect'}
                      </em>
                      <Ic name="chevron" size={12} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {phase === 'connecting' && activeHost ? (
            <div className="remote-setup-progress" data-testid="remote-setup-connecting">
              <span className="remote-progress-mark">
                <Ic name="server" size={25} />
              </span>
              <span className="rm-dot connecting" />
              <h3>Connecting to {activeHost.label}</h3>
              <p>
                {activeHost.username}@{activeHost.host}:{activeHost.port}
              </p>
              <small>Charter may ask you to verify the host key or enter an SSH credential.</small>
            </div>
          ) : null}

          {phase === 'inspecting' && activeHost ? (
            <div className="remote-setup-progress" data-testid="remote-setup-inspecting">
              <span className="remote-progress-mark">
                <Ic name="search" size={25} />
              </span>
              <span className="rm-dot connecting" />
              <h3>Checking {activeHost.label}</h3>
              <p>Finding its home folder and installed Agent CLIs…</p>
            </div>
          ) : null}

          {phase === 'configure' && activeHost ? (
            <div className="remote-configure" data-testid="remote-setup-configure">
              <div className="remote-connected-summary">
                <span className="remote-host-choice-icon">
                  <Ic name="server" size={17} />
                </span>
                <span>
                  <small>Connected server</small>
                  <strong>{activeHost.label}</strong>
                  <code>
                    {activeHost.username}@{activeHost.host}:{activeHost.port}
                  </code>
                </span>
                <em>
                  <span className="rm-dot connected" /> SSH ready
                </em>
              </div>

              <section className="remote-config-section" data-testid="remote-workspace-mode">
                <div className="remote-config-title">
                  <b>Where do the project files live?</b>
                  <span>The Agent always runs on {activeHost.label}</span>
                </div>
                <div className="remote-workspace-choices" role="radiogroup">
                  <button
                    type="button"
                    className={workspaceKind === 'remote' ? 'selected' : ''}
                    data-testid="remote-workspace-remote"
                    role="radio"
                    aria-checked={workspaceKind === 'remote'}
                    onClick={() => {
                      setWorkspaceKind('remote');
                      setError(null);
                    }}
                  >
                    <span className="remote-workspace-icon">
                      <Ic name="server" size={18} />
                    </span>
                    <span>
                      <strong>On this server</strong>
                      <small>Use an existing folder on {activeHost.label}</small>
                    </span>
                    {workspaceKind === 'remote' ? <Ic name="check" size={13} /> : null}
                  </button>
                  <button
                    type="button"
                    className={workspaceKind === 'local' ? 'selected' : ''}
                    data-testid="remote-workspace-local"
                    role="radio"
                    aria-checked={workspaceKind === 'local'}
                    onClick={() => {
                      setWorkspaceKind('local');
                      setFolderOpen(false);
                      setError(null);
                    }}
                  >
                    <span className="remote-workspace-icon">
                      <Ic name="home" size={18} />
                    </span>
                    <span>
                      <strong>On this Mac</strong>
                      <small>Keep the local folder; run the Agent remotely</small>
                    </span>
                    {workspaceKind === 'local' ? <Ic name="check" size={13} /> : null}
                  </button>
                </div>
              </section>

              {workspaceKind === 'remote' ? (
                <section className="remote-config-section">
                  <div className="remote-config-title">
                    <b>Remote working folder</b>
                    <span>The Agent reads and changes this server directory directly</span>
                  </div>
                  <div className="remote-path-field">
                    <Ic name="folder" size={14} />
                    <input
                      className="mono"
                      data-testid="remote-setup-workdir"
                      value={remoteWorkdir}
                      placeholder="/srv/project or ~/projects/app"
                      onChange={(event) => setRemoteWorkdir(event.target.value)}
                    />
                    <button
                      className="btn sm"
                      data-testid="remote-setup-browse"
                      disabled={!remoteHome}
                      title={
                        remoteHome
                          ? 'Browse folders on this server'
                          : 'This server did not expose an SFTP folder browser'
                      }
                      onClick={() => void openFolderBrowser()}
                    >
                      Browse…
                    </button>
                  </div>

                  {folderOpen ? (
                    <div className="remote-folder-browser" data-testid="remote-folder-browser">
                      <header>
                        <button
                          className="rm-icon-btn"
                          aria-label="Parent folder"
                          disabled={folderPath === '/'}
                          onClick={() =>
                            activeHost && void loadFolder(activeHost.id, remoteParent(folderPath))
                          }
                        >
                          ↑
                        </button>
                        <code>{folderPath}</code>
                        <button
                          className="btn sm"
                          onClick={() => {
                            setRemoteWorkdir(folderPath);
                            setFolderOpen(false);
                          }}
                        >
                          Use this folder
                        </button>
                      </header>
                      <div className="remote-folder-list">
                        {folderLoading ? <div className="remote-folder-empty">Loading…</div> : null}
                        {!folderLoading && folderEntries.length === 0 ? (
                          <div className="remote-folder-empty">No subfolders</div>
                        ) : null}
                        {folderEntries.map((entry) => (
                          <button
                            key={entry.name}
                            data-testid={`remote-folder-${entry.name}`}
                            onClick={() =>
                              void loadFolder(activeHost.id, remoteJoin(folderPath, entry.name))
                            }
                          >
                            <Ic name="folder" size={14} />
                            <span>{entry.name}</span>
                            <Ic name="chevron" size={11} />
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </section>
              ) : (
                <section className="remote-config-section" data-testid="remote-local-workspace">
                  <div className="remote-config-title">
                    <b>Local project folder</b>
                    <span>Canonical files stay here; execution happens on {activeHost.label}</span>
                  </div>
                  <div className="remote-path-field local-source">
                    <Ic name="folder" size={14} />
                    <code data-testid="remote-local-workdir">
                      {localProjectPath || 'Choose a project on this Mac'}
                    </code>
                    <button
                      className="btn sm"
                      data-testid="remote-local-browse"
                      onClick={() => void chooseLocalProject()}
                    >
                      Browse…
                    </button>
                  </div>
                  <div className="remote-local-boundary">
                    <Ic name="refresh" size={14} />
                    <span>
                      Charter sends a bounded snapshot to an isolated folder on the server, then
                      synchronizes file changes both ways with hash conflict checks. Git-ignored
                      files stay on this Mac by default.
                    </span>
                  </div>
                </section>
              )}

              <section className="remote-config-section" data-testid="remote-worker-section">
                <div className="remote-config-title">
                  <b>Charter Worker</b>
                  <span>Required for remote Diff, Review, rollback and file integrity checks</span>
                </div>
                <div className={`remote-worker-card ${worker?.state ?? 'checking'}`}>
                  <span className="remote-worker-icon">
                    <Ic
                      name={
                        worker?.state === 'ready'
                          ? 'check'
                          : worker?.state === 'error'
                            ? 'alert'
                            : 'server'
                      }
                      size={16}
                    />
                  </span>
                  <span className="remote-worker-copy">
                    <strong>
                      {workerInstalling
                        ? 'Installing and verifying…'
                        : worker?.state === 'ready'
                          ? `Ready · v${worker.version}`
                          : worker?.state === 'outdated'
                            ? 'Update required'
                            : worker?.state === 'missing'
                              ? 'Not installed'
                              : worker?.state === 'unsupported'
                                ? 'Remote runtime missing'
                                : worker
                                  ? 'Worker check failed'
                                  : 'Checking Worker…'}
                    </strong>
                    <small>
                      {workerInstalling
                        ? 'Uploading this Charter build over the trusted SSH connection.'
                        : (worker?.message ??
                          'Checking the version and SHA-256 integrity handshake.')}
                    </small>
                    {worker?.installPath ? <code>{worker.installPath}</code> : null}
                  </span>
                  {worker && ['missing', 'outdated', 'error'].includes(worker.state) ? (
                    <button
                      className="btn sm"
                      data-testid="remote-worker-install"
                      disabled={workerInstalling || !worker.nodePath}
                      onClick={() => void installWorker()}
                    >
                      {workerInstalling
                        ? 'Installing…'
                        : worker.state === 'outdated'
                          ? 'Update Worker'
                          : 'Install Worker'}
                    </button>
                  ) : null}
                </div>
                <p className="remote-worker-consent">
                  Charter installs only after you click the button. It stays under ~/.charter/worker
                  and is never injected merely by connecting over SSH.
                </p>
              </section>

              <section className="remote-config-section">
                <div className="remote-config-title">
                  <b>Agent installed on this server</b>
                  <span>Detected through the SSH connection</span>
                </div>
                <div className="remote-agent-choices">
                  {candidateAgents.map((agent: DetectedAgentDto) => {
                    const status = probe[agent.id] ?? 'checking';
                    const found = status === 'found';
                    return (
                      <button
                        key={agent.id}
                        className={`${selectedAgentId === agent.id ? 'selected' : ''} ${status}`}
                        data-testid={`remote-setup-agent-${agent.id}`}
                        disabled={!found}
                        onClick={() => setSelectedAgentId(agent.id)}
                      >
                        <ProviderMark provider={agent.id} size={20} />
                        <span>
                          <strong>{agent.displayName}</strong>
                          <small>
                            {found
                              ? 'Ready on this server'
                              : status === 'checking'
                                ? 'Checking…'
                                : 'Not found'}
                          </small>
                        </span>
                        {selectedAgentId === agent.id ? <Ic name="check" size={13} /> : null}
                      </button>
                    );
                  })}
                </div>
                {availableAgentIds.length === 0 ? (
                  <div className="remote-no-agent">
                    <Ic name="alert" size={14} />
                    <span>
                      No supported Agent CLI was found. Install Claude Code, Codex or another
                      remote-capable Agent on this server, then check again.
                    </span>
                    <button className="btn sm" onClick={() => void inspectHost(activeHost)}>
                      Check again
                    </button>
                  </div>
                ) : null}
              </section>
            </div>
          ) : null}

          {error ? (
            <div className="remote-setup-error">
              <Ic name="alert" size={14} /> {error}
            </div>
          ) : null}
        </div>

        <footer className="remote-setup-foot">
          {phase !== 'hosts' ? (
            <button className="btn" onClick={goBack}>
              Back
            </button>
          ) : (
            <span />
          )}
          <span className="remote-setup-foot-note">
            {phase === 'configure' && activeHost && selectedAgentId
              ? `${activeHost.label} · ${
                  workspaceKind === 'local'
                    ? localProjectPath || 'local project not selected'
                    : remoteWorkdir || '~'
                } · ${candidateAgents.find((agent) => agent.id === selectedAgentId)?.displayName ?? selectedAgentId}`
              : 'SSH credentials remain in the OS keychain.'}
          </span>
          {phase === 'configure' ? (
            <button
              className="btn primary"
              data-testid="remote-setup-use"
              aria-disabled={
                worker?.state !== 'ready' ||
                (workspaceKind === 'remote' ? !remoteWorkdir.trim() : !localProjectPath)
              }
              disabled={
                !selectedAgentId ||
                (workspaceKind === 'remote' ? !remoteWorkdir.trim() : !localProjectPath) ||
                worker?.state !== 'ready' ||
                busy ||
                workerInstalling
              }
              onClick={() => void confirmSelection()}
            >
              {busy
                ? remoteHome
                  ? 'Checking folder…'
                  : 'Saving…'
                : workspaceKind === 'local'
                  ? 'Use Local Project'
                  : 'Use Remote Folder'}
            </button>
          ) : null}
        </footer>
      </section>

      {newHostOpen ? (
        <RemoteHostDialog
          mode="create"
          onClose={() => setNewHostOpen(false)}
          onSaved={(host) => {
            setNewHostOpen(false);
            void chooseHost(host);
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
