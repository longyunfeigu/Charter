import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { errorMessage, type Logger } from '@pi-ide/foundation';
import type { GitService, GitTreeChange } from '@pi-ide/git-service';

/**
 * Entry snapshots for external CLI Sessions (ADR-0017, ADR-0060).
 *
 * The workspace watcher only learns about an external write after it landed,
 * so the pre-Session bytes must be captured before the Agent starts. Git
 * projects snapshot into their own object store with a temporary index. A
 * non-Git folder gets a private "shadow" repository under app data: the
 * project folder is the work tree, nothing is written into the project, and
 * the user's own Git configuration never applies.
 */

export type SnapshotRead =
  | { kind: 'bytes'; bytes: Buffer }
  /** The path did not exist when the snapshot was taken. */
  | { kind: 'absent' }
  /** The snapshot deliberately did not capture this path; use first-seen. */
  | { kind: 'uncovered' };

export interface EntrySnapshotSource {
  readonly kind: 'git' | 'shadow';
  /** Captures the current tree; the returned ref is persisted on the task. */
  capture(): Promise<string>;
  read(ref: string, path: string): Promise<SnapshotRead>;
  changedPaths(fromRef: string, toRef: string): Promise<GitTreeChange[]>;
}

export const SHADOW_REF_PREFIX = 'shadow:';

export function isShadowSnapshotRef(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && ref.startsWith(SHADOW_REF_PREFIX);
}

/** Short display form for snapshot chips ("shadow 1a2b3c4" / "1a2b3c4"). */
export function snapshotRefLabel(ref: string): string {
  return isShadowSnapshotRef(ref)
    ? `shadow ${ref.slice(SHADOW_REF_PREFIX.length, SHADOW_REF_PREFIX.length + 7)}`
    : ref.slice(0, 7);
}

export function gitSnapshotSource(git: GitService): EntrySnapshotSource {
  return {
    kind: 'git',
    capture: () => git.snapshotTree(),
    read: async (ref, path) => {
      const bytes = await git.readTreeBlob(ref, path);
      return bytes ? { kind: 'bytes', bytes } : { kind: 'absent' };
    },
    changedPaths: (fromRef, toRef) => git.changedPathsBetweenTrees(fromRef, toRef),
  };
}

export interface ShadowSnapshotLimits {
  maxFiles: number;
  maxTotalBytes: number;
  /** Larger files stay uncovered (first-seen) instead of failing the snapshot. */
  maxFileBytes: number;
  /** Snapshot refs older than this are released for garbage collection. */
  retentionMs: number;
  maintenanceIntervalMs: number;
}

export const DEFAULT_SHADOW_LIMITS: ShadowSnapshotLimits = {
  maxFiles: 20_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  maintenanceIntervalMs: 24 * 60 * 60 * 1000,
};

/** Regenerable dependency/build/cache directories — never worth a snapshot. */
export const SHADOW_EXCLUDED_SEGMENTS = [
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.gradle',
  'target',
  'dist',
  'build',
  'coverage',
  'DerivedData',
  'Pods',
];

/** Stored inside every shadow tree so a snapshot describes its own coverage. */
const MANIFEST_PATH = '.charter-shadow-manifest';
const MAX_EXCLUDED_PREFIXES = 5_000;

interface ShadowManifest {
  v: 1;
  segments: string[];
  /** Exact paths (files or directories) left out: nested repos, links, huge files. */
  prefixes: string[];
}

export class ShadowSnapshotBudgetError extends Error {}

function isUncovered(manifest: ShadowManifest, path: string): boolean {
  if (path === MANIFEST_PATH) return true;
  const parts = path.split('/');
  const segments = new Set(manifest.segments);
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (segments.has(parts[index]!)) return true;
  }
  return manifest.prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function runGit(
  args: string[],
  options: {
    /** Pathspecs resolve against the process cwd, never the work tree. */
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    input?: string;
  },
): Promise<{ stdout: Buffer }> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      // The user's global/system config must not rewrite snapshot bytes.
      ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'gc.auto=0', ...args],
      {
        cwd: options.cwd,
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs ?? 30_000,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_ATTR_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8').trim() : '';
          reject(new Error(detail.slice(0, 400) || errorMessage(error)));
          return;
        }
        resolvePromise({ stdout: stdout as unknown as Buffer });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** One shadow repository per non-Git project folder, under app data. */
export class ShadowSnapshotStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly baseDir: string,
    private readonly logger: Logger,
    private readonly limits: ShadowSnapshotLimits = DEFAULT_SHADOW_LIMITS,
  ) {}

  /** Null for folders too broad to snapshot honestly (home, filesystem root). */
  source(root: string): EntrySnapshotSource | null {
    const absolute = resolve(root);
    if (absolute === resolve(homedir()) || dirname(absolute) === absolute) return null;
    const id = createHash('sha256').update(absolute).digest('hex').slice(0, 24);
    return new ShadowSnapshotSource(this, absolute, join(this.baseDir, `${id}.git`));
  }

  /** Serializes all work on one shadow repository (its index is persistent). */
  exclusive<T>(gitDir: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(gitDir) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const settled = next.catch(() => undefined);
    this.queues.set(gitDir, settled);
    void settled.then(() => {
      if (this.queues.get(gitDir) === settled) this.queues.delete(gitDir);
    });
    return next;
  }

  get budget(): ShadowSnapshotLimits {
    return this.limits;
  }

  get log(): Logger {
    return this.logger;
  }
}

class ShadowSnapshotSource implements EntrySnapshotSource {
  readonly kind = 'shadow' as const;
  private readonly manifests = new Map<string, ShadowManifest | null>();

  constructor(
    private readonly store: ShadowSnapshotStore,
    private readonly root: string,
    private readonly gitDir: string,
  ) {}

  private git(args: string[], options: Omit<Parameters<typeof runGit>[1], 'cwd'> = {}) {
    // cwd must be the root: otherwise `.` would mean the app's own working
    // directory and a snapshot started inside a subfolder would miss the rest.
    return runGit(['--git-dir', this.gitDir, '--work-tree', this.root, ...args], {
      ...options,
      cwd: this.root,
      env: { GIT_INDEX_FILE: join(this.gitDir, 'charter-index'), ...options.env },
    });
  }

  private async ensureRepository(): Promise<void> {
    try {
      await fs.access(join(this.gitDir, 'HEAD'));
    } catch {
      await fs.mkdir(dirname(this.gitDir), { recursive: true });
      await runGit(['init', '--bare', '--quiet', this.gitDir], { cwd: dirname(this.gitDir) });
      await fs.writeFile(join(this.gitDir, 'charter-root'), `${this.root}\n`);
      // The first maintenance pass is due one interval after creation, not
      // right after the first capture.
      await fs.writeFile(join(this.gitDir, 'charter-maintained'), new Date().toISOString());
    }
    // In-tree .gitattributes must not normalize line endings or run filters
    // (e.g. LFS) — the snapshot is the exact bytes rollback will restore.
    await fs.mkdir(join(this.gitDir, 'info'), { recursive: true });
    await fs.writeFile(
      join(this.gitDir, 'info', 'attributes'),
      '* -text -filter -ident -working-tree-encoding\n',
    );
  }

  /** Bounded walk: counts what the snapshot will hold and lists exclusions. */
  private async survey(): Promise<{ files: number; bytes: number; prefixes: string[] }> {
    const limits = this.store.budget;
    const segments = new Set(SHADOW_EXCLUDED_SEGMENTS);
    const prefixes: string[] = [];
    let files = 0;
    let bytes = 0;
    const queue: string[] = [''];
    while (queue.length > 0) {
      const relDir = queue.shift()!;
      const entries = await fs.readdir(join(this.root, relDir), { withFileTypes: true });
      // Case-insensitive: on macOS Git treats `.Git` like `.git`.
      if (relDir && entries.some((entry) => entry.name.toLowerCase() === '.git')) {
        prefixes.push(relDir); // nested repository: its own history owns it
        continue;
      }
      for (const entry of entries) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name.toLowerCase() === '.git') prefixes.push(rel);
          else if (!segments.has(entry.name)) queue.push(rel);
          continue;
        }
        if (entry.isFile()) {
          const size = (await fs.stat(join(this.root, rel))).size;
          if (size > limits.maxFileBytes) {
            prefixes.push(rel);
            continue;
          }
          files += 1;
          bytes += size;
          if (files > limits.maxFiles || bytes > limits.maxTotalBytes) {
            throw new ShadowSnapshotBudgetError(
              `The folder is larger than the shadow snapshot budget (${limits.maxFiles} files / ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB).`,
            );
          }
        } else {
          prefixes.push(rel); // symlinks and special files restore as bytes incorrectly
        }
        if (prefixes.length > MAX_EXCLUDED_PREFIXES) {
          throw new ShadowSnapshotBudgetError('The folder has too many unsnapshottable entries.');
        }
      }
    }
    return { files, bytes, prefixes };
  }

  capture(): Promise<string> {
    return this.store.exclusive(this.gitDir, async () => {
      await this.ensureRepository();
      const survey = await this.survey();
      const manifest: ShadowManifest = {
        v: 1,
        segments: [...SHADOW_EXCLUDED_SEGMENTS],
        prefixes: survey.prefixes,
      };
      const pathspecFile = join(
        tmpdir(),
        `charter-shadow-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps`,
      );
      const pathspecs = [
        '.',
        ...manifest.segments.map((segment) => `:(exclude,glob)**/${segment}/**`),
        ...manifest.prefixes.map((prefix) => `:(exclude,literal)${prefix}`),
        `:(exclude,literal)${MANIFEST_PATH}`,
      ];
      await fs.writeFile(pathspecFile, `${pathspecs.join('\0')}\0`);
      try {
        const add = (): Promise<unknown> =>
          this.git(
            ['add', '-A', '-f', `--pathspec-from-file=${pathspecFile}`, '--pathspec-file-nul'],
            { timeoutMs: 120_000 },
          );
        try {
          await add();
        } catch (error) {
          // A crash can leave a stale lock or torn index; the index is only a
          // stat cache, so rebuild it once from scratch.
          this.store.log.warn('shadow snapshot index rebuilt', { error: errorMessage(error) });
          await fs.rm(join(this.gitDir, 'charter-index'), { force: true });
          await fs.rm(join(this.gitDir, 'charter-index.lock'), { force: true });
          await add();
        }
        const manifestBlob = (
          await this.git(['hash-object', '-w', '--stdin'], { input: JSON.stringify(manifest) })
        ).stdout
          .toString('utf8')
          .trim();
        await this.git([
          'update-index',
          '--add',
          '--cacheinfo',
          `100644,${manifestBlob},${MANIFEST_PATH}`,
        ]);
        const tree = (await this.git(['write-tree'])).stdout.toString('utf8').trim();
        await this.git(['update-ref', `refs/charter/${Date.now()}-${tree.slice(0, 12)}`, tree]);
        this.manifests.set(tree, manifest);
        void this.maintain();
        return `${SHADOW_REF_PREFIX}${tree}`;
      } finally {
        await fs.rm(pathspecFile, { force: true });
      }
    });
  }

  private treeOf(ref: string): string {
    if (!isShadowSnapshotRef(ref)) throw new Error('Not a shadow snapshot ref.');
    const tree = ref.slice(SHADOW_REF_PREFIX.length);
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('Malformed shadow snapshot ref.');
    return tree;
  }

  /** Null when the tree is gone (pruned) or carries no manifest. */
  private async manifest(tree: string): Promise<ShadowManifest | null> {
    if (this.manifests.has(tree)) return this.manifests.get(tree)!;
    let manifest: ShadowManifest | null = null;
    try {
      const raw = (await this.git(['cat-file', 'blob', `${tree}:${MANIFEST_PATH}`])).stdout;
      const parsed = JSON.parse(raw.toString('utf8')) as Partial<ShadowManifest>;
      if (parsed.v === 1 && Array.isArray(parsed.segments) && Array.isArray(parsed.prefixes)) {
        manifest = { v: 1, segments: parsed.segments, prefixes: parsed.prefixes };
      }
    } catch {
      manifest = null;
    }
    this.manifests.set(tree, manifest);
    return manifest;
  }

  read(ref: string, path: string): Promise<SnapshotRead> {
    return this.store.exclusive(this.gitDir, async () => {
      const tree = this.treeOf(ref);
      const manifest = await this.manifest(tree);
      // Without its manifest the tree cannot tell "absent" from "excluded";
      // claiming absent would make rollback delete a pre-existing file.
      if (!manifest || isUncovered(manifest, path)) return { kind: 'uncovered' };
      try {
        const bytes = (await this.git(['cat-file', 'blob', `${tree}:${path}`])).stdout;
        return { kind: 'bytes', bytes };
      } catch {
        // Only a tree that provably lacks the path means "did not exist"; a
        // pruned tree, a deleted store or a spawn failure must stay uncovered.
        try {
          const listed = (
            await this.git(['ls-tree', '--full-tree', '-z', tree, '--', path])
          ).stdout;
          return listed.length === 0 ? { kind: 'absent' } : { kind: 'uncovered' };
        } catch {
          return { kind: 'uncovered' };
        }
      }
    });
  }

  changedPaths(fromRef: string, toRef: string): Promise<GitTreeChange[]> {
    return this.store.exclusive(this.gitDir, async () => {
      const from = this.treeOf(fromRef);
      const to = this.treeOf(toRef);
      const [before, after] = await Promise.all([this.manifest(from), this.manifest(to)]);
      if (!before || !after) return [];
      const out = (
        await this.git(['diff', '--name-status', '--no-renames', '-z', from, to, '--'])
      ).stdout.toString('utf8');
      const records = out.split('\0');
      const changes: GitTreeChange[] = [];
      for (let index = 0; index + 1 < records.length; index += 2) {
        const status = records[index]?.trim() ?? '';
        const path = records[index + 1] ?? '';
        if (!path || isUncovered(before, path) || isUncovered(after, path)) continue;
        const kind: GitTreeChange['kind'] = status.startsWith('A')
          ? 'created'
          : status.startsWith('D')
            ? 'deleted'
            : 'modified';
        changes.push({ path, kind });
      }
      return changes;
    });
  }

  /** Releases expired snapshot refs and repacks, at most once per interval. */
  private maintain(): Promise<void> {
    return this.store.exclusive(this.gitDir, async () => {
      const limits = this.store.budget;
      const stamp = join(this.gitDir, 'charter-maintained');
      try {
        const last = (await fs.stat(stamp)).mtimeMs;
        if (Date.now() - last < limits.maintenanceIntervalMs) return;
      } catch {
        // never maintained
      }
      try {
        const refs = (
          await this.git(['for-each-ref', '--format=%(refname)', 'refs/charter/'])
        ).stdout
          .toString('utf8')
          .split('\n')
          .filter(Boolean);
        const cutoff = Date.now() - limits.retentionMs;
        for (const ref of refs) {
          const created = Number(ref.slice('refs/charter/'.length).split('-')[0]);
          if (Number.isFinite(created) && created < cutoff) {
            await this.git(['update-ref', '-d', ref]);
          }
        }
        await this.git(['gc', '--prune=now', '--quiet'], { timeoutMs: 300_000 });
        // The index is a stat cache; after pruning it could name blobs that no
        // longer exist and make the next write-tree fail. Rehash next time.
        await fs.rm(join(this.gitDir, 'charter-index'), { force: true });
        await fs.writeFile(stamp, new Date().toISOString());
      } catch (error) {
        this.store.log.warn('shadow snapshot maintenance failed', {
          root: this.root,
          error: errorMessage(error),
        });
      }
    });
  }
}
