import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore } from '@pi-ide/change-service';
import {
  VerificationService,
  createMemoryVerificationRepo,
  type MemoryVerificationRepo,
} from './verification-service.js';

let root: string;
let blobDir: string;
let repo: MemoryVerificationRepo;
let service: VerificationService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-ide-ver-'));
  blobDir = mkdtempSync(join(tmpdir(), 'pi-ide-ver-blob-'));
  repo = createMemoryVerificationRepo();
  service = new VerificationService({
    root,
    repo,
    blobs: new BlobStore(blobDir),
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(blobDir, { recursive: true, force: true });
});

describe('detectSuggestions (VER-002)', () => {
  it('suggests npm scripts and typecheck from package.json', async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc -b', other: 'echo hi' },
      }),
    );
    const suggestions = await service.detectSuggestions();
    const labels = suggestions.map((s) => s.label);
    expect(labels).toContain('npm test');
    expect(labels).toContain('npm run lint');
    expect(labels).toContain('npm run build');
    expect(labels).not.toContain('npm run other');
    const test = suggestions.find((s) => s.label === 'npm test')!;
    expect(test.executable).toBe('npm');
    expect(test.args).toEqual(['test']);
  });

  it('returns an empty list without a package.json', async () => {
    expect(await service.detectSuggestions()).toEqual([]);
  });
});

describe('run (VER-003)', () => {
  it('records a passing run with exit code, timing and output excerpt', async () => {
    const run = await service.run({
      taskId: 't1',
      codeRevision: 'rev-1',
      command: {
        label: 'ok',
        executable: process.execPath,
        args: ['-e', 'console.log("all good"); process.exit(0)'],
        cwd: '',
        timeoutMs: 30000,
      },
    });
    expect(run.state).toBe('passed');
    expect(run.exitCode).toBe(0);
    expect(run.outputExcerpt).toContain('all good');
    expect(run.codeRevision).toBe('rev-1');
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]!.state).toBe('passed');
  });

  it('records a failing run and keeps full output in the blob store', async () => {
    const run = await service.run({
      taskId: 't1',
      codeRevision: 'rev-1',
      command: {
        label: 'boom',
        executable: process.execPath,
        args: ['-e', 'console.error("broken as expected"); process.exit(3)'],
        cwd: '',
        timeoutMs: 30000,
      },
    });
    expect(run.state).toBe('failed');
    expect(run.exitCode).toBe(3);
    expect(run.outputRef).toBeTruthy();
  });

  it('marks a timed-out run as timeout', async () => {
    const run = await service.run({
      taskId: 't1',
      codeRevision: null,
      command: {
        label: 'hang',
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: '',
        timeoutMs: 1200,
      },
    });
    expect(run.state).toBe('timeout');
    expect(run.timedOut).toBe(true);
  }, 15000);

  it('supersedes earlier runs with the same label (VER-005: history kept, never overwritten)', async () => {
    const first = await service.run({
      taskId: 't1',
      codeRevision: 'rev-1',
      command: {
        label: 'suite',
        executable: process.execPath,
        args: ['-e', 'process.exit(1)'],
        cwd: '',
        timeoutMs: 30000,
      },
    });
    const second = await service.run({
      taskId: 't1',
      codeRevision: 'rev-2',
      command: {
        label: 'suite',
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: '',
        timeoutMs: 30000,
      },
    });
    const rows = service.listForTask('t1');
    expect(rows).toHaveLength(2); // the failed record still exists
    const old = rows.find((r) => r.id === first.id)!;
    expect(old.state).toBe('failed');
    expect(old.supersededBy).toBe(second.id);
    expect(rows.find((r) => r.id === second.id)!.supersededBy).toBeNull();
  });
});

describe('stale semantics (VER-008)', () => {
  it('marks runs stale when the code revision moves on', async () => {
    await service.run({
      taskId: 't1',
      codeRevision: 'rev-1',
      command: {
        label: 'suite',
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: '',
        timeoutMs: 30000,
      },
    });
    service.markStale('t1', 'rev-2');
    expect(service.listForTask('t1')[0]!.stale).toBe(true);
    // Same revision → not stale.
    const again = await service.run({
      taskId: 't1',
      codeRevision: 'rev-2',
      command: {
        label: 'suite',
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: '',
        timeoutMs: 30000,
      },
    });
    service.markStale('t1', 'rev-2');
    expect(service.listForTask('t1').find((r) => r.id === again.id)!.stale).toBe(false);
  });

  it('invalidates every prior result when the workspace is rolled back', async () => {
    await service.run({
      taskId: 't1',
      codeRevision: 'rev-1',
      command: {
        label: 'suite',
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: '',
        timeoutMs: 30000,
      },
    });
    service.markAllStale('t1');
    expect(service.listForTask('t1')).toMatchObject([{ stale: true }]);
  });
});
