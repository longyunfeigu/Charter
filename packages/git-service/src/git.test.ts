import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService } from './git.js';

let root: string;
let git: GitService;

function sh(args: string[]): string {
  return execFileSync('git', args, { cwd: root }).toString();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-ide-git-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  writeFileSync(join(root, 'tracked.txt'), 'original\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  git = new GitService(root);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('GitService (GIT-001/002/008)', () => {
  it('detects repository, branch and clean status', async () => {
    const detect = await git.detect();
    expect(detect.isRepo).toBe(true);
    expect(detect.branch).toBe('main');
    expect(detect.detached).toBe(false);

    const status = await git.status();
    expect(status.entries).toHaveLength(0);
    expect(status.branch).toBe('main');
  });

  it('classifies staged, unstaged, and untracked entries', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'modified\n');
    writeFileSync(join(root, 'fresh.txt'), 'new\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub/staged.txt'), 's\n');
    sh(['add', 'sub/staged.txt']);

    const status = await git.status();
    const byPath = Object.fromEntries(status.entries.map((e) => [e.path, e]));
    expect(byPath['tracked.txt']!.group).toBe('changes');
    expect(byPath['fresh.txt']!.group).toBe('untracked');
    expect(byPath['sub/staged.txt']!.group).toBe('staged');
  });

  it('stage / unstage / discard round-trip matches git CLI', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'modified\n');
    await git.stage(['tracked.txt']);
    expect(sh(['status', '--porcelain'])).toContain('M  tracked.txt');
    await git.unstage(['tracked.txt']);
    expect(sh(['status', '--porcelain'])).toContain(' M tracked.txt');
    await git.discard(['tracked.txt'], { includeUntracked: false });
    expect(sh(['status', '--porcelain']).trim()).toBe('');
  });

  it('produces working-tree diffs including untracked files (GIT-010 support)', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'original\nplus\n');
    const diff = await git.diffFile('tracked.txt', { staged: false });
    expect(diff).toContain('+plus');

    writeFileSync(join(root, 'untracked.txt'), 'brand new\n');
    const untrackedDiff = await git.diffFile('untracked.txt', { staged: false });
    expect(untrackedDiff).toContain('+brand new');
  });

  it('commits with a message and surfaces empty-message errors before invoking git', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'commit me\n');
    await git.stage(['tracked.txt']);
    const result = await git.commit('feat: change');
    expect(result.ok).toBe(true);
    expect(sh(['log', '--format=%s', '-1']).trim()).toBe('feat: change');

    await expect(git.commit('   ')).rejects.toThrow();
  });

  it('lists and switches branches; dirty conflicts surface as structured errors (GIT-005)', async () => {
    await git.createBranch('feature-x');
    expect((await git.branches()).map((b) => b.name)).toContain('feature-x');
    await git.checkout('main');
    expect((await git.detect()).branch).toBe('main');

    // Force a conflicting checkout: dirty file differing across branches.
    sh(['switch', '-q', 'feature-x']);
    writeFileSync(join(root, 'tracked.txt'), 'feature version\n');
    sh(['add', 'tracked.txt']);
    sh(['commit', '-qm', 'feature change']);
    sh(['switch', '-q', 'main']);
    writeFileSync(join(root, 'tracked.txt'), 'dirty local\n');
    await expect(git.checkout('feature-x')).rejects.toThrow(/checkout|overwritten|commit/i);
  });

  it('reads file content at a ref (HEAD) for diff views', async () => {
    const head = await git.show('tracked.txt', 'HEAD');
    expect(head).toBe('original\n');
  });
});

describe('GitService numstat (ADR-0013 diffstat decorations)', () => {
  it('counts worktree+index lines vs HEAD; untracked files never appear', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'changed\nplus one\nplus two\n'); // -1 +3 unstaged
    writeFileSync(join(root, 'fresh.txt'), 'new\n'); // untracked
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub/staged.txt'), 'a\nb\n');
    sh(['add', 'sub/staged.txt']); // staged-new counts vs HEAD too

    const stats = await git.numstat();
    const byPath = Object.fromEntries(stats.map((s) => [s.path, s]));
    expect(byPath['tracked.txt']).toMatchObject({ insertions: 3, deletions: 1, binary: false });
    expect(byPath['sub/staged.txt']).toMatchObject({ insertions: 2, deletions: 0 });
    expect(byPath['fresh.txt']).toBeUndefined();
  });

  it('reports renames under the new path', async () => {
    sh(['mv', 'tracked.txt', 'renamed.txt']);
    const stats = await git.numstat();
    const byPath = Object.fromEntries(stats.map((s) => [s.path, s]));
    expect(byPath['renamed.txt']).toMatchObject({ insertions: 0, deletions: 0 });
    expect(byPath['tracked.txt']).toBeUndefined();
  });

  it('flags binary files instead of counting lines', async () => {
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 255, 0, 7]));
    sh(['add', 'blob.bin']);
    const stats = await git.numstat();
    const bin = stats.find((s) => s.path === 'blob.bin');
    expect(bin).toMatchObject({ binary: true, insertions: 0, deletions: 0 });
  });

  it('returns empty on a repo without a HEAD commit', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'pi-ide-git-empty-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: bare });
      writeFileSync(join(bare, 'first.txt'), 'x\n');
      expect(await new GitService(bare).numstat()).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('GitService snapshotTree/readTreeBlob (ADR-0017)', () => {
  it('snapshots tracked, dirty and untracked files without touching the real index', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'dirty edit\n'); // dirty tracked
    writeFileSync(join(root, 'untracked.txt'), 'brand new\n'); // untracked
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub/nested.txt'), 'nested\n');

    const tree = await git.snapshotTree();
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/);

    // Snapshot sees the pre-session bytes of everything…
    expect((await git.readTreeBlob(tree, 'tracked.txt'))!.toString()).toBe('dirty edit\n');
    expect((await git.readTreeBlob(tree, 'untracked.txt'))!.toString()).toBe('brand new\n');
    expect((await git.readTreeBlob(tree, 'sub/nested.txt'))!.toString()).toBe('nested\n');
    // …and answers null for paths that did not exist at snapshot time.
    expect(await git.readTreeBlob(tree, 'created-later.txt')).toBeNull();

    // The user's real index stayed untouched: untracked stays untracked.
    const status = sh(['status', '--porcelain']);
    expect(status).toContain('?? untracked.txt');
    expect(status).not.toContain('A  untracked.txt');
  });

  it('respects .gitignore in the snapshot', async () => {
    writeFileSync(join(root, '.gitignore'), 'ignored.log\n');
    writeFileSync(join(root, 'ignored.log'), 'noise\n');
    const tree = await git.snapshotTree();
    expect(await git.readTreeBlob(tree, 'ignored.log')).toBeNull();
  });
});
