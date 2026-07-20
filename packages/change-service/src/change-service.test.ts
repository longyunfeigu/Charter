import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ProductFailure } from '@pi-ide/foundation';
import { DocumentStore } from '@pi-ide/document-service';
import { BlobStore } from './blob-store.js';
import { ChangeService, InMemoryChangeRepo } from './change-service.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let root: string;
let blobDir: string;
let service: ChangeService;
let repo: InMemoryChangeRepo;
let docs: DocumentStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-ide-chg-'));
  blobDir = mkdtempSync(join(tmpdir(), 'pi-ide-blob-'));
  writeFileSync(join(root, 'a.txt'), 'line1\nline2\nline3\n');
  writeFileSync(join(root, 'crlf.txt'), 'one\r\ntwo\r\n');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested/deep.txt'), 'deep\n');
  docs = new DocumentStore(root, {});
  repo = new InMemoryChangeRepo();
  service = new ChangeService({
    root,
    blobs: new BlobStore(blobDir),
    repo,
    documents: docs,
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(blobDir, { recursive: true, force: true });
});

describe('BlobStore', () => {
  it('stores and retrieves content-addressed blobs idempotently', async () => {
    const store = new BlobStore(blobDir);
    const a = await store.put(Buffer.from('hello'));
    const b = await store.put(Buffer.from('hello'));
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(sha('hello'));
    expect((await store.get(a.hash))!.toString()).toBe('hello');
    expect(await store.get('0'.repeat(64))).toBeNull();
  });
});

describe('baseline capture (CHG-001)', () => {
  it('captures bytes, mode and existence exactly once per task+path', async () => {
    chmodSync(join(root, 'a.txt'), 0o755);
    const first = await service.ensureBaseline('t1', 'a.txt');
    expect(first.existed).toBe(true);
    expect(first.blobHash).toBe(sha('line1\nline2\nline3\n'));
    expect((first.mode! & 0o777).toString(8)).toBe('755');

    writeFileSync(join(root, 'a.txt'), 'changed\n');
    const second = await service.ensureBaseline('t1', 'a.txt');
    expect(second.blobHash).toBe(first.blobHash); // still the original capture

    const missing = await service.ensureBaseline('t1', 'not-yet.txt');
    expect(missing.existed).toBe(false);
    expect(missing.blobHash).toBeNull();
  });
});

describe('patch engine (CHG-002/003)', () => {
  it('applies a unified patch when the base hash matches and records the change', async () => {
    const before = readFileSync(join(root, 'a.txt'), 'utf8');
    const result = await service.applyPatch('t1', 'call1', {
      path: 'a.txt',
      patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+LINE2\n line3\n',
      baseHash: sha(before),
      reason: 'test',
    });
    expect(result.afterHash).toBe(sha('line1\nLINE2\nline3\n'));
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('line1\nLINE2\nline3\n');
    const changes = repo.changesFor('t1');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('modified');
    expect(changes[0]!.beforeHash).toBe(sha(before));
  });

  it('notifies the host after a task write saves an already-open document', async () => {
    const notifications: Array<{ content: string; dirty: boolean }> = [];
    const notifyingService = new ChangeService({
      root,
      blobs: new BlobStore(blobDir),
      repo,
      documents: docs,
      onDidWriteOpenDocument: (document) => {
        notifications.push({ content: document.content, dirty: document.dirty });
      },
    });
    await docs.open('a.txt');
    const before = readFileSync(join(root, 'a.txt'), 'utf8');

    await notifyingService.applyPatch('t1', 'call1', {
      path: 'a.txt',
      patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+LINE2\n line3\n',
      baseHash: sha(before),
      reason: 'notify open editor',
    });

    expect(notifications).toEqual([{ content: 'line1\nLINE2\nline3\n', dirty: false }]);
  });

  it('rejects stale base hashes with VERSION_CONFLICT and leaves the file untouched', async () => {
    const original = readFileSync(join(root, 'a.txt'), 'utf8');
    await expect(
      service.applyPatch('t1', 'call1', {
        path: 'a.txt',
        patch: '--- a\n+++ b\n@@ -1,1 +1,1 @@\n-line1\n+X\n',
        baseHash: 'f'.repeat(64),
        reason: 'stale',
      }),
    ).rejects.toThrowError(ProductFailure);
    try {
      await service.applyPatch('t1', 'c', {
        path: 'a.txt',
        patch: '',
        baseHash: 'f'.repeat(64),
        reason: 'stale',
      });
    } catch (e) {
      expect((e as ProductFailure).error.code).toBe('CHG_VERSION_CONFLICT');
    }
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(original);
  });

  it('reads the OPEN BUFFER as the logical base (spec §6.4)', async () => {
    await docs.open('a.txt');
    docs.updateBuffer('a.txt', 'buffered\n');
    const result = await service.applyPatch('t1', 'call1', {
      path: 'a.txt',
      patch: '--- a\n+++ b\n@@ -1,1 +1,1 @@\n-buffered\n+patched-buffer\n',
      baseHash: sha('buffered\n'),
      reason: 'buffer-aware',
    });
    expect(result.afterHash).toBe(sha('patched-buffer\n'));
    // Applied through the document store: buffer updated AND saved to disk.
    expect(docs.get('a.txt')!.content).toBe('patched-buffer\n');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('patched-buffer\n');
  });

  it('creates and deletes files with baselines', async () => {
    await service.createFile('t1', 'c1', { path: 'new/file.txt', content: 'fresh\n' });
    expect(readFileSync(join(root, 'new/file.txt'), 'utf8')).toBe('fresh\n');
    await expect(
      service.createFile('t1', 'c2', { path: 'new/file.txt', content: 'again' }),
    ).rejects.toThrowError(ProductFailure);

    await service.deleteFile('t1', 'c3', { path: 'a.txt' });
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
    const kinds = repo.changesFor('t1').map((c) => c.kind);
    expect(kinds).toContain('created');
    expect(kinds).toContain('deleted');
  });
});

describe('change set projection (CHG-005)', () => {
  it('reports net changes, collapsing intermediate patches', async () => {
    const h0 = sha(readFileSync(join(root, 'a.txt')));
    await service.applyPatch('t1', 'c1', {
      path: 'a.txt',
      patch: '--- a\n+++ b\n@@ -1,3 +1,3 @@\n line1\n-line2\n+v1\n line3\n',
      baseHash: h0,
      reason: 'step1',
    });
    await service.applyPatch('t1', 'c2', {
      path: 'a.txt',
      patch: '--- a\n+++ b\n@@ -1,3 +1,3 @@\n line1\n-v1\n+v2\n line3\n',
      baseHash: sha('line1\nv1\nline3\n'),
      reason: 'step2',
    });
    await service.createFile('t1', 'c3', { path: 'brand-new.txt', content: 'nn\n' });

    const changeSet = await service.changeSet('t1');
    expect(changeSet.files).toHaveLength(2);
    const a = changeSet.files.find((f) => f.path === 'a.txt')!;
    expect(a.status).toBe('modified');
    expect(a.diff).toContain('+v2');
    expect(a.diff).not.toContain('+v1'); // net diff, not intermediate
    const b = changeSet.files.find((f) => f.path === 'brand-new.txt')!;
    expect(b.status).toBe('created');
    expect(changeSet.totalAdditions).toBeGreaterThan(0);
  });
});

describe('rollback engine (CHG-009..012)', () => {
  it('restores modify/create/delete/rename to byte-identical baseline state', async () => {
    chmodSync(join(root, 'a.txt'), 0o750);
    const beforeBytes = readFileSync(join(root, 'a.txt'));
    const beforeCrlf = readFileSync(join(root, 'crlf.txt'));

    await service.applyPatch('t1', 'c1', {
      path: 'a.txt',
      patch: '--- a\n+++ b\n@@ -1,3 +1,3 @@\n line1\n-line2\n+HACK\n line3\n',
      baseHash: sha(beforeBytes),
      reason: 'modify',
    });
    await service.createFile('t1', 'c2', { path: 'created.txt', content: 'temp\n' });
    await service.deleteFile('t1', 'c3', { path: 'crlf.txt' });
    await service.renameFile('t1', 'c4', { from: 'nested/deep.txt', to: 'nested/renamed.txt' });

    const preflight = await service.rollbackPreflight('t1');
    expect(preflight.conflicts).toHaveLength(0);

    const report = await service.rollback('t1');
    expect(report.ok).toBe(true);
    expect(report.verified.every((v) => v.ok)).toBe(true);

    expect(readFileSync(join(root, 'a.txt'))).toEqual(beforeBytes);
    expect((statSync(join(root, 'a.txt')).mode & 0o777).toString(8)).toBe('750');
    expect(existsSync(join(root, 'created.txt'))).toBe(false);
    expect(readFileSync(join(root, 'crlf.txt'))).toEqual(beforeCrlf);
    expect(existsSync(join(root, 'nested/deep.txt'))).toBe(true);
    expect(existsSync(join(root, 'nested/renamed.txt'))).toBe(false);
  });

  it('refuses to overwrite external edits made after the task changes (CHG-010)', async () => {
    const h0 = sha(readFileSync(join(root, 'a.txt')));
    await service.applyPatch('t1', 'c1', {
      path: 'a.txt',
      patch: '--- a\n+++ b\n@@ -1,3 +1,3 @@\n line1\n-line2\n+AGENT\n line3\n',
      baseHash: h0,
      reason: 'agent change',
    });
    // User edits the same file afterwards, outside the task.
    writeFileSync(join(root, 'a.txt'), 'precious user work\n');

    const preflight = await service.rollbackPreflight('t1');
    expect(preflight.conflicts.map((c) => c.path)).toContain('a.txt');

    await expect(service.rollback('t1')).rejects.toThrowError(ProductFailure);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('precious user work\n');

    // Forced rollback (explicit user decision) does restore baseline.
    const forced = await service.rollback('t1', { force: true });
    expect(forced.ok).toBe(true);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('line1\nline2\nline3\n');
  });
});

describe('disk write failure (M10/REL)', () => {
  it('a read-only target directory yields a structured failure and no partial file', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/locked.ts'), 'export const a = 1;\n');
    const before = readFileSync(join(root, 'src/locked.ts'), 'utf8');
    const hash = createHash('sha256').update(before).digest('hex');
    chmodSync(join(root, 'src'), 0o500); // no write permission
    try {
      await expect(
        service.applyPatch('task-ro', null, {
          path: 'src/locked.ts',
          patch:
            '--- src/locked.ts\n+++ src/locked.ts\n@@ -1,1 +1,1 @@\n-export const a = 1;\n+export const a = 2;\n',
          baseHash: hash,
          reason: 'test',
        }),
      ).rejects.toThrow(); // structured failure, not a crash or silent success
      // Nothing was overwritten and no temp litter remains.
      expect(readFileSync(join(root, 'src/locked.ts'), 'utf8')).toBe(before);
      const leftovers = readdirSync(join(root, 'src')).filter((f) => f.includes('.pi-ide-chg.'));
      expect(leftovers).toEqual([]);
    } finally {
      chmodSync(join(root, 'src'), 0o755);
    }
  });
});

describe('external session baselines (ADR-0017)', () => {
  it('captures a baseline from provided bytes, not from disk', async () => {
    // The external CLI already wrote the new content to disk…
    writeFileSync(join(root, 'a.txt'), 'externally rewritten\n');
    // …but the accounting hands us the entry-snapshot bytes.
    await service.ensureBaselineFromBytes('t1', 'a.txt', Buffer.from('line1\nline2\nline3\n'));
    await service.recordExternalChange('t1', 'a.txt', 'modified');

    const cs = await service.changeSet('t1');
    expect(cs.files).toHaveLength(1);
    expect(cs.files[0]!.status).toBe('modified');
    expect(cs.files[0]!.diff).toContain('-line1');
    expect(cs.files[0]!.diff).toContain('+externally rewritten');
  });

  it('chains every observed write to the previous version and stores both blobs', async () => {
    await service.ensureBaselineFromBytes('t1', 'a.txt', Buffer.from('v0\n'));
    writeFileSync(join(root, 'a.txt'), 'v1\n');
    const first = await service.recordExternalChange('t1', 'a.txt', 'modified');
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    const second = await service.recordExternalChange('t1', 'a.txt', 'modified');

    expect(first.beforeHash).toBe(sha('v0\n'));
    expect(first.afterHash).toBe(sha('v1\n'));
    expect(second.beforeHash).toBe(first.afterHash);
    expect(second.afterHash).toBe(sha('v2\n'));
    expect(second.patch).toContain('-v1');
    expect(second.patch).toContain('+v2');
    const blobs = new BlobStore(blobDir);
    expect((await blobs.get(first.afterHash!))?.toString()).toBe('v1\n');
    expect((await blobs.get(second.afterHash!))?.toString()).toBe('v2\n');
  });

  it('bytes=null records an honest created-during-session baseline', async () => {
    writeFileSync(join(root, 'fresh.txt'), 'made by the CLI\n');
    await service.ensureBaselineFromBytes('t1', 'fresh.txt', null);
    const cs = await service.changeSet('t1');
    expect(cs.files[0]!.status).toBe('created');
    expect(cs.files[0]!.diff).toContain('+made by the CLI');
  });

  it('is idempotent per task+path (later events keep the first baseline)', async () => {
    await service.ensureBaselineFromBytes('t1', 'a.txt', Buffer.from('v0\n'));
    await service.ensureBaselineFromBytes('t1', 'a.txt', Buffer.from('v1-should-be-ignored\n'));
    writeFileSync(join(root, 'a.txt'), 'v2\n');
    const cs = await service.changeSet('t1');
    expect(cs.files[0]!.diff).toContain('-v0');
  });

  it('rollback restores the snapshot bytes exactly', async () => {
    const original = readFileSync(join(root, 'a.txt'));
    writeFileSync(join(root, 'a.txt'), 'CLI overwrote this\n');
    await service.ensureBaselineFromBytes('t1', 'a.txt', original);
    const preflight = await service.rollbackPreflight('t1');
    expect(preflight.safe).toContain('a.txt');
    await service.rollback('t1');
    expect(readFileSync(join(root, 'a.txt'))).toEqual(original);
  });
});

describe('per-turn rollback (ADR-0032 rollbackToStates)', () => {
  it('restores paths to recorded prior hashes, byte-exact from blobs', async () => {
    const store = new BlobStore(blobDir);
    const boundary = await store.put(Buffer.from('turn-boundary\n'));
    writeFileSync(join(root, 'a.txt'), 'after-the-turn\n');
    const svc = new ChangeService({ root, blobs: store, repo, documents: docs });
    const result = await svc.rollbackToStates([
      {
        path: 'a.txt',
        toHash: boundary.hash,
        expectedCurrentHash: sha('after-the-turn\n'),
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.restored).toEqual(['a.txt']);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('turn-boundary\n');
  });

  it('deletes files the turn created (toHash null) and skips already-at-boundary paths', async () => {
    writeFileSync(join(root, 'made-by-turn.txt'), 'new\n');
    const result = await service.rollbackToStates([
      { path: 'made-by-turn.txt', toHash: null, expectedCurrentHash: sha('new\n') },
      // already at the boundary — untouched, still ok
      {
        path: 'nested/deep.txt',
        toHash: sha('deep\n'),
        expectedCurrentHash: sha('something-else\n'),
      },
    ]);
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, 'made-by-turn.txt'))).toBe(false);
    expect(readFileSync(join(root, 'nested/deep.txt'), 'utf8')).toBe('deep\n');
  });

  it('conflicts (never overwrites) when the file changed outside the turn', async () => {
    writeFileSync(join(root, 'a.txt'), 'edited outside the turn\n');
    const result = await service.rollbackToStates([
      {
        path: 'a.txt',
        toHash: sha('anything\n'),
        expectedCurrentHash: sha('what-the-turn-left\n'),
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.path).toBe('a.txt');
    // Nothing was written.
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('edited outside the turn\n');
  });

  it('force overrides conflicts explicitly', async () => {
    const store = new BlobStore(blobDir);
    const boundary = await store.put(Buffer.from('boundary\n'));
    writeFileSync(join(root, 'a.txt'), 'outside edit\n');
    const svc = new ChangeService({ root, blobs: store, repo, documents: docs });
    const result = await svc.rollbackToStates(
      [{ path: 'a.txt', toHash: boundary.hash, expectedCurrentHash: sha('turn-left-this\n') }],
      { force: true },
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('boundary\n');
  });

  it('fails closed when the boundary blob is missing', async () => {
    writeFileSync(join(root, 'a.txt'), 'current\n');
    const result = await service.rollbackToStates([
      { path: 'a.txt', toHash: '0'.repeat(64), expectedCurrentHash: sha('current\n') },
    ]);
    expect(result.ok).toBe(false);
    expect(result.verified[0]!.detail).toContain('blob missing');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('current\n');
  });
});
