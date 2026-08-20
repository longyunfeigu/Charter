import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SftpFileEntry, SftpSession } from '@pi-ide/ssh-service';
import type { SftpTransferState } from '@pi-ide/ipc-contracts';
import { SshSftpService, type SshSftpServiceDeps } from './ssh-sftp-service.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as unknown as SshSftpServiceDeps['logger'];

/** In-memory SftpSession fake: a Map of absolute paths → file/dir. */
function fakeSession(): {
  session: SftpSession;
  nodes: Map<string, { type: 'file' | 'dir'; data: string }>;
  closed: () => boolean;
} {
  const nodes = new Map<string, { type: 'file' | 'dir'; data: string }>([
    ['/home/u', { type: 'dir', data: '' }],
  ]);
  let closed = false;
  const closeCbs: Array<() => void> = [];
  const children = (dir: string): SftpFileEntry[] => {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const out: SftpFileEntry[] = [];
    for (const [p, n] of nodes) {
      if (p === dir || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.push({
        name: rest,
        type: n.type,
        symlink: false,
        size: n.data.length,
        mtimeMs: 0,
        mode: 0o644,
      });
    }
    return out;
  };
  const session: SftpSession = {
    realpath: async (p) => (p === '.' ? '/home/u' : p.replace(/\/+$/, '') || '/'),
    list: async (p) => children(p),
    mkdir: async (p) => void nodes.set(p, { type: 'dir', data: '' }),
    rename: async (from, to) => {
      const n = nodes.get(from);
      if (!n) throw new Error('no such file');
      nodes.delete(from);
      nodes.set(to, n);
    },
    delete: async (p) => {
      if (nodes.get(p)?.type !== 'file') throw new Error('not a file');
      nodes.delete(p);
    },
    rmdir: async (p) => {
      if (children(p).length > 0) throw new Error('not empty');
      nodes.delete(p);
    },
    chmod: async () => {},
    stat: async (p) => {
      const n = nodes.get(p);
      if (!n) throw new Error('no such file');
      return { type: n.type, size: n.data.length };
    },
    upload: async (localPath, remotePath, opts) => {
      if (opts?.signal?.aborted) throw new Error('aborted');
      nodes.set(remotePath, { type: 'file', data: `uploaded:${localPath}` });
      opts?.onProgress?.(10, 10);
    },
    download: async (_remotePath, _localPath, opts) => {
      if (opts?.signal?.aborted) throw new Error('aborted');
      opts?.onProgress?.(5, 5);
    },
    close: () => {
      closed = true;
      for (const cb of closeCbs) cb();
    },
    onClose: (cb) => void closeCbs.push(cb),
  };
  return { session, nodes, closed: () => closed };
}

function makeService(over: Partial<SshSftpServiceDeps> = {}): {
  service: SshSftpService;
  events: SftpTransferState[];
  fake: ReturnType<typeof fakeSession>;
} {
  const fake = fakeSession();
  const events: SftpTransferState[] = [];
  const service = new SshSftpService({
    openSession: async () => fake.session,
    chooseSavePath: async (name) => `/tmp/${name}`,
    emit: (state) => events.push(state),
    logger: silentLogger,
    ...over,
  });
  return { service, events, fake };
}

describe('SshSftpService', () => {
  it('lists via the cached session and resolves home', async () => {
    const { service, fake } = makeService();
    fake.nodes.set('/home/u/a.txt', { type: 'file', data: 'aaa' });
    fake.nodes.set('/home/u/dir', { type: 'dir', data: '' });
    expect(await service.home('h1')).toBe('/home/u');
    const { path, entries } = await service.list('h1', '/home/u/');
    expect(path).toBe('/home/u');
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'dir']);
    // No secret or absolute-local fields in the DTO shape.
    expect(Object.keys(entries[0]!).sort()).toEqual(['mtimeMs', 'name', 'size', 'symlink', 'type']);
  });

  it('uploads each dropped file and emits running→done with byte counts', async () => {
    const { service, events, fake } = makeService();
    const dir = mkdtempSync(join(tmpdir(), 'sftp-svc-'));
    const local = join(dir, 'drop.txt');
    writeFileSync(local, 'data');

    const ids = await service.upload('h1', '/home/u', [local]);
    expect(ids).toHaveLength(1);
    await vi.waitFor(() => {
      expect(events.some((e) => e.transferId === ids[0] && e.status === 'done')).toBe(true);
    });
    expect(fake.nodes.get('/home/u/drop.txt')?.data).toBe(`uploaded:${local}`);
    const done = events.find((e) => e.status === 'done');
    expect(done).toMatchObject({ direction: 'upload', name: 'drop.txt' });
    // Progress payloads carry names only, never local paths.
    expect(JSON.stringify(events)).not.toContain(dir);
  });

  it('rejects directory drops with a per-transfer error event', async () => {
    const { service, events } = makeService();
    const dir = mkdtempSync(join(tmpdir(), 'sftp-dir-'));
    const ids = await service.upload('h1', '/home/u', [dir]);
    await vi.waitFor(() => {
      expect(events.some((e) => e.transferId === ids[0] && e.status === 'error')).toBe(true);
    });
    expect(events.at(-1)?.error).toMatch(/folders/i);
  });

  it('download returns null when the user dismisses the save dialog', async () => {
    const { service } = makeService({ chooseSavePath: async () => null });
    expect(await service.download('h1', '/home/u/a.txt', 'a.txt')).toBeNull();
  });

  it('download streams to the chosen path and completes', async () => {
    const { service, events } = makeService();
    const id = await service.download('h1', '/home/u/a.txt', 'a.txt');
    expect(id).not.toBeNull();
    await vi.waitFor(() => {
      expect(events.some((e) => e.transferId === id && e.status === 'done')).toBe(true);
    });
  });

  it('download with localDir skips the dialog and uniquifies collisions', async () => {
    const chooseSavePath = vi.fn(async () => null);
    const { service, events } = makeService({ chooseSavePath });
    const dir = mkdtempSync(join(tmpdir(), 'sftp-dl-'));
    writeFileSync(join(dir, 'a.txt'), 'already here');

    const id = await service.download('h1', '/home/u/a.txt', 'a.txt', dir);
    expect(id).not.toBeNull();
    expect(chooseSavePath).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(events.some((e) => e.transferId === id && e.status === 'done')).toBe(true);
    });
    // The colliding name was uniquified — the event carries the final name only.
    const done = events.find((e) => e.transferId === id && e.status === 'done');
    expect(done?.name).toBe('a (1).txt');
    expect(JSON.stringify(events)).not.toContain(dir);
  });

  it('retry re-runs a failed transfer with retained endpoints; running ones refuse', async () => {
    let failFirst = true;
    const fake = fakeSession();
    const baseUpload = fake.session.upload;
    fake.session.upload = async (localPath, remotePath, opts) => {
      if (failFirst) {
        failFirst = false;
        throw new Error('connection lost');
      }
      await baseUpload(localPath, remotePath, opts);
    };
    const events: SftpTransferState[] = [];
    const service = new SshSftpService({
      openSession: async () => fake.session,
      chooseSavePath: async () => null,
      emit: (state) => events.push(state),
      logger: silentLogger,
    });
    const dir = mkdtempSync(join(tmpdir(), 'sftp-retry-'));
    const local = join(dir, 'r.txt');
    writeFileSync(local, 'retry me');

    const [firstId] = await service.upload('h1', '/home/u', [local]);
    await vi.waitFor(() => {
      expect(events.some((e) => e.transferId === firstId && e.status === 'error')).toBe(true);
    });

    const retryId = service.retry(firstId!);
    expect(retryId).not.toBeNull();
    expect(retryId).not.toBe(firstId);
    await vi.waitFor(() => {
      expect(events.some((e) => e.transferId === retryId && e.status === 'done')).toBe(true);
    });
    expect(fake.nodes.get('/home/u/r.txt')?.data).toBe(`uploaded:${local}`);
    // Unknown / still-running ids refuse.
    expect(service.retry('nope')).toBeNull();
  });

  it('recursive dir delete walks children but refuses oversized trees', async () => {
    const { service, fake } = makeService();
    fake.nodes.set('/home/u/d', { type: 'dir', data: '' });
    fake.nodes.set('/home/u/d/x.txt', { type: 'file', data: '1' });
    fake.nodes.set('/home/u/d/sub', { type: 'dir', data: '' });
    fake.nodes.set('/home/u/d/sub/y.txt', { type: 'file', data: '2' });
    await service.delete('h1', '/home/u/d', 'dir');
    expect([...fake.nodes.keys()].filter((p) => p.startsWith('/home/u/d'))).toEqual([]);

    fake.nodes.set('/home/u/big', { type: 'dir', data: '' });
    for (let i = 0; i < 2001; i++) {
      fake.nodes.set(`/home/u/big/f${i}`, { type: 'file', data: '' });
    }
    await expect(service.delete('h1', '/home/u/big', 'dir')).rejects.toThrow(/2000/);
  });

  it('panel close never tears down a channel that still carries a running transfer', async () => {
    const fake = fakeSession();
    let releaseDownload!: () => void;
    const gate = new Promise<void>((resolve) => (releaseDownload = resolve));
    fake.session.download = async (_remotePath, _localPath, opts) => {
      await gate; // a big file: the transfer outlives the Files panel
      if (opts?.signal?.aborted) throw new Error('aborted');
      opts?.onProgress?.(100, 100);
    };
    const events: SftpTransferState[] = [];
    const service = new SshSftpService({
      openSession: async () => fake.session,
      chooseSavePath: async (name) => `/tmp/${name}`,
      emit: (state) => events.push(state),
      logger: silentLogger,
      closeGraceMs: 5,
    });
    fake.nodes.set('/home/u/big.bin', { type: 'file', data: 'x'.repeat(64) });

    const id = await service.download('h1', '/home/u/big.bin', 'big.bin');
    expect(id).toBeTruthy();
    // The user leaves the Files panel mid-transfer.
    await service.close('h1');
    await new Promise((resolve) => setTimeout(resolve, 40)); // grace elapses
    expect(fake.closed()).toBe(false); // channel survives — the transfer owns it

    releaseDownload();
    await vi.waitFor(() => expect(events.at(-1)?.status).toBe('done'));
  });

  it('closeAll (app quit) still aborts running transfers and closes channels', async () => {
    const fake = fakeSession();
    let sawAbort = false;
    fake.session.download = async (_remotePath, _localPath, opts) => {
      await new Promise<void>((_resolve, reject) => {
        const fail = (): void => {
          sawAbort = true;
          reject(new Error('aborted'));
        };
        if (opts?.signal?.aborted) return fail();
        opts?.signal?.addEventListener('abort', fail);
      });
    };
    const events: SftpTransferState[] = [];
    const service = new SshSftpService({
      openSession: async () => fake.session,
      chooseSavePath: async (name) => `/tmp/${name}`,
      emit: (state) => events.push(state),
      logger: silentLogger,
    });
    fake.nodes.set('/home/u/big.bin', { type: 'file', data: 'x'.repeat(64) });
    await service.download('h1', '/home/u/big.bin', 'big.bin');
    service.closeAll();
    await vi.waitFor(() => expect(fake.closed()).toBe(true));
    await vi.waitFor(() => expect(sawAbort).toBe(true));
    await vi.waitFor(() => expect(events.at(-1)?.status).toBe('canceled'));
  });

  it('close() tears the session down after the grace window', async () => {
    const { service, fake } = makeService({ closeGraceMs: 20 });
    await service.home('h1');
    await service.close('h1');
    expect(fake.closed()).toBe(false); // deferred — not torn down synchronously
    await vi.waitFor(() => expect(fake.closed()).toBe(true));
  });

  it('a reopen within the grace window reuses the live channel (StrictMode-safe)', async () => {
    let opens = 0;
    const fakes: Array<ReturnType<typeof fakeSession>> = [];
    const service = new SshSftpService({
      openSession: async () => {
        opens += 1;
        const f = fakeSession();
        fakes.push(f);
        return f.session;
      },
      chooseSavePath: async () => null,
      emit: () => {},
      logger: silentLogger,
      closeGraceMs: 80,
    });
    await service.home('h1'); // opens channel #1
    await service.close('h1'); // schedule teardown
    await service.home('h1'); // reopen before grace elapses
    expect(opens).toBe(1); // reused, no second channel
    expect(fakes[0]?.closed()).toBe(false); // and the live one was not torn down
  });
});
