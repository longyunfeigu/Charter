import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@pi-ide/foundation';
import type { SftpFileEntry, SftpSession } from '@pi-ide/ssh-service';
import type { TerminalInfo, TerminalManager } from '@pi-ide/terminal-service';
import { TerminalImagePasteService } from './terminal-image-paste-service.js';

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('test')]);

function logger() {
  return createLogger('terminal-image-paste-test', { write: () => undefined });
}

function terminal(remote = false): TerminalInfo {
  return {
    id: 'term_test',
    title: 'Aider',
    shell: 'aider',
    pid: 1,
    cwd: '/work',
    projectName: 'work',
    projectPath: '/work',
    contextKind: 'focused',
    contextLabel: 'work',
    contextTaskId: null,
    launch: 'aider',
    persistence: remote ? 'remote' : 'process',
    ...(remote
      ? {
          remote: {
            hostId: 'host_1',
            hostLabel: 'box',
            username: 'edy',
            host: 'box.test',
            port: 22,
          },
        }
      : {}),
  };
}

class FakeTerminals {
  readonly writes: string[] = [];
  readonly item: TerminalInfo;
  private exit: ((event: { id: string; exitCode: number }) => void) | null = null;

  constructor(remote = false) {
    this.item = terminal(remote);
  }

  list(): TerminalInfo[] {
    return [this.item];
  }

  agentFor(): string {
    return 'aider';
  }

  onExitEvent(listener: (event: { id: string; exitCode: number }) => void): () => void {
    this.exit = listener;
    return () => {
      this.exit = null;
    };
  }

  async writeAccepted(_id: string, data: string): Promise<boolean> {
    this.writes.push(data);
    return true;
  }
}

class FakeSftp implements SftpSession {
  readonly dirs = new Set(['/home/edy']);
  readonly files = new Map<string, Buffer>();
  readonly modes = new Map<string, number>();
  closes = 0;

  async realpath(): Promise<string> {
    return '/home/edy';
  }
  async list(path: string): Promise<SftpFileEntry[]> {
    if (!this.dirs.has(path)) throw new Error('missing');
    return [];
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async rename(): Promise<void> {}
  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
  async rmdir(path: string): Promise<void> {
    this.dirs.delete(path);
  }
  async chmod(path: string, mode: number): Promise<void> {
    this.modes.set(path, mode);
  }
  async stat(path: string): Promise<{ type: 'file' | 'dir'; size: number }> {
    if (this.dirs.has(path)) return { type: 'dir', size: 0 };
    const bytes = this.files.get(path);
    if (bytes) return { type: 'file', size: bytes.length };
    throw new Error('missing');
  }
  async upload(localPath: string, remotePath: string): Promise<void> {
    this.files.set(remotePath, readFileSync(localPath));
  }
  async download(): Promise<void> {}
  close(): void {
    this.closes += 1;
  }
  onClose(): void {}
}

describe('TerminalImagePasteService', () => {
  it('stages a private local image and bracket-pastes only its path without Enter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-image-paste-test-'));
    const terminals = new FakeTerminals();
    const service = new TerminalImagePasteService(
      root,
      terminals as unknown as TerminalManager,
      logger(),
      {
        readClipboardImage: () => ({ bytes: PNG, width: 10, height: 10 }),
        openSftp: async () => new FakeSftp(),
        supportsImages: (id) => id === 'aider',
        now: () => 123,
        randomId: () => 'fixed-id',
      },
    );

    const result = await service.paste('term_test');
    expect(result).toEqual({ pasted: true, remote: false, sizeBytes: PNG.length });
    expect(terminals.writes).toHaveLength(1);
    expect(terminals.writes[0]).toMatch(/^\x1b\[200~.*clipboard-123-fixedid\.png\x1b\[201~$/);
    expect(terminals.writes[0]).not.toContain('\r');
    const path = terminals.writes[0]!.slice(6, -6);
    expect(existsSync(path)).toBe(true);
    await service.dispose();
    expect(existsSync(path)).toBe(false);
  });

  it('uploads to a fixed private SSH root, verifies bytes, then pastes the remote path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-image-paste-test-'));
    const terminals = new FakeTerminals(true);
    const sftp = new FakeSftp();
    const service = new TerminalImagePasteService(
      root,
      terminals as unknown as TerminalManager,
      logger(),
      {
        readClipboardImage: () => ({ bytes: PNG, width: 10, height: 10 }),
        openSftp: async () => sftp,
        supportsImages: () => true,
        now: () => 123,
        randomId: () => 'fixed-id',
      },
    );

    expect(await service.paste('term_test')).toEqual({
      pasted: true,
      remote: true,
      sizeBytes: PNG.length,
    });
    const payload = terminals.writes[0]!;
    expect(payload).toMatch(
      /^\x1b\[200~\/home\/edy\/\.charter\/tmp\/image-paste\/[a-f0-9]{24}\/clipboard-123-fixedid\.png\x1b\[201~$/,
    );
    expect(payload).not.toContain('\r');
    const remotePath = payload.slice(6, -6);
    expect(sftp.files.get(remotePath)).toEqual(PNG);
    expect(sftp.modes.get(remotePath)).toBe(0o600);
    expect(sftp.modes.get('/home/edy/.charter/tmp/image-paste')).toBe(0o700);

    await service.dispose();
    expect(sftp.files.has(remotePath)).toBe(false);
  });

  it('rejects clipboard images for an Agent that did not declare image support', async () => {
    const root = mkdtempSync(join(tmpdir(), 'charter-image-paste-test-'));
    const service = new TerminalImagePasteService(
      root,
      new FakeTerminals() as unknown as TerminalManager,
      logger(),
      {
        readClipboardImage: () => ({ bytes: PNG, width: 10, height: 10 }),
        openSftp: async () => new FakeSftp(),
        supportsImages: () => false,
      },
    );
    await expect(service.paste('term_test')).rejects.toThrow(/declares image input support/);
    await service.dispose();
  });
});
