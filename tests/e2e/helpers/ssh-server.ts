// Loopback SSH server for e2e — no system sshd required, three platforms
// alike. Built on the shared ssh-service test sshd (shell/exec + in-memory
// SFTP + direct-tcpip echo). Host keys are generated per process, never on
// disk, so the app's TOFU modal always fires on first connect.
import {
  MemFs,
  startFakeSshd,
  type FakeSshd,
} from '../../../packages/ssh-service/src/testing/fake-sshd';

export { MemFs };

export interface FakeSshServer {
  port: number;
  /** In-memory FS served over SFTP (seed files before/inspect after). */
  fs: MemFs;
  /** Drop every live connection (simulate a network loss). */
  dropConnections(): void;
  /** Gracefully end only the most recently opened shell channel. */
  closeLatestShell(): void;
  close(): Promise<void>;
}

export interface FakeSshOptions {
  /** Accepted password; anything else is rejected. */
  password?: string;
  /** Banner the shell prints once it opens. */
  shellBanner?: string;
  /** CLIs that `command -v <cli>` should report as installed. */
  installedClis?: string[];
  /** Marker line printed when the shell receives an `exec claude` / `exec codex`. */
  claudeMarker?: string;
  /** Seed the SFTP filesystem (defaults to a home dir with two entries). */
  fs?: MemFs;
}

export async function startFakeSshServer(opts: FakeSshOptions = {}): Promise<FakeSshServer> {
  const banner = opts.shellBanner ?? 'fake-sshd ready';
  const installed = opts.installedClis ?? ['claude', 'codex'];
  const claudeMarker = opts.claudeMarker ?? 'REMOTE-CLI-STARTED';
  const fs = opts.fs ?? new MemFs('/home/tester');
  const shellChannels: Array<{ exit(code: number): void; end(): void }> = [];

  const execReplies: Record<string, string> = {};
  for (const cli of installed) {
    execReplies[`sh -lc 'command -v ${cli}'`] = `/usr/local/bin/${cli}\n`;
  }

  const server: FakeSshd = await startFakeSshd({
    password: opts.password ?? 'e2e-password',
    execReplies,
    fs,
    tcpip: 'echo',
    onShell: (channel) => {
      shellChannels.push(channel);
      channel.write(`${banner}\r\n`);
      // Echo nothing; when the app sends `exec <cli>`, print the marker line.
      channel.on('data', (data: Buffer) => {
        if (/exec\s+(claude|codex)/.test(data.toString('utf8'))) {
          channel.write(`${claudeMarker}\r\n`);
        }
      });
    },
  });

  return {
    port: server.port,
    fs,
    dropConnections() {
      // Raw-socket destroy: a graceful Connection.end() flushes its outgoing
      // queue first, which can defer the client's 'close' past e2e timeouts.
      server.dropConnections();
    },
    closeLatestShell() {
      const channel = shellChannels.at(-1);
      channel?.exit(0);
      channel?.end();
    },
    close: () => server.close(),
  };
}
