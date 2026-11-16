import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SHADOW_LIMITS,
  isShadowSnapshotRef,
  ShadowSnapshotBudgetError,
  ShadowSnapshotStore,
  snapshotRefLabel,
} from './shadow-snapshot.js';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => logger,
} as never;

const roots: string[] = [];
function fixture(): { work: string; data: string } {
  const root = mkdtempSync(join(tmpdir(), 'charter-shadow-'));
  roots.push(root);
  const work = join(root, 'project');
  mkdirSync(work);
  return { work, data: join(root, 'shadow') };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ShadowSnapshotStore', () => {
  it('captures exact pre-Session bytes without writing into the project', async () => {
    const { work, data } = fixture();
    writeFileSync(join(work, 'notes.md'), '# Notes\r\nkeep CRLF\r\n');
    writeFileSync(join(work, '.gitattributes'), '* text=auto eol=lf\n*.md filter=lfs\n');
    writeFileSync(join(work, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const source = new ShadowSnapshotStore(data, logger).source(work)!;

    const ref = await source.capture();
    expect(isShadowSnapshotRef(ref)).toBe(true);
    expect(snapshotRefLabel(ref)).toMatch(/^shadow [0-9a-f]{7}$/);

    // The Agent edits after the snapshot; the snapshot still holds the originals.
    writeFileSync(join(work, 'notes.md'), '# Rewritten\n');
    writeFileSync(join(work, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]));
    writeFileSync(join(work, 'new.txt'), 'created later\n');

    const notes = await source.read(ref, 'notes.md');
    expect(notes.kind === 'bytes' && notes.bytes.toString('utf8')).toBe('# Notes\r\nkeep CRLF\r\n');
    const logo = await source.read(ref, 'logo.png');
    expect(logo.kind === 'bytes' && [...logo.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    expect(await source.read(ref, 'new.txt')).toEqual({ kind: 'absent' });

    expect(readdirSync(work).sort()).toEqual(['.gitattributes', 'logo.png', 'new.txt', 'notes.md']);
  });

  it('marks excluded paths uncovered so they can never be mistaken for created files', async () => {
    const { work, data } = fixture();
    mkdirSync(join(work, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(work, 'node_modules', 'pkg', 'index.js'), 'dep\n');
    mkdirSync(join(work, 'web', 'dist'), { recursive: true });
    writeFileSync(join(work, 'web', 'dist', 'app.js'), 'bundle\n');
    writeFileSync(join(work, 'dist'), 'plain\n'); // a FILE named dist
    mkdirSync(join(work, 'vendor', 'lib', '.git'), { recursive: true });
    writeFileSync(join(work, 'vendor', 'lib', 'code.ts'), 'nested repo\n');
    writeFileSync(join(work, 'target.txt'), 'link target\n');
    symlinkSync('target.txt', join(work, 'link.txt'));
    const source = new ShadowSnapshotStore(data, logger, {
      ...DEFAULT_SHADOW_LIMITS,
      maxFileBytes: 16,
    }).source(work)!;
    writeFileSync(join(work, 'huge.bin'), Buffer.alloc(64));

    const ref = await source.capture();
    for (const path of [
      'node_modules/pkg/index.js',
      'web/dist/app.js',
      'vendor/lib/code.ts',
      'link.txt',
      'huge.bin',
      '.charter-shadow-manifest',
    ]) {
      expect(await source.read(ref, path), path).toEqual({ kind: 'uncovered' });
    }
    const dist = await source.read(ref, 'dist');
    expect(dist.kind).toBe('bytes');
  });

  it('lists changes between snapshots, ignoring uncovered paths', async () => {
    const { work, data } = fixture();
    writeFileSync(join(work, 'a.txt'), 'one\n');
    writeFileSync(join(work, 'gone.txt'), 'bye\n');
    mkdirSync(join(work, 'build'));
    writeFileSync(join(work, 'build', 'out.js'), 'x\n');
    const source = new ShadowSnapshotStore(data, logger).source(work)!;
    const before = await source.capture();

    writeFileSync(join(work, 'a.txt'), 'two\n');
    rmSync(join(work, 'gone.txt'));
    writeFileSync(join(work, 'fresh.txt'), 'new\n');
    writeFileSync(join(work, 'build', 'out.js'), 'y\n');
    const after = await source.capture();

    const changes = await source.changedPaths(before, after);
    expect(changes.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.txt', kind: 'modified' },
      { path: 'fresh.txt', kind: 'created' },
      { path: 'gone.txt', kind: 'deleted' },
    ]);
  });

  it('refuses folders over budget instead of taking a partial snapshot', async () => {
    const { work, data } = fixture();
    for (let index = 0; index < 4; index += 1) writeFileSync(join(work, `f${index}.txt`), 'x');
    const source = new ShadowSnapshotStore(data, logger, {
      ...DEFAULT_SHADOW_LIMITS,
      maxFiles: 3,
    }).source(work)!;
    await expect(source.capture()).rejects.toBeInstanceOf(ShadowSnapshotBudgetError);
  });

  it('never snapshots the home directory or a filesystem root', () => {
    const store = new ShadowSnapshotStore(join(tmpdir(), 'unused'), logger);
    expect(store.source(homedir())).toBeNull();
    expect(store.source('/')).toBeNull();
  });

  it('treats a pruned or foreign tree as uncovered', async () => {
    const { work, data } = fixture();
    writeFileSync(join(work, 'a.txt'), 'one\n');
    const source = new ShadowSnapshotStore(data, logger).source(work)!;
    await source.capture();
    expect(await source.read(`shadow:${'0'.repeat(40)}`, 'a.txt')).toEqual({ kind: 'uncovered' });
  });

  it('reuses its stat cache across captures and survives a torn index', async () => {
    const { work, data } = fixture();
    writeFileSync(join(work, 'a.txt'), 'one\n');
    const store = new ShadowSnapshotStore(data, logger);
    const source = store.source(work)!;
    const first = await source.capture();
    const gitDir = join(data, readdirSync(data)[0]!);
    writeFileSync(join(gitDir, 'charter-index'), 'garbage');
    writeFileSync(join(work, 'a.txt'), 'two\n');
    const second = await source.capture();
    expect(second).not.toBe(first);
    const read = await source.read(second, 'a.txt');
    expect(read.kind === 'bytes' && read.bytes.toString()).toBe('two\n');
  });
});
