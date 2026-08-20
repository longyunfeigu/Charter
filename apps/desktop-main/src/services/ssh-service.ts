import { newId, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import {
  SshConnectionManager,
  createHostKeyStore,
  parseSshConfig,
  type ConnectionEndReason,
  type HostKeyStore,
  type ShellSession,
  type SftpSession,
  type SshPromptBridge,
  type SshTargetConfig,
} from '@pi-ide/ssh-service';
import type { TerminalManager, TerminalInfo } from '@pi-ide/terminal-service';
import {
  SSH_HOST_ID_RE,
  type SshConfigCandidate,
  type SshForwardInput,
  type SshForwardRecord,
  type SshHostDto,
  type SshHostInput,
  type SshHostRecord,
  type SshSecretKind,
  type TaskDto,
} from '@pi-ide/ipc-contracts';
import type { Duplex } from 'node:stream';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { broadcast } from '../broadcast.js';
import type { SettingsService } from './settings-service.js';
import type { SshVaultService } from './ssh-vault-service.js';
import {
  createSshTerminalBackend,
  remoteCliProbeCommand,
  remoteCwdSyncSequence,
  remoteLaunchSequence,
} from './ssh-terminal-bridge.js';
import type { RemoteWorkerService } from './remote-worker-service.js';
import type { ExternalLaunchIntents } from './external-launch-intents.js';

const PROMPT_TIMEOUT_MS = 120_000;
const REMOTE_LAUNCH_DELAY_MS = 350;

interface PendingHostKey {
  resolve: (decision: { accept: boolean; remember: boolean }) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface PendingAuth {
  hostId: string;
  kind: 'password' | 'passphrase' | 'keyboard-interactive';
  resolve: (answer: { answers: string[]; save: boolean } | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CreateRemoteTerminalOptions {
  hostId: string;
  launch: string;
  initialPrompt?: string | null;
  /** Canonical local project chosen through WorkspaceHost. When present the
   * Worker prepares an isolated remote execution copy and bridges changes. */
  localProjectPath?: string;
  cols?: number;
  rows?: number;
}

export interface SshServiceOptions {
  sshDir: string;
  sshConfigPath?: string;
  knownHostsPath?: string;
  resolveAgentLaunch?: (
    agentId: string,
    prompt: string | null,
  ) => {
    command: string;
    args: string[];
    promptDelivery: 'argv' | 'deferred';
    sessionId: string | null;
  } | null;
}

/**
 * Orchestrates SSH Remotes in the main process (ADR-0047): the host book
 * (settings.ssh), the ssh2 connection manager, keychain secrets, host-key
 * trust, and the bridge that turns a remote shell into a Charter terminal.
 *
 * Implements the interactive prompt bridge by minting a requestId, emitting an
 * ssh.* event to the renderer, and resolving when the modal answers. Secrets
 * only ever flow renderer→main through those answers; nothing secret is logged.
 */
export class SshService implements SshPromptBridge {
  private readonly manager: SshConnectionManager;
  private readonly hostKeys: HostKeyStore;
  private readonly pendingHostKeys = new Map<string, PendingHostKey>();
  private readonly pendingAuth = new Map<string, PendingAuth>();
  /** hostId → live terminal ids, for connection-loss banner injection. */
  private readonly terminalsByHost = new Map<string, Set<string>>();
  /** Last broadcast state per host, to stamp lastConnectedAt on edges only. */
  private readonly lastState = new Map<string, string>();
  private remoteWorker: RemoteWorkerService | null = null;
  private launchIntents: ExternalLaunchIntents | null = null;
  private readonly resolveAgentLaunch: NonNullable<SshServiceOptions['resolveAgentLaunch']> | null;

  constructor(
    private readonly settings: SettingsService,
    private readonly vault: SshVaultService,
    private readonly terminals: TerminalManager,
    private readonly logger: Logger,
    options: SshServiceOptions = {
      sshDir: join(homedir(), '.charter-ssh'),
    },
  ) {
    this.resolveAgentLaunch = options.resolveAgentLaunch ?? null;
    const home = homedir();
    this.sshConfigPath = options.sshConfigPath ?? join(home, '.ssh', 'config');
    this.hostKeys = createHostKeyStore({
      trustedHostsFile: join(options.sshDir, 'trusted-hosts.json'),
      knownHostsFile: options.knownHostsPath ?? join(home, '.ssh', 'known_hosts'),
    });
    this.manager = new SshConnectionManager({
      hostKeys: this.hostKeys,
      prompts: this,
      secrets: {
        password: async (hostId) => this.vault.get(hostId, 'password'),
        passphrase: async (hostId) => this.vault.get(hostId, 'passphrase'),
        store: async (hostId, kind, value) => this.vault.set(hostId, kind, value),
      },
      logger: this.logger,
      onState: (info) => {
        // Stamp lastConnectedAt only on the transition into connected — every
        // channel open/close re-emits 'connected', and writing settings +
        // refreshing the renderer on each would be needless churn.
        const was = this.lastState.get(info.hostId);
        if (info.state === 'connected' && was !== 'connected') {
          this.touchLastConnected(info.hostId);
        }
        this.lastState.set(info.hostId, info.state);
        broadcast('ssh.state', info);
      },
      onConnectionEnd: (hostId, reason) => this.onConnectionEnd(hostId, reason),
      // Auto-reconnect is gated per target (read fresh from settings on each
      // connect), so leave the backoff schedule at its default and let that
      // gate honor a runtime toggle instead of freezing it here.
      resolveJumpTarget: (spec, base) => this.resolveJumpTarget(spec, base),
    });
    // Forget a host's terminal once its PTY-equivalent exits.
    this.terminals.onExitEvent(({ id }) => {
      for (const set of this.terminalsByHost.values()) set.delete(id);
    });
  }

  private readonly sshConfigPath: string;

  attachManagedSessions(worker: RemoteWorkerService, intents: ExternalLaunchIntents): void {
    this.remoteWorker = worker;
    this.launchIntents = intents;
  }

  // -------------------------------------------------------------------------
  // Host book (settings.ssh.hosts) — renderer never rewrites the whole section.

  private hosts(): SshHostRecord[] {
    return this.settings.effective.ssh.hosts;
  }

  private writeHosts(hosts: SshHostRecord[]): void {
    this.settings.update('global', { ssh: { hosts } });
  }

  private toDto(host: SshHostRecord): SshHostDto {
    return {
      ...host,
      hasPassword: this.vault.has(host.id, 'password'),
      hasPassphrase: this.vault.has(host.id, 'passphrase'),
      connection: this.manager.snapshot(host.id),
    };
  }

  listHosts(): SshHostDto[] {
    return this.hosts().map((h) => this.toDto(h));
  }

  saveHost(input: SshHostInput): SshHostDto {
    const hosts = [...this.hosts()];
    const id = input.id ?? this.freshId(input.label, hosts);
    const record: SshHostRecord = {
      id,
      label: input.label,
      host: input.host,
      port: input.port,
      username: input.username,
      auth: input.auth,
      identityFile: input.identityFile,
      proxyJump: input.proxyJump,
      tags: input.tags,
      remoteWorkdir: input.remoteWorkdir,
      // Host-owned bookkeeping the dialog must never clobber.
      forwards: hosts.find((h) => h.id === id)?.forwards ?? [],
      importedFrom: hosts.find((h) => h.id === id)?.importedFrom ?? 'manual',
      lastConnectedAt: hosts.find((h) => h.id === id)?.lastConnectedAt ?? null,
    };
    const idx = hosts.findIndex((h) => h.id === id);
    if (idx >= 0) hosts[idx] = record;
    else hosts.push(record);
    this.writeHosts(hosts);
    return this.toDto(record);
  }

  async deleteHost(hostId: string): Promise<boolean> {
    const hosts = this.hosts();
    if (!hosts.some((h) => h.id === hostId)) return false;
    await this.manager.disconnect(hostId);
    this.vault.clearHost(hostId);
    this.writeHosts(hosts.filter((h) => h.id !== hostId));
    return true;
  }

  private freshId(label: string, existing: SshHostRecord[]): string {
    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'host';
    const seed = SSH_HOST_ID_RE.test(base) ? base : `host-${base}`;
    let candidate = seed;
    let n = 1;
    const taken = new Set(existing.map((h) => h.id));
    while (taken.has(candidate)) candidate = `${seed}-${++n}`.slice(0, 40);
    return candidate;
  }

  // -------------------------------------------------------------------------
  // Secrets (keychain vault) — plaintext arrives here, never leaves.

  setSecret(hostId: string, kind: SshSecretKind, value: string): boolean {
    this.vault.set(hostId, kind, value);
    return true;
  }

  clearSecret(hostId: string, kind: SshSecretKind): boolean {
    return this.vault.clear(hostId, kind);
  }

  // -------------------------------------------------------------------------
  // Connect / disconnect

  private target(host: SshHostRecord): SshTargetConfig {
    return {
      id: host.id,
      label: host.label,
      host: host.host,
      port: host.port,
      username: host.username,
      auth: host.auth,
      identityFile: host.identityFile,
      keepaliveSeconds: this.settings.effective.ssh.keepaliveSeconds,
      autoReconnect: this.settings.effective.ssh.autoReconnect,
      proxyJump: host.proxyJump,
    };
  }

  /** ProxyJump single hop (ADR-0047): a saved host (by id / label / hostname)
   * gets its full auth+key pipeline; otherwise "user@host[:port]" connects as
   * an ephemeral agent-auth target. */
  private resolveJumpTarget(spec: string, base: SshTargetConfig): SshTargetConfig | null {
    const trimmed = spec.trim();
    if (!trimmed) return null;
    const book = this.hosts().find(
      (h) => h.id === trimmed || h.label === trimmed || h.host === trimmed,
    );
    if (book) return this.target(book);
    const m = /^(?:([^@]+)@)?\[?([^[\]@:]+)\]?(?::(\d{1,5}))?$/.exec(trimmed);
    if (!m?.[2]) return null;
    const host = m[2];
    const port = m[3] ? Number(m[3]) : 22;
    if (port < 1 || port > 65535) return null;
    return {
      id: `jump-${host.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}-${port}`.slice(0, 60),
      label: trimmed,
      host,
      port,
      username: m[1] ?? base.username,
      auth: 'agent',
      identityFile: null,
      keepaliveSeconds: this.settings.effective.ssh.keepaliveSeconds,
      autoReconnect: this.settings.effective.ssh.autoReconnect,
      proxyJump: null,
    };
  }

  private requireHost(hostId: string): SshHostRecord {
    const host = this.hosts().find((h) => h.id === hostId);
    if (!host) throw new Error(`Unknown SSH host: ${hostId}`);
    return host;
  }

  async connect(hostId: string): Promise<void> {
    await this.manager.connect(this.target(this.requireHost(hostId)));
  }

  async disconnect(hostId: string): Promise<boolean> {
    // Preserve the final remote file versions while the existing transport is
    // still usable. Removing the Worker binding first also prevents the shell
    // close callback from reconnecting after an intentional Disconnect.
    const terminalIds = [...(this.terminalsByHost.get(hostId) ?? [])];
    for (const terminalId of terminalIds) {
      if (!this.remoteWorker?.sessionForTerminal(terminalId)) continue;
      await this.remoteWorker.beforeTerminalExit(terminalId).catch((error) => {
        this.logger.warn('remote final sync failed before disconnect', {
          hostId,
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return this.manager.disconnect(hostId);
  }

  disconnectAll(): void {
    // App shutdown is recoverable from the retained remote baseline. Do not
    // let asynchronous PTY close bookkeeping establish fresh SSH transports.
    this.remoteWorker?.dispose();
    this.manager.disconnectAll();
    for (const p of this.pendingHostKeys.values()) {
      clearTimeout(p.timer);
      p.resolve({ accept: false, remember: false });
    }
    for (const p of this.pendingAuth.values()) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pendingHostKeys.clear();
    this.pendingAuth.clear();
  }

  // -------------------------------------------------------------------------
  // SFTP + forward primitives (PR2/PR3) — consumed by SshSftpService and
  // SshForwardService; both stay off the ssh2 API surface.

  async openSftpSession(hostId: string): Promise<SftpSession> {
    return this.manager.openSftp(this.target(this.requireHost(hostId)));
  }

  async execCommand(hostId: string, command: string, input?: string) {
    return this.manager.exec(this.target(this.requireHost(hostId)), command, input);
  }

  isConnected(hostId: string): boolean {
    return this.manager.snapshot(hostId).state === 'connected';
  }

  async openForwardStream(hostId: string, dstHost: string, dstPort: number): Promise<Duplex> {
    return this.manager.openForwardStream(this.target(this.requireHost(hostId)), dstHost, dstPort);
  }

  /** Keep the transport alive for a non-terminal user (active forward). */
  holdConnection(hostId: string, token: string): void {
    this.manager.hold(hostId, token);
  }

  releaseConnection(hostId: string, token: string): void {
    this.manager.release(hostId, token);
  }

  // -------------------------------------------------------------------------
  // Forward records (persisted on the host; runtime state lives in
  // SshForwardService)

  getForward(hostId: string, forwardId: string): SshForwardRecord | null {
    const host = this.hosts().find((h) => h.id === hostId);
    return host?.forwards.find((f) => f.id === forwardId) ?? null;
  }

  saveForward(hostId: string, input: SshForwardInput): SshForwardRecord {
    const host = this.requireHost(hostId);
    const id = input.id ?? newId('fwd');
    const record: SshForwardRecord = {
      id,
      bindHost: input.bindHost,
      bindPort: input.bindPort,
      targetHost: input.targetHost,
      targetPort: input.targetPort,
    };
    const forwards = [...host.forwards];
    const idx = forwards.findIndex((f) => f.id === id);
    if (idx >= 0) forwards[idx] = record;
    else {
      if (forwards.length >= 20) throw new Error('A host can keep at most 20 saved forwards');
      forwards.push(record);
    }
    this.writeHosts(this.hosts().map((h) => (h.id === hostId ? { ...h, forwards } : h)));
    return record;
  }

  deleteForward(hostId: string, forwardId: string): boolean {
    const host = this.hosts().find((h) => h.id === hostId);
    if (!host || !host.forwards.some((f) => f.id === forwardId)) return false;
    this.writeHosts(
      this.hosts().map((h) =>
        h.id === hostId ? { ...h, forwards: h.forwards.filter((f) => f.id !== forwardId) } : h,
      ),
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // Remote CLI probe + terminal creation

  async probeCli(hostId: string, cli: string): Promise<{ found: boolean; path: string | null }> {
    try {
      const command = this.resolveAgentLaunch?.(cli, null)?.command ?? cli;
      const result = await this.manager.exec(
        this.target(this.requireHost(hostId)),
        remoteCliProbeCommand(command),
      );
      const outputLines = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const path =
        [...outputLines].reverse().find((line) => line.startsWith('/')) ??
        outputLines.at(-1) ??
        null;
      return { found: result.code === 0 && path !== null, path };
    } catch {
      return { found: false, path: null };
    }
  }

  async createRemoteTerminal(options: CreateRemoteTerminalOptions): Promise<TerminalInfo> {
    const host = this.requireHost(options.hostId);
    const target = this.target(host);
    const launch = options.launch;
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;

    await this.manager.connect(target);

    // Probe before adopting so the green agent dot only lights when the CLI
    // is really present (knownAgent must not lie).
    const agentLaunch = launch === 'shell' ? null : launch;
    const agentSpec = agentLaunch
      ? (this.resolveAgentLaunch?.(agentLaunch, options.initialPrompt?.trim() || null) ??
        (this.resolveAgentLaunch
          ? null
          : {
              command: agentLaunch,
              args: options.initialPrompt?.trim() ? [options.initialPrompt.trim()] : [],
              promptDelivery: 'argv' as const,
              sessionId: null,
            }))
      : null;
    if (agentLaunch && !agentSpec) {
      throw new ProductFailure(
        productError('AGENT_NOT_AVAILABLE', {
          userMessage: `${agentLaunch} does not have a remote launch contract in this Charter build.`,
          retryable: false,
        }),
      );
    }
    const agentFound = agentLaunch ? (await this.probeCli(host.id, agentLaunch)).found : false;

    if (agentLaunch && !agentFound) {
      throw new ProductFailure(
        productError('AGENT_NOT_AVAILABLE', {
          userMessage: `${agentLaunch} was not found on ${host.label}. Install it on the remote server, then check again.`,
          retryable: true,
        }),
      );
    }

    const terminalId = newId('term');
    let managed = null as Awaited<ReturnType<RemoteWorkerService['begin']>> | null;
    if (agentLaunch) {
      if (!this.remoteWorker || !this.launchIntents) {
        throw new ProductFailure(
          productError('SSH_WORKER_REQUIRED', {
            userMessage: 'Managed remote Sessions are unavailable until Charter Worker is ready.',
            retryable: true,
          }),
        );
      }
      if (!options.localProjectPath && !host.remoteWorkdir) {
        throw new ProductFailure(
          productError('SSH_REMOTE_FOLDER_REQUIRED', {
            userMessage: 'Choose a remote working folder before starting the Agent Session.',
            retryable: true,
          }),
        );
      }
      managed = await this.remoteWorker.begin({
        terminalId,
        hostId: host.id,
        hostLabel: host.label,
        ...(options.localProjectPath
          ? { localProjectPath: options.localProjectPath }
          : { root: host.remoteWorkdir! }),
      });
      // Register before adoptBackend: knownAgent emits on a microtask and owns
      // the first prompt/accounting edge.
      this.launchIntents.register(terminalId, {
        cli: agentLaunch,
        sessionId: agentSpec!.sessionId,
        prompt: options.initialPrompt?.trim() || null,
        promptDelivery: agentSpec!.promptDelivery,
      });
    }

    let openedSession: ShellSession | null = null;
    try {
      openedSession = await this.manager.openShell(target, { cols, rows });
      const session = openedSession;
      const backend = createSshTerminalBackend(session, {
        ...(managed && this.remoteWorker
          ? { beforeExit: () => this.remoteWorker!.beforeTerminalExit(terminalId) }
          : {}),
      });
      const info = this.terminals.adoptBackend(backend, {
        id: terminalId,
        title: host.label,
        shell: `ssh://${host.username}@${host.host}`,
        cwd: managed?.root ?? host.remoteWorkdir ?? '~',
        projectName: managed
          ? managed.workspaceKind === 'local'
            ? `${basename(managed.mirrorRoot)} · ${host.label}`
            : `${host.label} · ${managed.root.split('/').filter(Boolean).at(-1) ?? managed.root}`
          : host.label,
        projectPath: managed?.mirrorRoot ?? null,
        contextKind: 'focused',
        contextLabel: host.label,
        launch,
        knownAgent: agentFound && agentLaunch ? agentLaunch : undefined,
        remote: {
          hostId: host.id,
          hostLabel: host.label,
          username: host.username,
          host: host.host,
          port: host.port,
          ...(managed
            ? {
                root: managed.root,
                workerSessionId: managed.workerSessionId,
                workerVersion: managed.workerVersion,
                workspaceKind: managed.workspaceKind,
              }
            : {}),
        },
      });

      let set = this.terminalsByHost.get(host.id);
      if (!set) this.terminalsByHost.set(host.id, (set = new Set()));
      set.add(info.id);

      if (agentLaunch) {
        // Let the renderer attach its xterm before the CLI's first repaint.
        setTimeout(() => {
          try {
            backend.write(
              remoteLaunchSequence(
                agentSpec!.command,
                managed?.root ?? host.remoteWorkdir,
                agentSpec!.args,
              ),
            );
          } catch (error) {
            this.logger.warn('remote Agent launch write failed', {
              hostId: host.id,
              terminalId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }, REMOTE_LAUNCH_DELAY_MS).unref();
      } else if (this.settings.effective.ssh.cwdSync) {
        // ADR-0059: plain shells get the one-line OSC 7 cwd hook so drops and
        // the Files drawer track the live directory. Agent launches skip it —
        // their `exec` replaces the shell, and their cwd is the managed root.
        setTimeout(() => {
          try {
            backend.write(remoteCwdSyncSequence());
          } catch (error) {
            this.logger.warn('remote cwd sync write failed', {
              hostId: host.id,
              terminalId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }, REMOTE_LAUNCH_DELAY_MS).unref();
      }
      return info;
    } catch (error) {
      openedSession?.close();
      this.launchIntents?.remove(terminalId);
      await this.remoteWorker?.abandonTerminal(terminalId);
      throw error;
    }
  }

  /** Open an SSH PTY for an existing managed task without taking a new
   * baseline. ExternalSessionService writes the manifest-owned resume command,
   * then calls activate so the remote Agent edge cannot race its bookkeeping. */
  async prepareRemoteResume(task: TaskDto): Promise<{ terminalId: string; activate: () => void }> {
    const remote = task.external?.remote;
    const cli = task.external?.cli;
    if (!remote || !cli || !this.remoteWorker) {
      throw new ProductFailure(
        productError('SSH_WORKER_REQUIRED', {
          userMessage: 'This Session does not have a managed remote Worker baseline.',
          retryable: true,
        }),
      );
    }
    const host = this.requireHost(remote.hostId);
    const target = this.target(host);
    await this.manager.connect(target);
    if (!(await this.probeCli(host.id, cli)).found) {
      throw new ProductFailure(
        productError('AGENT_NOT_AVAILABLE', {
          userMessage: `${cli} is no longer available on ${host.label}.`,
          retryable: true,
        }),
      );
    }

    const terminalId = newId('term');
    const shell = await this.manager.openShell(target, { cols: 80, rows: 24 });
    try {
      const managed = await this.remoteWorker.attachTerminal(task.id, terminalId);
      const backend = createSshTerminalBackend(shell, {
        beforeExit: () => this.remoteWorker!.beforeTerminalExit(terminalId),
      });
      this.terminals.adoptBackend(backend, {
        id: terminalId,
        title: host.label,
        shell: `ssh://${host.username}@${host.host}`,
        cwd: managed.root,
        projectName: task.projectName,
        projectPath: managed.mirrorRoot,
        contextKind: 'task',
        contextLabel: host.label,
        contextTaskId: task.id,
        launch: cli,
        remote: {
          hostId: host.id,
          hostLabel: host.label,
          username: host.username,
          host: host.host,
          port: host.port,
          root: managed.root,
          workerSessionId: managed.workerSessionId,
          workerVersion: managed.workerVersion,
          workspaceKind: managed.workspaceKind,
        },
      });
      let set = this.terminalsByHost.get(host.id);
      if (!set) this.terminalsByHost.set(host.id, (set = new Set()));
      set.add(terminalId);
      return {
        terminalId,
        activate: () => {
          if (!this.terminals.declareKnownAgent(terminalId, cli)) {
            throw new Error('The remote resume terminal closed before the Agent started.');
          }
        },
      };
    } catch (error) {
      this.remoteWorker.detachTerminal(terminalId);
      shell.close();
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Interactive prompt bridge (SshPromptBridge)

  hostKey(req: {
    hostId: string;
    host: string;
    port: number;
    keyType: string;
    fingerprintSha256: string;
    status: 'unknown' | 'mismatch';
    knownFingerprint: string | null;
  }): Promise<{ accept: boolean; remember: boolean }> {
    const requestId = newId('sshhk');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHostKeys.delete(requestId);
        resolve({ accept: false, remember: false });
      }, PROMPT_TIMEOUT_MS);
      timer.unref?.();
      this.pendingHostKeys.set(requestId, { resolve, timer });
      broadcast('ssh.hostKeyPrompt', { requestId, ...req });
    });
  }

  auth(req: {
    hostId: string;
    kind: 'password' | 'passphrase' | 'keyboard-interactive';
    prompts: Array<{ prompt: string; echo: boolean }>;
  }): Promise<{ answers: string[]; save: boolean } | null> {
    const requestId = newId('sshauth');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAuth.delete(requestId);
        resolve(null);
      }, PROMPT_TIMEOUT_MS);
      timer.unref?.();
      this.pendingAuth.set(requestId, { hostId: req.hostId, kind: req.kind, resolve, timer });
      broadcast('ssh.authPrompt', {
        requestId,
        hostId: req.hostId,
        kind: req.kind,
        prompts: req.prompts,
      });
    });
  }

  respondHostKey(requestId: string, accept: boolean, remember: boolean): boolean {
    const pending = this.pendingHostKeys.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingHostKeys.delete(requestId);
    pending.resolve({ accept, remember });
    return true;
  }

  respondAuth(requestId: string, answers: string[], save: boolean): boolean {
    const pending = this.pendingAuth.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingAuth.delete(requestId);
    // A saved answer is persisted by the connection manager only once the
    // handshake it belongs to actually succeeds.
    pending.resolve({ answers, save });
    return true;
  }

  // -------------------------------------------------------------------------
  // ~/.ssh/config import

  async importConfig(): Promise<SshConfigCandidate[]> {
    let text: string;
    try {
      text = await readFile(this.sshConfigPath, 'utf8');
    } catch {
      return [];
    }
    const parsed = parseSshConfig(text, { homedir: homedir() });
    if (parsed.warnings.length > 0) {
      this.logger.info('ssh config import warnings', { warnings: parsed.warnings });
    }
    const importedAliases = new Set(this.hosts().map((h) => h.label));
    return parsed.hosts.map((entry) => ({
      alias: entry.alias,
      host: entry.host,
      port: entry.port,
      username: entry.username,
      identityFile: entry.identityFile,
      proxyJump: entry.proxyJump,
      alreadyImported: importedAliases.has(entry.alias),
    }));
  }

  applyImport(inputs: SshHostInput[]): number {
    let added = 0;
    for (const input of inputs) {
      const hosts = [...this.hosts()];
      const id = this.freshId(input.label, hosts);
      hosts.push({
        id,
        label: input.label,
        host: input.host,
        port: input.port,
        username: input.username,
        auth: input.auth,
        identityFile: input.identityFile,
        proxyJump: input.proxyJump,
        tags: input.tags,
        remoteWorkdir: input.remoteWorkdir,
        forwards: [],
        importedFrom: 'ssh-config',
        lastConnectedAt: null,
      });
      this.writeHosts(hosts);
      added += 1;
    }
    return added;
  }

  // -------------------------------------------------------------------------

  private touchLastConnected(hostId: string): void {
    const hosts = this.hosts();
    const current = hosts.find((h) => h.id === hostId);
    if (!current) return;
    const next = hosts.map((h) =>
      h.id === hostId ? { ...current, lastConnectedAt: new Date().toISOString() } : h,
    );
    this.writeHosts(next);
  }

  private onConnectionEnd(hostId: string, reason: ConnectionEndReason): void {
    if (reason !== 'lost') return;
    const set = this.terminalsByHost.get(hostId);
    if (!set) return;
    for (const termId of set) {
      this.terminals.injectData(termId, '\r\n\x1b[31m[ssh: connection lost]\x1b[0m\r\n');
    }
  }
}
