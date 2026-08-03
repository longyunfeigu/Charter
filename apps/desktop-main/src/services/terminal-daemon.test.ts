import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalTerminalBackendRequest, TerminalInfo } from '@pi-ide/terminal-service';
import { TerminalDaemonClient } from './terminal-daemon-client.js';
import { DaemonMessageDecoder, encodeDaemonMessage } from './terminal-daemon-protocol.js';
import { TerminalDaemonServer } from './terminal-daemon-server.js';

describe('terminal daemon protocol', () => {
  it('keeps an incomplete JSON frame until the rest arrives', () => {
    const decoder = new DaemonMessageDecoder<{ type: string }>();
    expect(decoder.push('{"type":"da')).toEqual([]);
    expect(decoder.push('ta"}\n')).toEqual([{ type: 'data' }]);
  });

  it('round-trips protocol messages as newline-delimited JSON', () => {
    const decoder = new DaemonMessageDecoder<{ type: string; data: string }>();
    const encoded = encodeDaemonMessage({ type: 'data', id: 't', sequence: 1, data: 'a\nb' });
    expect(decoder.push(encoded)).toEqual([{ type: 'data', id: 't', sequence: 1, data: 'a\nb' }]);
  });

  it('preserves UTF-8 characters split across socket chunks', () => {
    const decoder = new DaemonMessageDecoder<{ type: string; data: string }>();
    const encoded = Buffer.from(
      encodeDaemonMessage({ type: 'data', id: 't', sequence: 1, data: '中文 🐋' }),
    );
    const chinese = encoded.indexOf(Buffer.from('中'));
    const emoji = encoded.indexOf(Buffer.from('🐋'));

    expect(decoder.push(encoded.subarray(0, chinese + 1))).toEqual([]);
    expect(decoder.push(encoded.subarray(chinese + 1, emoji + 2))).toEqual([]);
    expect(decoder.push(encoded.subarray(emoji + 2))).toEqual([
      { type: 'data', id: 't', sequence: 1, data: '中文 🐋' },
    ]);
  });
});

describe.skipIf(process.platform === 'win32')('terminal daemon session survival', () => {
  let root = '';
  let server: TerminalDaemonServer | null = null;
  let first: TerminalDaemonClient | null = null;
  let second: TerminalDaemonClient | null = null;

  afterEach(async () => {
    first?.close();
    second?.close();
    await server?.close().catch(() => undefined);
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
    server = null;
    first = null;
    second = null;
  });

  it('reattaches to the same live PTY with a reconstructed xterm snapshot', async () => {
    root = mkdtempSync(join(tmpdir(), 'charter-terminal-daemon-test-'));
    const socketPath = join(root, 'daemon.sock');
    const tokenFile = join(root, 'token');
    writeFileSync(tokenFile, 'test-secret\n', { mode: 0o600 });
    server = new TerminalDaemonServer({
      socketPath,
      tokenFile,
      stateDir: join(root, 'sessions'),
      recordingsDir: join(root, 'recordings'),
    });
    await server.start();

    const connect = () =>
      TerminalDaemonClient.connect({
        socketPath,
        tokenFile,
        launchDaemon: () => {
          throw new Error('the test server should already be available');
        },
      });
    first = await connect();

    const info: TerminalInfo = {
      id: 'term_daemon_test',
      title: 'sh',
      shell: '/bin/sh',
      pid: -1,
      cwd: root,
      projectName: 'fixture',
      projectPath: root,
      contextKind: 'focused',
      contextLabel: 'fixture',
      contextTaskId: null,
      launch: 'shell',
      persistence: 'daemon',
    };
    const request: LocalTerminalBackendRequest = {
      info,
      executable: '/bin/sh',
      args: [],
      cwd: root,
      env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' },
      cols: 90,
      rows: 28,
      scrollback: 2000,
    };
    const firstBackend = first.createBackend(request).backend;
    let firstOutput = '';
    firstBackend.onData((data) => {
      firstOutput += data;
    });
    firstBackend.write("printf 'DAEMON_SURVIVED_ONE\\n'\r");
    await vi.waitFor(() => expect(firstOutput).toContain('DAEMON_SURVIVED_ONE'), { timeout: 5000 });

    first.close();
    first = null;
    second = await connect();
    const [restored] = second.restoredSessions();
    expect(restored?.info.id).toBe(info.id);
    expect(restored?.pid).toBeGreaterThan(0);
    // Connect lists only cheap descriptors. Full VT state is restored lazily
    // per adopted terminal so many dormant sessions cannot block startup.
    expect(restored?.replay).toBe('');

    const secondBackend = second.backendForRestored(restored!);
    let secondOutput = '';
    let restoredReplay = '';
    secondBackend.onData((data) => {
      secondOutput += data;
    });
    secondBackend.onResync?.((replay) => {
      restoredReplay = replay;
    });
    await vi.waitFor(() => expect(restoredReplay).toContain('DAEMON_SURVIVED_ONE'), {
      timeout: 5000,
    });
    secondBackend.write("printf 'DAEMON_SURVIVED_TWO\\n'\r");
    await vi.waitFor(() => expect(secondOutput).toContain('DAEMON_SURVIVED_TWO'), {
      timeout: 5000,
    });

    secondBackend.kill();
    await vi.waitFor(async () => expect(await second!.currentSnapshots()).toEqual([]), {
      timeout: 5000,
    });
  });

  it('reconnects a dropped daemon socket without exiting or replacing the PTY', async () => {
    root = mkdtempSync(join(tmpdir(), 'tdr-'));
    const socketPath = join(root, 'daemon.sock');
    const tokenFile = join(root, 'token');
    writeFileSync(tokenFile, 'test-secret\n', { mode: 0o600 });
    server = new TerminalDaemonServer({
      socketPath,
      tokenFile,
      stateDir: join(root, 'sessions'),
      recordingsDir: join(root, 'recordings'),
    });
    await server.start();
    first = await TerminalDaemonClient.connect({
      socketPath,
      tokenFile,
      launchDaemon: () => {
        throw new Error('the live test daemon must be reconnected, not replaced');
      },
    });

    const info: TerminalInfo = {
      id: 'term_socket_reconnect_test',
      title: 'sh',
      shell: '/bin/sh',
      pid: -1,
      cwd: root,
      projectName: 'fixture',
      projectPath: root,
      contextKind: 'focused',
      contextLabel: 'fixture',
      contextTaskId: null,
      launch: 'shell',
      persistence: 'daemon',
    };
    const backend = first.createBackend({
      info,
      executable: '/bin/sh',
      args: [],
      cwd: root,
      env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' },
      cols: 90,
      rows: 28,
      scrollback: 2000,
    }).backend;
    let output = '';
    let resync = '';
    const exits: number[] = [];
    backend.onData((data) => {
      output += data;
    });
    backend.onResync?.((replay) => {
      resync = replay;
    });
    backend.onExit((exitCode) => exits.push(exitCode));

    await vi.waitFor(() => expect(backend.processId?.()).toBeGreaterThan(0), { timeout: 5000 });
    const originalPid = backend.processId?.();
    backend.write("(sleep 0.1; printf 'SOCKET_RECONNECTED\\n') &\r");
    await vi.waitFor(() => expect(output).toContain('sleep 0.1'), { timeout: 5000 });

    const heldSocketPath = join(root, 'held.sock');
    renameSync(socketPath, heldSocketPath);
    const connections = (server as unknown as { connections: Set<{ socket: { destroy(): void } }> })
      .connections;
    for (const connection of connections) connection.socket.destroy();
    setTimeout(() => renameSync(heldSocketPath, socketPath), 300);

    await vi.waitFor(() => expect(`${resync}\n${output}`).toContain('SOCKET_RECONNECTED'), {
      timeout: 5000,
    });
    expect(exits).toEqual([]);
    expect(backend.processId?.()).toBe(originalPid);
    const [reconnected] = await first.currentSnapshots();
    expect(reconnected?.pid).toBe(originalPid);

    output = '';
    backend.write("printf 'INPUT_AFTER_RECONNECT\\n'\r");
    await vi.waitFor(() => expect(output).toContain('INPUT_AFTER_RECONNECT'), { timeout: 5000 });
    expect(exits).toEqual([]);
  });
});
