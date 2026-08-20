import { afterEach, describe, expect, it, vi } from 'vitest';
import { SshConnectionManager } from './connection-manager.js';
import { startFakeSshd, type FakeSshd } from './testing/fake-sshd.js';
import type {
  HostKeyStore,
  SshPromptBridge,
  SshSecretsProvider,
  SshTargetConfig,
} from './types.js';

const startServer = startFakeSshd;
type FakeServer = FakeSshd;

function trustingHostKeys(): HostKeyStore {
  return {
    check: () => ({
      status: 'trusted',
      fingerprintSha256: 'SHA256:test',
      keyType: 'ssh-ed25519',
      knownFingerprint: null,
    }),
    remember: () => {},
    forget: () => {},
  };
}

function noSecrets(): SshSecretsProvider {
  return {
    password: async () => null,
    passphrase: async () => null,
    store: async () => {},
  };
}

function autoAcceptPrompts(overrides: Partial<SshPromptBridge> = {}): SshPromptBridge {
  return {
    hostKey: async () => ({ accept: true, remember: false }),
    auth: async () => ({ answers: [], save: false }),
    ...overrides,
  };
}

function target(port: number, extra: Partial<SshTargetConfig> = {}): SshTargetConfig {
  return {
    id: 'host1',
    label: 'host1',
    host: '127.0.0.1',
    port,
    username: 'tester',
    auth: 'agent',
    identityFile: null,
    keepaliveSeconds: 0,
    autoReconnect: false,
    ...extra,
  };
}

describe('SshConnectionManager', () => {
  let servers: FakeServer[] = [];
  afterEach(async () => {
    for (const s of servers) await s.close();
    servers = [];
    vi.useRealTimers();
  });

  it('connects with an agent (accepting server) and opens a shell', async () => {
    const server = await startServer({ onShell: (ch) => ch.write('READY\r\n') });
    servers.push(server);
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: noSecrets(),
      agentSocket: () => '/tmp/fake-agent.sock', // never dialed: server accepts any method
    });
    const t = target(server.port);
    // The fake server accepts any auth method, so the agent socket is not used.
    const shell = await mgr.openShell(t, { cols: 80, rows: 24 });
    const data = await new Promise<string>((resolve) => shell.onData((d) => resolve(d)));
    expect(data).toContain('READY');
    expect(mgr.snapshot('host1').state).toBe('connected');
    expect(mgr.snapshot('host1').sessions).toBe(1);
    await mgr.disconnect('host1');
    expect(mgr.snapshot('host1').state).toBe('disconnected');
  });

  it('disables Nagle on the transport once connected (interactive keystroke latency)', async () => {
    const { Client } = await import('ssh2');
    const setNoDelay = vi.spyOn(Client.prototype, 'setNoDelay');
    try {
      const server = await startServer({ onShell: (ch) => ch.write('ok\r\n') });
      servers.push(server);
      const mgr = new SshConnectionManager({
        hostKeys: trustingHostKeys(),
        prompts: autoAcceptPrompts(),
        secrets: noSecrets(),
        agentSocket: () => '/tmp/fake-agent.sock',
      });
      await mgr.connect(target(server.port));
      expect(mgr.snapshot('host1').state).toBe('connected');
      expect(setNoDelay).toHaveBeenCalledWith(true);
    } finally {
      setNoDelay.mockRestore();
    }
  });

  it('authenticates with a stored password', async () => {
    const server = await startServer({ password: 's3cret', onShell: (ch) => ch.write('ok\r\n') });
    servers.push(server);
    const store = vi.fn(async () => {});
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: { password: async () => 's3cret', passphrase: async () => null, store },
    });
    await mgr.connect(target(server.port, { auth: 'password' }));
    expect(mgr.snapshot('host1').state).toBe('connected');
  });

  it('prompts for a password when none is stored and saves it when asked', async () => {
    const server = await startServer({ password: 'hunter2', onShell: (ch) => ch.write('ok\r\n') });
    servers.push(server);
    const store = vi.fn(async () => {});
    const auth = vi.fn(async () => ({ answers: ['hunter2'], save: true }));
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts({ auth }),
      secrets: { password: async () => null, passphrase: async () => null, store },
    });
    await mgr.connect(target(server.port, { auth: 'password' }));
    expect(auth).toHaveBeenCalledOnce();
    expect(store).toHaveBeenCalledWith('host1', 'password', 'hunter2');
  });

  it('rejects the connection when the host key is declined', async () => {
    const server = await startServer();
    servers.push(server);
    const mgr = new SshConnectionManager({
      hostKeys: {
        check: () => ({
          status: 'unknown',
          fingerprintSha256: 'SHA256:x',
          keyType: 'ssh-ed25519',
          knownFingerprint: null,
        }),
        remember: () => {},
        forget: () => {},
      },
      prompts: autoAcceptPrompts({ hostKey: async () => ({ accept: false, remember: false }) }),
      secrets: noSecrets(),
    });
    await expect(mgr.connect(target(server.port))).rejects.toBeTruthy();
    expect(mgr.snapshot('host1').state).toBe('disconnected');
  });

  it('remembers a host key on TOFU acceptance', async () => {
    const server = await startServer({ onShell: (ch) => ch.write('ok\r\n') });
    servers.push(server);
    const remember = vi.fn();
    const mgr = new SshConnectionManager({
      hostKeys: {
        check: () => ({
          status: 'unknown',
          fingerprintSha256: 'SHA256:x',
          keyType: 'ssh-ed25519',
          knownFingerprint: null,
        }),
        remember,
        forget: () => {},
      },
      prompts: autoAcceptPrompts({ hostKey: async () => ({ accept: true, remember: true }) }),
      secrets: noSecrets(),
    });
    await mgr.connect(target(server.port));
    expect(remember).toHaveBeenCalledOnce();
  });

  it('probes for a remote CLI via exec', async () => {
    const server = await startServer({
      execReplies: { "sh -lc 'command -v claude'": '/usr/local/bin/claude\n' },
    });
    servers.push(server);
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: noSecrets(),
    });
    const t = target(server.port);
    const found = await mgr.exec(t, "sh -lc 'command -v claude'");
    expect(found.stdout.trim()).toBe('/usr/local/bin/claude');
    expect(found.code).toBe(0);
    const missing = await mgr.exec(t, "sh -lc 'command -v codex'");
    expect(missing.code).toBe(127);
  });

  it('injects a lost-connection banner and drops to disconnected when reconnect is off', async () => {
    const server = await startServer({ onShell: (ch) => ch.write('live\r\n') });
    servers.push(server);
    const onConnectionEnd = vi.fn();
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: noSecrets(),
      onConnectionEnd,
    });
    const t = target(server.port, { autoReconnect: false });
    const shell = await mgr.openShell(t, { cols: 80, rows: 24 });
    const closed = new Promise<number | null>((resolve) => shell.onClose(resolve));
    // Kill the transport from the server side.
    server.dropConnections();
    const code = await closed;
    expect(code).toBeNull();
    expect(onConnectionEnd).toHaveBeenCalledWith('host1', 'lost');
    // Give the close handler a tick to settle state.
    await new Promise((r) => setTimeout(r, 20));
    expect(mgr.snapshot('host1').state).toBe('disconnected');
  });

  it('reconnects after a transport drop only while something holds the connection', async () => {
    const server = await startServer({ onShell: (ch) => ch.write('live\r\n') });
    servers.push(server);
    const states: string[] = [];
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: noSecrets(),
      reconnectDelaysMs: [50, 50],
      onState: (s) => states.push(s.state),
    });
    const t = target(server.port, { autoReconnect: true });
    await mgr.openShell(t, { cols: 80, rows: 24 });
    mgr.hold('host1', 'forward:f1'); // an active forward wants the transport back
    server.dropConnections();
    await vi.waitFor(() => expect(mgr.snapshot('host1').state).toBe('reconnecting'));
    expect(states).toContain('reconnecting');
    await vi.waitFor(() => expect(mgr.snapshot('host1').state).toBe('connected'), {
      timeout: 3000,
    });
    await mgr.disconnect('host1');
  });

  it('goes straight to disconnected on transport loss when nothing holds it', async () => {
    const server = await startServer({ onShell: (ch) => ch.write('live\r\n') });
    servers.push(server);
    const states: string[] = [];
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: noSecrets(),
      reconnectDelaysMs: [50, 50],
      onState: (s) => states.push(s.state),
    });
    await mgr.openShell(target(server.port, { autoReconnect: true }), { cols: 80, rows: 24 });
    server.dropConnections();
    await vi.waitFor(() => expect(mgr.snapshot('host1').state).toBe('disconnected'));
    expect(states).not.toContain('reconnecting');
  });

  it('auto-disconnects shortly after the last channel closes (no stale "connected" card)', async () => {
    const server = await startServer({ onShell: (ch) => ch.write('hi\r\n') });
    servers.push(server);
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: noSecrets(),
      idleDisconnectMs: 40,
    });
    const shell = await mgr.openShell(target(server.port), { cols: 80, rows: 24 });
    expect(mgr.snapshot('host1').state).toBe('connected');
    shell.close();
    await vi.waitFor(() => expect(mgr.snapshot('host1').state).toBe('disconnected'), {
      timeout: 2000,
    });
  });

  it('disconnect finalizes every open session without waiting for close acks', async () => {
    const server = await startServer({ onShell: (ch) => ch.write('hi\r\n') });
    servers.push(server);
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: noSecrets(),
    });
    const closes: number[] = [];
    const a = await mgr.openShell(target(server.port), { cols: 80, rows: 24 });
    const b = await mgr.openShell(target(server.port), { cols: 80, rows: 24 });
    a.onClose(() => closes.push(1));
    b.onClose(() => closes.push(2));
    expect(mgr.snapshot('host1').sessions).toBe(2);
    await mgr.disconnect('host1');
    // Both terminals exited synchronously with the disconnect — ssh2's channel
    // 'close' waits for the server's reply, which client.end() can race away,
    // so the manager must not depend on it (the e2e caught a lingering row).
    expect(closes.sort()).toEqual([1, 2]);
    expect(mgr.snapshot('host1')).toMatchObject({ state: 'disconnected', sessions: 0 });
  });

  it('holds (SFTP panel / active forward) keep an otherwise idle transport alive', async () => {
    const server = await startServer();
    servers.push(server);
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: noSecrets(),
      idleDisconnectMs: 40,
    });
    await mgr.connect(target(server.port));
    mgr.hold('host1', 'forward:f1');
    await new Promise((r) => setTimeout(r, 150));
    expect(mgr.snapshot('host1').state).toBe('connected');
    mgr.release('host1', 'forward:f1');
    await vi.waitFor(() => expect(mgr.snapshot('host1').state).toBe('disconnected'), {
      timeout: 2000,
    });
  });

  it('opens a direct-tcpip stream (local forward plumbing)', async () => {
    const server = await startServer({ tcpip: 'echo' });
    servers.push(server);
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: noSecrets(),
    });
    const stream = await mgr.openForwardStream(target(server.port), '127.0.0.1', 9999);
    const echoed = new Promise<string>((resolve) =>
      stream.once('data', (c: Buffer) => resolve(c.toString('utf8'))),
    );
    stream.write('ping');
    expect(await echoed).toBe('ping');
    stream.destroy();
    await mgr.disconnect('host1');
  });

  it('connects through a ProxyJump hop and releases the jump when done', async () => {
    const jumpServer = await startServer({ tcpip: 'proxy' });
    const targetServer = await startServer({ onShell: (ch) => ch.write('THROUGH\r\n') });
    servers.push(jumpServer, targetServer);
    const jumpTarget = target(jumpServer.port, { id: 'jump1', label: 'jump1' });
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: noSecrets(),
      idleDisconnectMs: 40,
      resolveJumpTarget: (spec) => (spec === 'jumphost' ? jumpTarget : null),
    });
    const t = target(targetServer.port, { proxyJump: 'jumphost' });
    const shell = await mgr.openShell(t, { cols: 80, rows: 24 });
    const data = await new Promise<string>((resolve) => shell.onData(resolve));
    expect(data).toContain('THROUGH');
    // The hop is a first-class connection (own host key + auth pipeline)…
    expect(mgr.snapshot('jump1').state).toBe('connected');
    // …held open by the dependent transport even with zero channels of its own.
    await new Promise((r) => setTimeout(r, 150));
    expect(mgr.snapshot('jump1').state).toBe('connected');
    await mgr.disconnect('host1');
    await vi.waitFor(() => expect(mgr.snapshot('jump1').state).toBe('disconnected'), {
      timeout: 2000,
    });
  });

  it('rejects multi-hop ProxyJump chains and self-jumps', async () => {
    const server = await startServer();
    servers.push(server);
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: noSecrets(),
      resolveJumpTarget: (spec) =>
        spec === 'chained'
          ? target(server.port, { id: 'mid', proxyJump: 'deeper' })
          : spec === 'self'
            ? target(server.port, { id: 'host1' })
            : null,
    });
    await expect(mgr.connect(target(server.port, { proxyJump: 'chained' }))).rejects.toThrow(
      /single hop/i,
    );
    await expect(mgr.connect(target(server.port, { proxyJump: 'self' }))).rejects.toThrow(
      /itself/i,
    );
    await expect(mgr.connect(target(server.port, { proxyJump: 'nowhere' }))).rejects.toThrow(
      /cannot resolve/i,
    );
  });

  it('disconnect during an in-flight handshake abandons it cleanly and leaves the host reconnectable', async () => {
    const server = await startServer({ password: 'pw', onShell: (ch) => ch.write('ok\r\n') });
    servers.push(server);
    // Block the first auth prompt (as an open password modal would); later
    // prompts resolve immediately.
    let releaseFirst: (() => void) | null = null;
    let firstSeen = false;
    const auth = async (): Promise<{ answers: string[]; save: boolean }> => {
      if (!firstSeen) {
        firstSeen = true;
        await new Promise<void>((r) => (releaseFirst = r));
      }
      return { answers: ['pw'], save: false };
    };
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts({ auth }),
      secrets: noSecrets(),
    });

    const first = mgr.connect(target(server.port, { auth: 'password' }));
    const firstOutcome = first.then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.waitFor(() => expect(releaseFirst).not.toBeNull());
    expect(mgr.snapshot('host1').state).toBe('connecting');

    // User disconnects (or deletes) the host while the handshake is still in
    // the auth prompt — this bumps the generation.
    await mgr.disconnect('host1');
    expect(mgr.snapshot('host1').state).toBe('disconnected');

    // Answering the now-stale prompt authenticates a transport that is
    // immediately superseded: it must be ended and the attempt must settle
    // (reject), not hang. Pre-fix this stayed pending forever.
    releaseFirst!();
    await expect(firstOutcome).resolves.toBe('rejected');

    // The host is NOT wedged: a fresh connect fully succeeds (pre-fix the stale
    // connectPromise was never cleared, so this hung too).
    await mgr.connect(target(server.port, { auth: 'password' }));
    expect(mgr.snapshot('host1').state).toBe('connected');
    await mgr.disconnect('host1');
  });

  it('fails agent auth cleanly when no agent socket is available', async () => {
    const server = await startServer({ password: 'pw' });
    servers.push(server);
    const mgr = new SshConnectionManager({
      hostKeys: trustingHostKeys(),
      prompts: autoAcceptPrompts(),
      secrets: noSecrets(),
      agentSocket: () => null,
    });
    await expect(mgr.connect(target(server.port, { auth: 'agent' }))).rejects.toThrow(/agent/i);
  });
});
