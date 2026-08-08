import { createReadStream, createWriteStream } from 'node:fs';
import { stat as fsStat, unlink as fsUnlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { SftpEntryType, SftpFileEntry, SftpSession, SftpTransferOptions } from './types.js';

/** POSIX join — SFTP paths are always forward-slash, even from Windows. */
export function sftpJoin(dir: string, name: string): string {
  if (dir.endsWith('/')) return `${dir}${name}`;
  return `${dir}/${name}`;
}

function entryType(attrs: Stats): SftpEntryType {
  if (attrs.isDirectory()) return 'dir';
  if (attrs.isFile()) return 'file';
  if (attrs.isSymbolicLink()) return 'symlink';
  return 'other';
}

/**
 * Wrap one ssh2 SFTPWrapper channel behind the product SftpSession contract.
 * Transfers go through stream.pipeline with an AbortSignal so cancel tears the
 * streams down mid-flight instead of waiting for the file to finish.
 */
export function createSftpSession(sftp: SFTPWrapper): SftpSession {
  const realpath = (path: string): Promise<string> =>
    new Promise((resolve, reject) =>
      sftp.realpath(path, (err, resolved) => (err ? reject(err) : resolve(resolved))),
    );
  const stat = (path: string): Promise<Stats> =>
    new Promise((resolve, reject) =>
      sftp.stat(path, (err, attrs) => (err ? reject(err) : resolve(attrs))),
    );

  return {
    realpath,

    async list(path: string): Promise<SftpFileEntry[]> {
      const raw = await new Promise<Array<{ filename: string; attrs: Stats }>>((resolve, reject) =>
        sftp.readdir(path, (err, entries) => (err ? reject(err) : resolve(entries))),
      );
      const items = await Promise.all(
        raw.map(async (e): Promise<SftpFileEntry> => {
          let type = entryType(e.attrs);
          let size = e.attrs.size ?? 0;
          let symlink = false;
          if (type === 'symlink') {
            symlink = true;
            // Classify the link target so directories stay navigable; a broken
            // link keeps the plain symlink type.
            try {
              const resolved = await stat(sftpJoin(path, e.filename));
              type = entryType(resolved);
              size = resolved.size ?? size;
            } catch {
              /* dangling link */
            }
          }
          return {
            name: e.filename,
            type,
            symlink,
            size,
            mtimeMs: typeof e.attrs.mtime === 'number' ? e.attrs.mtime * 1000 : null,
            mode: e.attrs.mode ?? 0,
          };
        }),
      );
      return items
        .filter((e) => e.name !== '.' && e.name !== '..')
        .sort((a, b) =>
          a.type === 'dir' && b.type !== 'dir'
            ? -1
            : a.type !== 'dir' && b.type === 'dir'
              ? 1
              : a.name.localeCompare(b.name),
        );
    },

    mkdir: (path) =>
      new Promise((resolve, reject) => sftp.mkdir(path, (err) => (err ? reject(err) : resolve()))),
    rename: (from, to) =>
      new Promise((resolve, reject) =>
        sftp.rename(from, to, (err) => (err ? reject(err) : resolve())),
      ),
    delete: (path) =>
      new Promise((resolve, reject) => sftp.unlink(path, (err) => (err ? reject(err) : resolve()))),
    rmdir: (path) =>
      new Promise((resolve, reject) => sftp.rmdir(path, (err) => (err ? reject(err) : resolve()))),
    chmod: (path, mode) =>
      new Promise((resolve, reject) =>
        sftp.chmod(path, mode & 0o777, (err) => (err ? reject(err) : resolve())),
      ),

    async stat(path: string): Promise<{ type: SftpEntryType; size: number }> {
      const attrs = await stat(path);
      return { type: entryType(attrs), size: attrs.size ?? 0 };
    },

    async upload(localPath: string, remotePath: string, opts: SftpTransferOptions = {}) {
      const total = (await fsStat(localPath)).size;
      const source = createReadStream(localPath);
      const sink = sftp.createWriteStream(remotePath);
      let done = 0;
      source.on('data', (chunk: string | Buffer) => {
        done += chunk.length;
        opts.onProgress?.(done, total);
      });
      await pipeline(source, sink, { signal: opts.signal });
    },

    async download(remotePath: string, localPath: string, opts: SftpTransferOptions = {}) {
      const total = (await stat(remotePath)).size ?? 0;
      const source = sftp.createReadStream(remotePath);
      const sink = createWriteStream(localPath);
      let done = 0;
      source.on('data', (chunk: string | Buffer) => {
        done += chunk.length;
        opts.onProgress?.(done, total);
      });
      try {
        await pipeline(source, sink, { signal: opts.signal });
      } catch (err) {
        // Never leave a half-written local file behind on cancel/error.
        await fsUnlink(localPath).catch(() => {});
        throw err;
      }
    },

    close: () => sftp.end(),
    onClose: (cb) => void sftp.on('close', cb),
  };
}
