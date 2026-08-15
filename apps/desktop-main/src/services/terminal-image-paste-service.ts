import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ProductFailure, productError, type Logger } from '@pi-ide/foundation';
import type { SftpSession } from '@pi-ide/ssh-service';
import { sftpJoin } from '@pi-ide/ssh-service';
import type { TerminalManager } from '@pi-ide/terminal-service';

export const MAX_TERMINAL_IMAGE_BYTES = 10 * 1024 * 1024;
const STAGED_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface ClipboardPng {
  bytes: Buffer;
  width: number;
  height: number;
}

export interface TerminalImagePasteServiceOptions {
  readClipboardImage(): ClipboardPng | null;
  openSftp(hostId: string): Promise<SftpSession>;
  supportsImages(agentId: string): boolean;
  now?: () => number;
  randomId?: () => string;
}

interface RemoteStaging {
  hostId: string;
  dir: string;
  files: Set<string>;
}

function failure(code: string, userMessage: string): ProductFailure {
  return new ProductFailure(productError(code, { userMessage }));
}

function privateId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function bracketedPaste(path: string): string {
  return `\x1b[200~${path}\x1b[201~`;
}

/** Herdr-style explicit clipboard-image bridge. The bytes are staged in a
 * host-owned private directory, only the resulting path is written to the TUI,
 * and Enter is intentionally never sent. SSH bytes cross via SFTP and are
 * size-verified before the remote path reaches the terminal. */
export class TerminalImagePasteService {
  private readonly localFiles = new Map<string, Set<string>>();
  private readonly remoteFiles = new Map<string, RemoteStaging>();
  private readonly unsubscribeExit: () => void;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(
    private readonly root: string,
    private readonly terminals: TerminalManager,
    private readonly logger: Logger,
    private readonly options: TerminalImagePasteServiceOptions,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.restrict(root, 0o700);
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    this.cleanupStaleLocal();
    this.unsubscribeExit = terminals.onExitEvent(({ id }) => void this.cleanupTerminal(id));
  }

  async paste(terminalId: string): Promise<{ pasted: true; remote: boolean; sizeBytes: number }> {
    const terminal = this.terminals.list().find((candidate) => candidate.id === terminalId);
    if (!terminal) throw failure('TERMINAL_NOT_FOUND', 'That terminal is no longer running.');
    const agentId = this.terminals.agentFor(terminalId) ?? terminal.launch;
    if (!agentId || agentId === 'shell' || !this.options.supportsImages(agentId)) {
      throw failure(
        'TERMINAL_IMAGE_AGENT_UNSUPPORTED',
        'This terminal is not running an Agent that declares image input support.',
      );
    }
    const image = this.options.readClipboardImage();
    if (!image || image.bytes.length === 0) {
      throw failure('TERMINAL_IMAGE_CLIPBOARD_EMPTY', 'Copy an image, then choose Paste image.');
    }
    if (image.width < 1 || image.height < 1 || image.width > 16_384 || image.height > 16_384) {
      throw failure(
        'TERMINAL_IMAGE_DIMENSIONS_INVALID',
        'The clipboard image dimensions are not supported.',
      );
    }
    if (image.bytes.length > MAX_TERMINAL_IMAGE_BYTES) {
      throw failure('TERMINAL_IMAGE_TOO_LARGE', 'Clipboard images must be 10 MB or smaller.');
    }
    // Electron's toPNG() is the decoder/normalizer; keep a second independent
    // magic check at the service boundary for tests and future callers.
    if (!image.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw failure('TERMINAL_IMAGE_INVALID', 'The clipboard does not contain a valid image.');
    }

    const localPath = this.stageLocal(terminalId, image.bytes);
    let pastePath = localPath;
    let remote = false;
    try {
      if (terminal.remote) {
        remote = true;
        pastePath = await this.stageRemote(
          terminalId,
          terminal.remote.hostId,
          localPath,
          image.bytes.length,
        );
        this.removeLocal(terminalId, localPath);
      }
      const accepted = await this.terminals.writeAccepted(
        terminalId,
        bracketedPaste(pastePath),
        'user',
      );
      if (!accepted) {
        await this.removeStaged(terminalId, pastePath, remote);
        throw failure(
          'TERMINAL_IMAGE_PASTE_REJECTED',
          'The terminal did not accept the image path.',
        );
      }
      this.logger.info('terminal clipboard image staged', {
        terminalId,
        remote,
        bytes: image.bytes.length,
      });
      return { pasted: true, remote, sizeBytes: image.bytes.length };
    } catch (error) {
      this.removeLocal(terminalId, localPath);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.unsubscribeExit();
    await Promise.allSettled(
      [...new Set([...this.localFiles.keys(), ...this.remoteFiles.keys()])].map((terminalId) =>
        this.cleanupTerminal(terminalId),
      ),
    );
  }

  private stageLocal(terminalId: string, bytes: Buffer): string {
    const dir = join(this.root, privateId(terminalId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.restrict(dir, 0o700);
    const path = join(dir, `clipboard-${this.now()}-${this.randomId().replaceAll('-', '')}.png`);
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    this.restrict(path, 0o600);
    const files = this.localFiles.get(terminalId) ?? new Set<string>();
    files.add(path);
    this.localFiles.set(terminalId, files);
    return path;
  }

  private async stageRemote(
    terminalId: string,
    hostId: string,
    localPath: string,
    expectedBytes: number,
  ): Promise<string> {
    const sftp = await this.options.openSftp(hostId);
    try {
      const home = await sftp.realpath('.');
      const charterDir = sftpJoin(home, '.charter');
      const tmpDir = sftpJoin(charterDir, 'tmp');
      const root = sftpJoin(tmpDir, 'image-paste');
      const dir = sftpJoin(root, privateId(terminalId));
      await this.ensureRemoteDir(sftp, charterDir);
      await this.ensureRemoteDir(sftp, tmpDir);
      await this.ensureRemoteDir(sftp, root);
      await this.cleanupStaleRemote(sftp, root);
      await this.ensureRemoteDir(sftp, dir);
      const path = sftpJoin(dir, basename(localPath));
      await sftp.upload(localPath, path);
      await sftp.chmod(path, 0o600);
      const info = await sftp.stat(path);
      if (info.type !== 'file' || info.size !== expectedBytes) {
        await sftp.delete(path).catch(() => undefined);
        throw failure(
          'TERMINAL_IMAGE_REMOTE_VERIFY_FAILED',
          'The uploaded image could not be verified on the SSH host.',
        );
      }
      const staging = this.remoteFiles.get(terminalId) ?? { hostId, dir, files: new Set<string>() };
      staging.files.add(path);
      this.remoteFiles.set(terminalId, staging);
      return path;
    } finally {
      sftp.close();
    }
  }

  private async ensureRemoteDir(sftp: SftpSession, path: string): Promise<void> {
    try {
      const info = await sftp.stat(path);
      if (info.type !== 'dir') throw new Error('not a directory');
    } catch {
      await sftp.mkdir(path);
    }
    await sftp.chmod(path, 0o700);
  }

  private async cleanupStaleRemote(sftp: SftpSession, root: string): Promise<void> {
    let entries: Awaited<ReturnType<SftpSession['list']>>;
    try {
      entries = await sftp.list(root);
    } catch {
      return;
    }
    const cutoff = this.now() - STAGED_MAX_AGE_MS;
    for (const entry of entries) {
      if (
        entry.type !== 'dir' ||
        entry.symlink ||
        entry.mtimeMs === null ||
        entry.mtimeMs >= cutoff
      )
        continue;
      const dir = sftpJoin(root, entry.name);
      try {
        const children = await sftp.list(dir);
        for (const child of children) {
          if (child.type === 'file' || child.symlink) await sftp.delete(sftpJoin(dir, child.name));
        }
        await sftp.rmdir(dir);
      } catch {
        // TTL cleanup is best effort; current paste must remain available.
      }
    }
  }

  private cleanupStaleLocal(): void {
    const cutoff = this.now() - STAGED_MAX_AGE_MS;
    try {
      for (const entry of readdirSync(this.root, { withFileTypes: true })) {
        const path = resolve(this.root, entry.name);
        if (!entry.isDirectory() || statSync(path).mtimeMs >= cutoff) continue;
        rmSync(path, { recursive: true, force: true });
      }
    } catch (error) {
      this.logger.warn('terminal image stale cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async cleanupTerminal(terminalId: string): Promise<void> {
    for (const path of this.localFiles.get(terminalId) ?? []) this.removeLocal(terminalId, path);
    this.localFiles.delete(terminalId);
    const remote = this.remoteFiles.get(terminalId);
    this.remoteFiles.delete(terminalId);
    if (!remote) return;
    try {
      const sftp = await this.options.openSftp(remote.hostId);
      try {
        for (const path of remote.files) await sftp.delete(path).catch(() => undefined);
        await sftp.rmdir(remote.dir).catch(() => undefined);
      } finally {
        sftp.close();
      }
    } catch (error) {
      this.logger.warn('remote terminal image cleanup deferred to TTL', {
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private removeLocal(terminalId: string, path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
    const files = this.localFiles.get(terminalId);
    files?.delete(path);
    if (files?.size === 0) {
      this.localFiles.delete(terminalId);
      try {
        rmSync(join(this.root, privateId(terminalId)), { recursive: true, force: true });
      } catch {
        // TTL fallback
      }
    }
  }

  private async removeStaged(terminalId: string, path: string, remote: boolean): Promise<void> {
    if (!remote) {
      this.removeLocal(terminalId, path);
      return;
    }
    const staging = this.remoteFiles.get(terminalId);
    if (!staging) return;
    try {
      const sftp = await this.options.openSftp(staging.hostId);
      try {
        await sftp.delete(path).catch(() => undefined);
      } finally {
        sftp.close();
      }
    } finally {
      staging.files.delete(path);
      if (staging.files.size === 0) {
        this.remoteFiles.delete(terminalId);
        try {
          const sftp = await this.options.openSftp(staging.hostId);
          try {
            await sftp.rmdir(staging.dir).catch(() => undefined);
          } finally {
            sftp.close();
          }
        } catch {
          // TTL fallback
        }
      }
    }
  }

  private restrict(path: string, mode: number): void {
    if (process.platform !== 'win32') chmodSync(path, mode);
  }
}
