/**
 * Test-only loopback sshd built on ssh2's Server: shell/exec plus an
 * in-memory SFTP subsystem and direct-tcpip (echo or real proxy) support.
 * Used by the ssh-service unit tests; never shipped (not reachable from
 * index.ts) and never touches the real filesystem.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { constants as fsConstants } from 'node:fs';
import ssh2pkg, { type Connection, type ServerChannel } from 'ssh2';
import type { AddressInfo } from 'node:net';

const { Server, utils: sshUtils } = ssh2pkg;
const STATUS_CODE = sshUtils.sftp.STATUS_CODE;

// One key pair per process; generated at import, never on disk.
const hostKey = sshUtils.generateKeyPairSync('ed25519').private;

// ---------------------------------------------------------------------------
// In-memory remote filesystem

interface MemFile {
  type: 'file' | 'dir';
  data: Buffer;
  mtime: number;
}

export class MemFs {
  readonly nodes = new Map<string, MemFile>();

  constructor(public home = '/home/tester') {
    this.mkdirp(home);
  }

  mkdirp(path: string): void {
    const parts = path.split('/').filter(Boolean);
    let acc = '';
    this.nodes.set('/', { type: 'dir', data: Buffer.alloc(0), mtime: Date.now() });
    for (const part of parts) {
      acc += `/${part}`;
      if (!this.nodes.has(acc)) {
        this.nodes.set(acc, { type: 'dir', data: Buffer.alloc(0), mtime: Date.now() });
      }
    }
  }

  writeFile(path: string, data: Buffer | string): void {
    this.mkdirp(path.split('/').slice(0, -1).join('/') || '/');
    this.nodes.set(path, { type: 'file', data: Buffer.from(data), mtime: Date.now() });
  }

  normalize(path: string): string {
    if (path === '.' || path === '' || path === '~') return this.home;
    if (!path.startsWith('/')) return `${this.home}/${path}`;
    return path.replace(/\/+$/, '') || '/';
  }

  children(dir: string): Array<{ name: string; node: MemFile }> {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const out: Array<{ name: string; node: MemFile }> = [];
    for (const [p, node] of this.nodes) {
      if (p === dir || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      out.push({ name: rest, node });
    }
    return out;
  }
}

function attrsOf(node: MemFile): { mode: number; size: number; atime: number; mtime: number } {
  return {
    mode: (node.type === 'dir' ? fsConstants.S_IFDIR : fsConstants.S_IFREG) | 0o644,
    size: node.data.length,
    atime: Math.floor(node.mtime / 1000),
    mtime: Math.floor(node.mtime / 1000),
  };
}

// ---------------------------------------------------------------------------

export interface FakeSshdOptions {
  password?: string;
  execReplies?: Record<string, string>;
  /** Dynamic exec responder for stateful Worker/E2E commands. */
  onExec?: (
    command: string,
    input: string,
  ) =>
    | { stdout?: string; stderr?: string; code?: number }
    | Promise<{ stdout?: string; stderr?: string; code?: number }>;
  onShell?: (channel: ServerChannel) => void;
  /** In-memory FS served over SFTP; omit to reject the sftp subsystem. */
  fs?: MemFs;
  /** 'echo' answers direct-tcpip channels itself; 'proxy' dials the requested
   * destination for real (what a jump host does). */
  tcpip?: 'echo' | 'proxy';
}

export interface FakeSshd {
  port: number;
  connections: Connection[];
  /** Destroy the raw sockets — a real network loss, not a graceful SSH
   * disconnect. Connection.end() flushes its outgoing queue first, which can
   * delay the client-side 'close' unboundedly under load (flaky e2e). */
  dropConnections(): void;
  close(): Promise<void>;
}

export function startFakeSshd(opts: FakeSshdOptions = {}): Promise<FakeSshd> {
  const connections: Connection[] = [];
  const sockets: Socket[] = [];
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    connections.push(client);
    // ssh2's Server API hides the raw socket; keep it for dropConnections().
    const sock = (client as unknown as { _sock?: Socket })._sock;
    if (sock) sockets.push(sock);
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (opts.password !== undefined) {
        if (ctx.method === 'password' && ctx.password === opts.password) return ctx.accept();
        if (ctx.method === 'password') return ctx.reject();
        return ctx.reject(['password']);
      }
      ctx.accept();
    });
    client.on('ready', () => {
      if (opts.tcpip) {
        client.on('tcpip', (accept, reject, info) => {
          const stream = accept();
          if (opts.tcpip === 'echo') {
            stream.on('data', (chunk: Buffer) => stream.write(chunk));
            return;
          }
          const outbound = netConnect(info.destPort, info.destIP);
          outbound.on('connect', () => {
            stream.pipe(outbound).pipe(stream);
          });
          outbound.on('error', () => stream.close());
          stream.on('close', () => outbound.destroy());
        });
      }
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (ptyAccept) => ptyAccept?.());
        session.on('shell', (shellAccept) => {
          const channel = shellAccept();
          if (opts.onShell) opts.onShell(channel);
          else channel.write('welcome\r\n');
        });
        session.on('exec', (execAccept, _reject, info) => {
          const channel = execAccept();
          const staticReply = opts.execReplies?.[info.command];
          if (staticReply !== undefined) {
            channel.write(staticReply);
            channel.exit(0);
            channel.end();
            return;
          }
          if (opts.onExec) {
            let input = '';
            channel.on('data', (chunk: Buffer) => {
              input += chunk.toString('utf8');
            });
            channel.on('end', () => {
              void Promise.resolve(opts.onExec!(info.command, input)).then(
                (response) => {
                  if (response.stdout) channel.write(response.stdout);
                  if (response.stderr) channel.stderr.write(response.stderr);
                  channel.exit(response.code ?? 0);
                  channel.end();
                },
                (error) => {
                  channel.stderr.write(error instanceof Error ? error.message : String(error));
                  channel.exit(1);
                  channel.end();
                },
              );
            });
            return;
          }
          channel.stderr.write('not found\n');
          channel.exit(127);
          channel.end();
        });
        if (opts.fs) attachSftp(session, opts.fs);
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        connections,
        dropConnections: () => {
          for (const sock of sockets.splice(0)) {
            try {
              sock.destroy();
            } catch {
              /* already gone */
            }
          }
        },
        close: () =>
          new Promise<void>((res) => {
            for (const c of connections) {
              try {
                c.end();
              } catch {
                /* already gone */
              }
            }
            server.close(() => res());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Minimal SFTP subsystem over MemFs — enough for realpath/list/stat/transfer/
// mkdir/rmdir/remove/rename, which is exactly the SftpSession surface.

type SftpServer = {
  on(event: string, cb: (...args: never[]) => void): SftpServer;
  handle(reqid: number, handle: Buffer): void;
  status(reqid: number, code: number): void;
  name(reqid: number, names: Array<{ filename: string; longname: string; attrs?: object }>): void;
  attrs(reqid: number, attrs: object): void;
  data(reqid: number, data: Buffer): void;
};

function attachSftp(
  session: { on(ev: 'sftp', cb: (accept: () => unknown) => void): void },
  fs: MemFs,
): void {
  session.on('sftp', (accept) => {
    const sftp = accept() as SftpServer;
    interface DirHandle {
      kind: 'dir';
      path: string;
      listed: boolean;
    }
    interface FileHandle {
      kind: 'file';
      path: string;
    }
    const handles = new Map<string, DirHandle | FileHandle>();
    let seq = 0;
    const open = (h: DirHandle | FileHandle): Buffer => {
      const id = `h${++seq}`;
      handles.set(id, h);
      return Buffer.from(id);
    };
    const get = (buf: Buffer): DirHandle | FileHandle | undefined => handles.get(buf.toString());

    const statReply = (reqid: number, rawPath: string): void => {
      const path = fs.normalize(rawPath);
      const node = fs.nodes.get(path);
      if (!node) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      sftp.attrs(reqid, attrsOf(node));
    };

    sftp
      .on('REALPATH', (reqid: number, given: string) => {
        const resolved = fs.normalize(given);
        sftp.name(reqid, [{ filename: resolved, longname: resolved }]);
      })
      .on('OPENDIR', (reqid: number, rawPath: string) => {
        const path = fs.normalize(rawPath);
        const node = fs.nodes.get(path);
        if (!node || node.type !== 'dir') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        sftp.handle(reqid, open({ kind: 'dir', path, listed: false }));
      })
      .on('READDIR', (reqid: number, handle: Buffer) => {
        const h = get(handle);
        if (!h || h.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
        if (h.listed) return sftp.status(reqid, STATUS_CODE.EOF);
        h.listed = true;
        const names = fs.children(h.path).map(({ name, node }) => ({
          filename: name,
          longname: name,
          attrs: attrsOf(node),
        }));
        sftp.name(reqid, names);
      })
      .on('STAT', statReply)
      .on('LSTAT', statReply)
      .on('SETSTAT', (reqid: number) => {
        // Modes are not material to this in-memory fixture; acknowledging the
        // request keeps its SFTP contract aligned with production chmod.
        sftp.status(reqid, STATUS_CODE.OK);
      })
      .on('OPEN', (reqid: number, rawPath: string, flags: number) => {
        const path = fs.normalize(rawPath);
        const wantsWrite = (flags & sshUtils.sftp.OPEN_MODE.WRITE) !== 0;
        if (wantsWrite) fs.writeFile(path, Buffer.alloc(0));
        else if (fs.nodes.get(path)?.type !== 'file') {
          return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        }
        sftp.handle(reqid, open({ kind: 'file', path }));
      })
      .on('FSTAT', (reqid: number, handle: Buffer) => {
        const h = get(handle);
        if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
        statReply(reqid, h.path);
      })
      .on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
        const h = get(handle);
        const node = h ? fs.nodes.get(h.path) : undefined;
        if (!h || !node) return sftp.status(reqid, STATUS_CODE.FAILURE);
        const end = offset + data.length;
        const grown = end > node.data.length ? Buffer.alloc(end) : node.data;
        if (grown !== node.data) node.data.copy(grown);
        data.copy(grown, offset);
        node.data = grown;
        sftp.status(reqid, STATUS_CODE.OK);
      })
      .on('READ', (reqid: number, handle: Buffer, offset: number, length: number) => {
        const h = get(handle);
        const node = h ? fs.nodes.get(h.path) : undefined;
        if (!h || !node) return sftp.status(reqid, STATUS_CODE.FAILURE);
        if (offset >= node.data.length) return sftp.status(reqid, STATUS_CODE.EOF);
        sftp.data(reqid, node.data.subarray(offset, offset + length));
      })
      .on('CLOSE', (reqid: number, handle: Buffer) => {
        handles.delete(handle.toString());
        sftp.status(reqid, STATUS_CODE.OK);
      })
      .on('MKDIR', (reqid: number, rawPath: string) => {
        fs.mkdirp(fs.normalize(rawPath));
        sftp.status(reqid, STATUS_CODE.OK);
      })
      .on('RMDIR', (reqid: number, rawPath: string) => {
        const path = fs.normalize(rawPath);
        if (fs.nodes.get(path)?.type !== 'dir') return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        if (fs.children(path).length > 0) return sftp.status(reqid, STATUS_CODE.FAILURE);
        fs.nodes.delete(path);
        sftp.status(reqid, STATUS_CODE.OK);
      })
      .on('REMOVE', (reqid: number, rawPath: string) => {
        const path = fs.normalize(rawPath);
        if (fs.nodes.get(path)?.type !== 'file')
          return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        fs.nodes.delete(path);
        sftp.status(reqid, STATUS_CODE.OK);
      })
      .on('RENAME', (reqid: number, fromRaw: string, toRaw: string) => {
        const from = fs.normalize(fromRaw);
        const to = fs.normalize(toRaw);
        const node = fs.nodes.get(from);
        if (!node) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        const prefix = `${from}/`;
        for (const [p, n] of [...fs.nodes]) {
          if (p === from) {
            fs.nodes.delete(p);
            fs.nodes.set(to, n);
          } else if (p.startsWith(prefix)) {
            fs.nodes.delete(p);
            fs.nodes.set(`${to}/${p.slice(prefix.length)}`, n);
          }
        }
        sftp.status(reqid, STATUS_CODE.OK);
      });
  });
}
