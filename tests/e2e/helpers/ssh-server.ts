// Loopback SSH server for e2e — no system sshd required, three platforms
// alike. Built on the shared ssh-service test sshd (shell/exec + in-memory
// SFTP + direct-tcpip echo). Host keys are generated per process, never on
// disk, so the app's TOFU modal always fires on first connect.
import {
  MemFs,
  startFakeSshd,
  type FakeSshd,
} from '../../../packages/ssh-service/src/testing/fake-sshd';
import { remoteCliProbeCommand } from '../../../apps/desktop-main/src/services/ssh-terminal-bridge';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export { MemFs };

export interface FakeSshServer {
  port: number;
  /** In-memory FS served over SFTP (seed files before/inspect after). */
  fs: MemFs;
  /** Raw text received by remote shell channels, in arrival order. */
  shellInput: string[];
  /** Drop every live connection (simulate a network loss). */
  dropConnections(): void;
  /** Gracefully end only the most recently opened shell channel. */
  closeLatestShell(): void;
  /** Write raw bytes out of the most recent shell (e.g. an OSC 7 cwd report). */
  writeToLatestShell(text: string): void;
  close(): Promise<void>;
}

export interface FakeSshOptions {
  /** Accepted password; anything else is rejected. */
  password?: string;
  /** Banner the shell prints once it opens. */
  shellBanner?: string;
  /** CLIs that the login-shell probe should report as installed. */
  installedClis?: string[];
  /** Marker line printed when the shell receives an installed Agent launch. */
  claudeMarker?: string;
  /** Seed the SFTP filesystem (defaults to a home dir with two entries). */
  fs?: MemFs;
  /** ADR-0059: when set, the shell answers the app's cwd-sync injection
   * (`__charter_cwd`) with an OSC 7 report for this directory — what a real
   * bash/zsh would do on its next prompt. */
  cwdReport?: string;
}

export async function startFakeSshServer(opts: FakeSshOptions = {}): Promise<FakeSshServer> {
  const banner = opts.shellBanner ?? 'fake-sshd ready';
  const installed = opts.installedClis ?? ['claude', 'codex'];
  const claudeMarker = opts.claudeMarker ?? 'REMOTE-CLI-STARTED';
  const fs = opts.fs ?? new MemFs('/home/tester');
  const shellChannels: Array<{
    exit(code: number): void;
    end(): void;
    write(data: string): void;
  }> = [];
  const shellInput: string[] = [];

  const execReplies: Record<string, string> = {};
  for (const cli of installed) {
    execReplies[remoteCliProbeCommand(cli)] = `/root/.nvm/versions/node/v24.19.0/bin/${cli}\n`;
  }
  execReplies[remoteCliProbeCommand('node')] = '/usr/bin/node\n';

  const workerBytes = readFileSync(
    join(process.cwd(), 'apps', 'desktop-main', 'dist', 'remote-session-worker.cjs'),
  );
  const workerHash = createHash('sha256').update(workerBytes).digest('hex');
  const fakeCliSessionId = '11111111-2222-4333-8444-555555555555';
  const workerSessions = new Map<
    string,
    { root: string; workspaceKind: 'remote' | 'local'; baseline: Map<string, Buffer> }
  >();
  const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const quoteArg = (command: string, name: string): string | null => {
    const match = new RegExp(`--${name} '([^']+)'`).exec(command);
    return match?.[1] ?? null;
  };
  const snapshot = (root: string): Map<string, Buffer> => {
    const prefix = root === '/' ? '/' : `${root}/`;
    const result = new Map<string, Buffer>();
    for (const [path, node] of fs.nodes) {
      if (node.type !== 'file' || !path.startsWith(prefix)) continue;
      const relative = path.slice(prefix.length);
      if (
        !relative ||
        relative.split('/').some((part) => ['.git', '.charter', 'node_modules'].includes(part))
      ) {
        continue;
      }
      result.set(relative, Buffer.from(node.data));
    }
    return result;
  };
  const workerReply = (payload: Record<string, unknown>, code = 0) => ({
    stdout: `${JSON.stringify({ ok: code === 0, ...payload })}\n`,
    code,
  });

  const server: FakeSshd = await startFakeSshd({
    password: opts.password ?? 'e2e-password',
    execReplies,
    fs,
    tcpip: 'echo',
    onExec: (command, input) => {
      if (command === "'/usr/bin/node' -p 'process.versions.node'") {
        return { stdout: '24.19.0\n', code: 0 };
      }
      const mkdir = /mkdir -p -- '([^']+)'/.exec(command);
      if (mkdir?.[1]) {
        fs.mkdirp(mkdir[1]);
        return workerReply({});
      }
      const move = /mv -f -- '([^']+)' '([^']+)'/.exec(command);
      if (move?.[1] && move[2]) {
        const uploaded = fs.nodes.get(move[1]);
        if (!uploaded) return workerReply({ error: 'uploaded Worker missing' }, 1);
        fs.nodes.set(move[2], uploaded);
        fs.nodes.delete(move[1]);
        return workerReply({});
      }
      if (/remote-session-worker\.cjs' hello$/.test(command)) {
        return workerReply({
          protocol: 1,
          version: '1.2.0',
          sha256: workerHash,
          capabilities: [
            'baseline',
            'changes',
            'inspect',
            'apply',
            'conflict-check',
            'session-discovery',
            'local-workspace-bridge',
          ],
        });
      }
      if (/remote-session-worker\.cjs' start /.test(command)) {
        const sessionId = quoteArg(command, 'session');
        const root = quoteArg(command, 'root');
        const workspaceKind = quoteArg(command, 'workspace');
        if (
          !sessionId ||
          !root ||
          (workspaceKind !== 'remote' && workspaceKind !== 'local') ||
          (workspaceKind === 'local' && root !== `/home/tester/.charter/workspaces/${sessionId}`)
        ) {
          return workerReply({ error: 'bad start request' }, 1);
        }
        workerSessions.set(sessionId, { root, workspaceKind, baseline: snapshot(root) });
        return workerReply({
          sessionId,
          root,
          baselineKind: 'files',
          baselineRef: null,
          fileCount: workerSessions.get(sessionId)!.baseline.size,
        });
      }
      if (/remote-session-worker\.cjs' changes /.test(command)) {
        const sessionId = quoteArg(command, 'session');
        const state = sessionId ? workerSessions.get(sessionId) : null;
        if (!sessionId || !state) return workerReply({ error: 'unknown session' }, 1);
        const current = snapshot(state.root);
        const paths = [...new Set([...state.baseline.keys(), ...current.keys()])].sort();
        const entries = paths.flatMap((path) => {
          const before = state.baseline.get(path) ?? null;
          const after = current.get(path) ?? null;
          if (before && after && before.equals(after)) return [];
          return [
            {
              path,
              kind: before ? (after ? 'modified' : 'deleted') : 'created',
              beforeHash: before ? hash(before) : null,
              afterHash: after ? hash(after) : null,
              beforeBase64: before?.toString('base64') ?? null,
              afterBase64: after?.toString('base64') ?? null,
              beforeMode: before ? 0o644 : null,
              afterMode: after ? 0o644 : null,
            },
          ];
        });
        return workerReply({ sessionId, root: state.root, entries });
      }
      if (/remote-session-worker\.cjs' inspect /.test(command)) {
        const sessionId = quoteArg(command, 'session');
        const state = sessionId ? workerSessions.get(sessionId) : null;
        if (!sessionId || !state) return workerReply({ error: 'unknown session' }, 1);
        const request = JSON.parse(input) as { paths: string[] };
        const current = snapshot(state.root);
        const entries = request.paths.map((path) => {
          const before = state.baseline.get(path) ?? null;
          const after = current.get(path) ?? null;
          return {
            path,
            kind: before ? (after ? 'modified' : 'deleted') : 'created',
            beforeHash: before ? hash(before) : null,
            afterHash: after ? hash(after) : null,
            beforeBase64: before?.toString('base64') ?? null,
            afterBase64: after?.toString('base64') ?? null,
            beforeMode: before ? 0o644 : null,
            afterMode: after ? 0o644 : null,
          };
        });
        return workerReply({ sessionId, root: state.root, entries });
      }
      if (/remote-session-worker\.cjs' apply /.test(command)) {
        const sessionId = quoteArg(command, 'session');
        const state = sessionId ? workerSessions.get(sessionId) : null;
        if (!sessionId || !state) return workerReply({ error: 'unknown session' }, 1);
        const request = JSON.parse(input) as {
          entries: Array<{
            path: string;
            expectedHash: string | null;
            dataBase64: string | null;
          }>;
        };
        const conflicts = request.entries.flatMap((entry) => {
          const node = fs.nodes.get(`${state.root}/${entry.path}`);
          const actualHash = node?.type === 'file' ? hash(node.data) : null;
          return actualHash === entry.expectedHash
            ? []
            : [{ path: entry.path, expectedHash: entry.expectedHash, actualHash }];
        });
        if (conflicts.length > 0) {
          return workerReply(
            {
              error:
                'Remote files changed after the last sync. Refresh Diff before applying review decisions.',
              conflicts,
            },
            1,
          );
        }
        const applied = request.entries.map((entry) => {
          const path = `${state.root}/${entry.path}`;
          if (entry.dataBase64 === null) fs.nodes.delete(path);
          else fs.writeFile(path, Buffer.from(entry.dataBase64, 'base64'));
          return {
            path: entry.path,
            hash: entry.dataBase64 === null ? null : hash(Buffer.from(entry.dataBase64, 'base64')),
          };
        });
        return workerReply({ sessionId, applied });
      }
      if (/remote-session-worker\.cjs' stop /.test(command)) {
        const sessionId = quoteArg(command, 'session');
        return workerReply({ sessionId, retainedForReview: true });
      }
      if (/remote-session-worker\.cjs' discover /.test(command)) {
        const sessionId = quoteArg(command, 'session');
        const cli = quoteArg(command, 'cli');
        return workerReply({ sessionId, cli, cliSessionId: fakeCliSessionId });
      }
      if (/remote-session-worker\.cjs' destroy /.test(command)) {
        const sessionId = quoteArg(command, 'session');
        const state = sessionId ? workerSessions.get(sessionId) : null;
        if (state?.workspaceKind === 'local') {
          const prefix = `${state.root}/`;
          for (const path of [...fs.nodes.keys()]) {
            if (path === state.root || path.startsWith(prefix)) fs.nodes.delete(path);
          }
        }
        if (sessionId) workerSessions.delete(sessionId);
        return workerReply({ sessionId, destroyed: true });
      }
      return { stderr: 'not found\n', code: 127 };
    },
    onShell: (channel) => {
      shellChannels.push(channel);
      channel.write(`${banner}\r\n`);
      // Echo nothing; when the app sends `exec <cli>`, print the marker line.
      channel.on('data', (data: Buffer) => {
        const text = data.toString('utf8');
        shellInput.push(text);
        // ADR-0059: a real bash/zsh would run the injected hook at its next
        // prompt; the fake shell answers the injection with the OSC 7 report.
        if (opts.cwdReport && text.includes('__charter_cwd')) {
          channel.write(`\u001b]7;file://fake${opts.cwdReport}\u001b\\`);
        }
        if (
          installed.some((cli) =>
            new RegExp(`(?:^|\\s)exec\\s+${cli.replaceAll('.', '\\.')}(?:\\s|\\r|$)`).test(text),
          )
        ) {
          channel.write(`\u001b[?2004h${claudeMarker}\r\n`);
        }
      });
    },
  });

  return {
    port: server.port,
    fs,
    shellInput,
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
    writeToLatestShell(text: string) {
      shellChannels.at(-1)?.write(text);
    },
    close: () => server.close(),
  };
}
