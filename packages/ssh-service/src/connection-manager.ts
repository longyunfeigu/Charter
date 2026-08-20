import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { Client, utils as sshUtils, type ClientChannel, type ConnectConfig } from 'ssh2';
import { createSftpSession } from './sftp.js';
import type {
  ExecResult,
  HostKeyStore,
  SftpSession,
  ShellSession,
  ShellSessionOptions,
  SshConnectionSnapshot,
  SshConnectionState,
  SshPromptBridge,
  SshSecretsProvider,
  SshTargetConfig,
} from './types.js';

/** Why a transport went away — the terminal bridge picks the banner line. */
export type ConnectionEndReason = 'lost' | 'closed';

export interface SshConnectionManagerDeps {
  hostKeys: HostKeyStore;
  prompts: SshPromptBridge;
  secrets: SshSecretsProvider;
  /** State fan-out for ssh.state broadcasts and UI dots. */
  onState?: (info: { hostId: string } & SshConnectionSnapshot) => void;
  /** Fired synchronously before per-channel close events so terminal bridges
   * can inject a "[ssh: connection lost]" line ahead of the exit banner. */
  onConnectionEnd?: (hostId: string, reason: ConnectionEndReason) => void;
  logger?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
  /** Backoff schedule for transport auto-reconnect (ADR-0047: capped, finite). */
  reconnectDelaysMs?: number[];
  /** Drop the transport this long after the last channel closes. */
  idleDisconnectMs?: number;
  /** Override agent socket resolution (tests). */
  agentSocket?: () => string | null;
  /** Resolve a ProxyJump spec ("alias" / "user@host[:port]") to a target — the
   * host book lives in the embedder, not here. Null = unresolvable. */
  resolveJumpTarget?: (spec: string, base: SshTargetConfig) => SshTargetConfig | null;
}

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 15000];
/** Short grace after the last channel/hold goes away — the card should read
 * "disconnected" soon after the last session exits, not five minutes later,
 * while still covering probe→shell transitions and quick relaunches. */
const DEFAULT_IDLE_DISCONNECT_MS = 10_000;
const READY_TIMEOUT_MS = 20000;

interface Managed {
  target: SshTargetConfig;
  client: Client | null;
  state: SshConnectionState;
  error: string | null;
  channels: Set<ClientChannel>;
  /** Deterministic per-session finalizers. ssh2 only emits a channel 'close'
   * once the server's reply arrives — which client.end() (or a dying socket)
   * can race away. disconnect()/transport-close run these directly so a
   * terminal exit never depends on that ack. */
  channelFinalizers: Map<ClientChannel, () => void>;
  /** Named keep-alive references (SFTP sessions, active forwards, jump uses).
   * The transport idles out only when channels AND holds are both empty. */
  holds: Set<string>;
  /** Jump host this transport rides through — released on transport close. */
  jumpHostId: string | null;
  /** Bumped on every fresh transport so stale event handlers no-op. */
  gen: number;
  attempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** True while the teardown was asked for (user, idle, shutdown) — no reconnect. */
  intentionalClose: boolean;
  connectPromise: Promise<void> | null;
}

function defaultAgentSocket(): string | null {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  // Windows OpenSSH agent service exposes a fixed named pipe.
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  return null;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One ssh2 transport per host, multiplexing shell/exec channels (ADR-0047).
 *
 * Secrets never live here: passwords/passphrases are pulled on demand from the
 * injected SshSecretsProvider (keychain) or an interactive prompt bridge, used
 * for the handshake, and dropped. Nothing secret is logged or kept on fields.
 */
export class SshConnectionManager {
  private readonly hosts = new Map<string, Managed>();
  private readonly reconnectDelays: number[];
  private readonly idleDisconnectMs: number;
  private readonly agentSocket: () => string | null;
  private holdSeq = 0;

  constructor(private readonly deps: SshConnectionManagerDeps) {
    this.reconnectDelays = deps.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.idleDisconnectMs = deps.idleDisconnectMs ?? DEFAULT_IDLE_DISCONNECT_MS;
    this.agentSocket = deps.agentSocket ?? defaultAgentSocket;
  }

  snapshot(hostId: string): SshConnectionSnapshot {
    const m = this.hosts.get(hostId);
    if (!m) return { state: 'disconnected', sessions: 0, error: null };
    return { state: m.state, sessions: m.channels.size, error: m.error };
  }

  /** Ensure a live transport to the target, reusing an existing one. */
  async connect(target: SshTargetConfig): Promise<void> {
    const m = this.managed(target);
    if (m.state === 'connected' && m.client) return;
    if (m.connectPromise) return m.connectPromise;
    if (m.reconnectTimer) {
      clearTimeout(m.reconnectTimer);
      m.reconnectTimer = null;
    }
    m.intentionalClose = false;
    m.attempts = 0;
    const attempt: Promise<void> = this.openTransport(m).finally(() => {
      // Only clear if a newer connect()/disconnect() hasn't already replaced us,
      // otherwise a late-settling superseded attempt would clobber the live one.
      if (m.connectPromise === attempt) m.connectPromise = null;
    });
    m.connectPromise = attempt;
    return attempt;
  }

  async openShell(target: SshTargetConfig, options: ShellSessionOptions): Promise<ShellSession> {
    await this.connect(target);
    const m = this.managed(target);
    const client = m.client;
    if (!client || m.state !== 'connected') {
      throw new Error(m.error ?? 'SSH connection is not available');
    }
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell(
        { term: options.term ?? 'xterm-256color', cols: options.cols, rows: options.rows },
        (err, stream) => (err ? reject(err) : resolve(stream)),
      );
    });
    this.trackChannel(m, channel);

    const dataListeners = new Set<(data: string) => void>();
    const closeListeners = new Set<(exitCode: number | null) => void>();
    let exitCode: number | null = null;
    let closed = false;
    channel.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const cb of dataListeners) cb(text);
    });
    channel.on('exit', (code: number | null) => {
      exitCode = code;
    });
    const finalize = (): void => {
      if (closed) return;
      closed = true;
      this.untrackChannel(m, channel);
      for (const cb of closeListeners) cb(exitCode);
    };
    m.channelFinalizers.set(channel, finalize);
    channel.on('close', finalize);
    return {
      write: (data) => {
        if (!closed) channel.write(data);
      },
      resize: (cols, rows) => {
        if (!closed) channel.setWindow(rows, cols, 0, 0);
      },
      close: () => {
        if (!closed) channel.close();
      },
      onData: (cb) => void dataListeners.add(cb),
      onClose: (cb) => void closeListeners.add(cb),
    };
  }

  /** Open an SFTP channel (PR2). The channel counts as a hold, so the
   * transport stays up while a file panel is open even with zero terminals. */
  async openSftp(target: SshTargetConfig): Promise<SftpSession> {
    await this.connect(target);
    const m = this.managed(target);
    const client = m.client;
    if (!client || m.state !== 'connected') {
      throw new Error(m.error ?? 'SSH connection is not available');
    }
    const wrapper = await new Promise<Parameters<typeof createSftpSession>[0]>((resolve, reject) =>
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))),
    );
    const token = `sftp:${++this.holdSeq}`;
    this.hold(target.id, token);
    const session = createSftpSession(wrapper);
    // ssh2's client SFTP object only emits 'close' when the transport dies —
    // an explicit end() goes unacknowledged — so release on both paths.
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      this.release(target.id, token);
    };
    session.onClose(releaseOnce);
    return {
      ...session,
      close: () => {
        session.close();
        releaseOnce();
      },
    };
  }

  /** Open a direct-tcpip channel to dstHost:dstPort through the target's
   * transport (PR3: local forwards and ProxyJump). The stream is NOT tracked
   * as a session — listeners/jumps keep the transport alive via holds. */
  async openForwardStream(
    target: SshTargetConfig,
    dstHost: string,
    dstPort: number,
    src: { host: string; port: number } = { host: '127.0.0.1', port: 0 },
  ): Promise<Duplex> {
    await this.connect(target);
    const m = this.managed(target);
    const client = m.client;
    if (!client || m.state !== 'connected') {
      throw new Error(m.error ?? 'SSH connection is not available');
    }
    return new Promise<Duplex>((resolve, reject) => {
      client.forwardOut(src.host, src.port, dstHost, dstPort, (err, stream) =>
        err ? reject(err) : resolve(stream),
      );
    });
  }

  /** Keep the transport alive on behalf of a non-channel user (SFTP panel,
   * active forward listener, a connection jumping through this host). */
  hold(hostId: string, token: string): void {
    const m = this.hosts.get(hostId);
    if (!m) return;
    m.holds.add(token);
    this.clearIdleTimer(m);
  }

  release(hostId: string, token: string): void {
    const m = this.hosts.get(hostId);
    if (!m || !m.holds.delete(token)) return;
    if (this.isIdle(m)) this.armIdleTimer(m);
  }

  /** Run a non-interactive command on its own exec channel. */
  async exec(target: SshTargetConfig, command: string, input?: string): Promise<ExecResult> {
    await this.connect(target);
    const m = this.managed(target);
    const client = m.client;
    if (!client || m.state !== 'connected') {
      throw new Error(m.error ?? 'SSH connection is not available');
    }
    return new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err);
        this.trackChannel(m, stream);
        let stdout = '';
        let stderr = '';
        let code: number | null = null;
        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        stream.on('exit', (c: number | null) => {
          code = c;
        });
        stream.on('close', () => {
          this.untrackChannel(m, stream);
          resolve({ code, stdout, stderr });
        });
        // Worker mutations use stdin JSON so file bytes never become shell
        // arguments (or renderer IPC). Ending stdin is also required for the
        // remote process to begin parsing the complete request.
        stream.end(input);
      });
    });
  }

  /** User-initiated teardown: closes every channel, never auto-reconnects. */
  async disconnect(hostId: string): Promise<boolean> {
    const m = this.hosts.get(hostId);
    if (!m) return false;
    m.intentionalClose = true;
    if (m.reconnectTimer) {
      clearTimeout(m.reconnectTimer);
      m.reconnectTimer = null;
    }
    this.clearIdleTimer(m);
    const hadTransport = m.client !== null || m.state !== 'disconnected';
    const channels = [...m.channels];
    if (channels.length > 0) this.deps.onConnectionEnd?.(hostId, 'closed');
    // Close each channel explicitly so every session's 'close' fires (and its
    // terminal exits) deterministically — client.end() alone does not always
    // emit per-channel close before the socket tears down.
    for (const channel of channels) {
      try {
        channel.close();
      } catch {
        /* already gone */
      }
    }
    // The local 'close' event above depends on the server's reply, which the
    // client.end() below can race away — finalize every session directly.
    for (const finalize of [...m.channelFinalizers.values()]) finalize();
    m.channelFinalizers.clear();
    m.client?.end();
    m.client = null;
    m.gen += 1;
    // Abandon any in-flight handshake attempt: bumping gen makes its handlers
    // supersede (end the client + reject), and dropping the reference lets the
    // next connect() start a fresh transport instead of awaiting the dead one.
    m.connectPromise = null;
    m.channels.clear();
    m.holds.clear();
    this.releaseJump(m);
    this.setState(m, 'disconnected', null);
    return hadTransport;
  }

  disconnectAll(): void {
    for (const hostId of [...this.hosts.keys()]) void this.disconnect(hostId);
  }

  // -------------------------------------------------------------------------

  private managed(target: SshTargetConfig): Managed {
    let m = this.hosts.get(target.id);
    if (!m) {
      m = {
        target,
        client: null,
        state: 'disconnected',
        error: null,
        channels: new Set(),
        channelFinalizers: new Map(),
        holds: new Set(),
        jumpHostId: null,
        gen: 0,
        attempts: 0,
        reconnectTimer: null,
        idleTimer: null,
        intentionalClose: false,
        connectPromise: null,
      };
      this.hosts.set(target.id, m);
    } else {
      // Latest saved host config wins on the next transport.
      m.target = target;
    }
    return m;
  }

  private setState(m: Managed, state: SshConnectionState, error: string | null): void {
    m.state = state;
    m.error = error;
    this.emitState(m);
  }

  private emitState(m: Managed): void {
    this.deps.onState?.({
      hostId: m.target.id,
      state: m.state,
      sessions: m.channels.size,
      error: m.error,
    });
  }

  private trackChannel(m: Managed, channel: ClientChannel): void {
    m.channels.add(channel);
    this.clearIdleTimer(m);
    this.emitState(m);
  }

  private untrackChannel(m: Managed, channel: ClientChannel): void {
    m.channelFinalizers.delete(channel);
    if (!m.channels.delete(channel)) return;
    this.emitState(m);
    if (this.isIdle(m)) this.armIdleTimer(m);
  }

  /** No channels, no holds, transport up — eligible for the idle teardown. */
  private isIdle(m: Managed): boolean {
    return m.channels.size === 0 && m.holds.size === 0 && m.state === 'connected';
  }

  private armIdleTimer(m: Managed): void {
    this.clearIdleTimer(m);
    if (this.idleDisconnectMs <= 0) return;
    m.idleTimer = setTimeout(() => {
      m.idleTimer = null;
      if (this.isIdle(m)) {
        this.deps.logger?.info('ssh idle disconnect', { hostId: m.target.id });
        void this.disconnect(m.target.id);
      }
    }, this.idleDisconnectMs);
    m.idleTimer.unref?.();
  }

  private clearIdleTimer(m: Managed): void {
    if (m.idleTimer) {
      clearTimeout(m.idleTimer);
      m.idleTimer = null;
    }
  }

  private async openTransport(m: Managed): Promise<void> {
    this.setState(m, m.attempts > 0 ? 'reconnecting' : 'connecting', m.error);
    const target = m.target;
    const gen = ++m.gen;
    const config = await this.buildConnectConfig(m);
    if (target.proxyJump) {
      try {
        config.sock = await this.openJumpSocket(m, target.proxyJump, gen);
      } catch (err) {
        this.setState(m, 'disconnected', errorMessage(err));
        throw err;
      }
    }
    const client = new Client();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      // A newer generation replaced this attempt (disconnect(), a reconnect, or
      // a fresh connect()). Close the now-orphaned transport — it may already be
      // authenticated — and settle so connect()'s finally clears connectPromise;
      // otherwise the leaked connection lingers and the host wedges forever.
      const superseded = (): void => {
        try {
          client.end();
        } catch {
          /* already gone */
        }
        settle(() => reject(new Error('SSH connection attempt superseded')));
      };
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        void this.deps.prompts
          .auth({
            hostId: target.id,
            kind: 'keyboard-interactive',
            prompts: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo ?? true })),
          })
          .then((answer) => finish(answer?.answers ?? []))
          .catch(() => finish([]));
      });
      client.on('ready', () => {
        if (m.gen !== gen) return superseded();
        settle(() => {
          // Interactive latency: a keystroke is a tiny SSH packet, and Node
          // sockets ship with Nagle enabled — each keypress would wait for the
          // previous packet's ACK before leaving the machine. OpenSSH sets
          // TCP_NODELAY on interactive sessions for the same reason. Through a
          // ProxyJump the inner "socket" is a forwarded channel without
          // setNoDelay; ssh2 type-checks before calling, so this is a no-op
          // there (the first hop's own connect() still gets the flag).
          client.setNoDelay(true);
          m.client = client;
          m.attempts = 0;
          this.setState(m, 'connected', null);
          if (this.isIdle(m)) this.armIdleTimer(m);
          resolve();
        });
      });
      client.on('error', (err) => {
        if (m.gen !== gen) return superseded();
        m.error = errorMessage(err);
        settle(() => reject(err));
      });
      client.on('close', () => {
        if (m.gen !== gen) return superseded();
        this.handleTransportClose(m, settled);
        settle(() => reject(new Error(m.error ?? 'SSH connection closed during handshake')));
      });
      client.connect(config);
    }).catch((err) => {
      // Only the still-current attempt drives reconnect / disconnected state; a
      // superseded one (gen bumped) must not fight the generation that owns it.
      if (m.gen === gen && (m.state === 'connecting' || m.state === 'reconnecting')) {
        if (!this.scheduleReconnect(m)) this.setState(m, 'disconnected', errorMessage(err));
      }
      throw err;
    });
  }

  /** Transport died after (or during) use. Decide banner + reconnect policy. */
  private handleTransportClose(m: Managed, wasReady: boolean): void {
    if (m.intentionalClose) return; // disconnect() already emitted state
    const hadChannels = m.channels.size > 0;
    if (hadChannels) this.deps.onConnectionEnd?.(m.target.id, 'lost');
    m.client = null;
    // Same determinism as disconnect(): a dead socket delivers no more channel
    // events, so run the session finalizers ourselves.
    for (const finalize of [...m.channelFinalizers.values()]) finalize();
    m.channelFinalizers.clear();
    m.channels.clear();
    this.clearIdleTimer(m);
    // Holds are NOT cleared: their owners (SFTP wrapper close, forward
    // listeners) release them, and forwards deliberately keep a reconnected
    // transport from idling out. The jump hold is ours to release.
    this.releaseJump(m);
    if (!wasReady) return; // handshake path surfaces its own error/retry
    this.deps.logger?.warn('ssh connection lost', { hostId: m.target.id, error: m.error });
    // Sessions cannot survive a transport loss anyway, so a bare transport is
    // only worth re-dialing when something is waiting on it (active forwards,
    // an open SFTP panel, a dependent jump). Otherwise show "disconnected" —
    // the card's Connect is the honest affordance.
    const wanted = m.holds.size > 0;
    if (!wanted || !this.scheduleReconnect(m)) {
      this.setState(m, 'disconnected', m.error ?? 'connection lost');
    }
  }

  /** Returns false when auto-reconnect is off or the backoff budget ran out. */
  private scheduleReconnect(m: Managed): boolean {
    if (!m.target.autoReconnect || m.intentionalClose) return false;
    if (m.attempts >= this.reconnectDelays.length) return false;
    const delay = this.reconnectDelays[m.attempts];
    m.attempts += 1;
    this.setState(m, 'reconnecting', m.error);
    m.reconnectTimer = setTimeout(() => {
      m.reconnectTimer = null;
      if (m.intentionalClose) return;
      void this.openTransport(m).catch(() => {
        // openTransport already updated state / scheduled the next attempt.
      });
    }, delay);
    m.reconnectTimer.unref?.();
    return true;
  }

  /** ProxyJump single hop (PR3): connect to the jump host through the normal
   * pipeline (its own host key check + auth), then open a direct-tcpip channel
   * to the real target and hand it to ssh2 as the transport socket. */
  private async openJumpSocket(m: Managed, spec: string, gen: number): Promise<Duplex> {
    const target = m.target;
    const jump = this.deps.resolveJumpTarget?.(spec, target) ?? null;
    if (!jump) {
      throw new Error(
        `Cannot resolve ProxyJump "${spec}" — save it as a host or use user@host[:port]`,
      );
    }
    if (jump.id === target.id) throw new Error('A host cannot jump through itself');
    if (jump.proxyJump) {
      throw new Error('Multi-hop ProxyJump is not supported (single hop only)');
    }
    const stream = await this.openForwardStream(jump, target.host, target.port);
    if (m.gen !== gen || m.intentionalClose) {
      stream.destroy();
      throw new Error('Connection attempt superseded');
    }
    m.jumpHostId = jump.id;
    this.hold(jump.id, `jump:${target.id}`);
    return stream;
  }

  private releaseJump(m: Managed): void {
    if (!m.jumpHostId) return;
    const jumpId = m.jumpHostId;
    m.jumpHostId = null;
    this.release(jumpId, `jump:${m.target.id}`);
  }

  private async buildConnectConfig(m: Managed): Promise<ConnectConfig> {
    const target = m.target;
    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: target.keepaliveSeconds > 0 ? target.keepaliveSeconds * 1000 : 0,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        void this.verifyHostKey(m, key)
          .then(verify)
          .catch(() => verify(false));
      },
    };
    switch (target.auth) {
      case 'agent': {
        const sock = this.agentSocket();
        if (!sock) {
          throw new Error(
            'No SSH agent available (SSH_AUTH_SOCK is not set) — use key or password auth for this host',
          );
        }
        config.agent = sock;
        break;
      }
      case 'key': {
        if (!target.identityFile) throw new Error('Host is set to key auth but has no key path');
        const keyPath = expandHome(target.identityFile);
        const keyData = await readFile(keyPath);
        config.privateKey = keyData;
        if (sshUtils.parseKey(keyData) instanceof Error) {
          // Encrypted (or otherwise unreadable without a passphrase).
          config.passphrase = await this.resolvePassphrase(target, keyData, keyPath);
        }
        break;
      }
      case 'password': {
        config.password = await this.resolvePassword(target);
        break;
      }
    }
    return config;
  }

  private async resolvePassphrase(
    target: SshTargetConfig,
    keyData: Buffer,
    keyPath: string,
  ): Promise<string> {
    const stored = await this.deps.secrets.passphrase(target.id);
    if (stored !== null && !(sshUtils.parseKey(keyData, stored) instanceof Error)) return stored;
    const answer = await this.deps.prompts.auth({
      hostId: target.id,
      kind: 'passphrase',
      prompts: [{ prompt: `Passphrase for ${keyPath}`, echo: false }],
    });
    const passphrase = answer?.answers[0];
    if (!passphrase) throw new Error('Key passphrase required');
    if (sshUtils.parseKey(keyData, passphrase) instanceof Error) {
      throw new Error('Invalid passphrase for private key');
    }
    if (answer.save) await this.deps.secrets.store(target.id, 'passphrase', passphrase);
    return passphrase;
  }

  private async resolvePassword(target: SshTargetConfig): Promise<string> {
    // A stored-but-wrong password surfaces as an auth failure; the user
    // re-enters it from the host card (PR1 keeps the flow single-shot).
    const stored = await this.deps.secrets.password(target.id);
    if (stored !== null) return stored;
    const answer = await this.deps.prompts.auth({
      hostId: target.id,
      kind: 'password',
      prompts: [{ prompt: `${target.username}@${target.host}'s password`, echo: false }],
    });
    const password = answer?.answers[0];
    if (!password) throw new Error('Password required');
    if (answer.save) await this.deps.secrets.store(target.id, 'password', password);
    return password;
  }

  private async verifyHostKey(m: Managed, key: Buffer): Promise<boolean> {
    const target = m.target;
    const check = this.deps.hostKeys.check(target.host, target.port, key);
    if (check.status === 'trusted') return true;
    const decision = await this.deps.prompts.hostKey({
      hostId: target.id,
      host: target.host,
      port: target.port,
      keyType: check.keyType,
      fingerprintSha256: check.fingerprintSha256,
      status: check.status,
      knownFingerprint: check.knownFingerprint,
    });
    if (!decision.accept) {
      m.error = 'Host key was not accepted';
      return false;
    }
    if (decision.remember) this.deps.hostKeys.remember(target.host, target.port, key);
    return true;
  }
}
