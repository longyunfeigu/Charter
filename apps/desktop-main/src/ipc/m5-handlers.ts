import { join } from 'node:path';
import { GitService } from '@pi-ide/git-service';
import {
  BlobStore,
  ChangeService,
  type ChangeRepo,
  type FileBaseline,
  type FileChangeRecord,
} from '@pi-ide/change-service';
import type { SqlDatabase } from '@pi-ide/persistence';
import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { registerHandlers } from './router.js';
import type { WorkspaceHost } from '../services/workspace-host.js';
import type { StateService } from '../services/state-service.js';
import type { AppPaths } from '../app-paths.js';
import { workspaceDataDir } from '../app-paths.js';
import { broadcast } from '../broadcast.js';

/** ChangeRepo over the product SQLite database (spec §11.2 tables). */
export class SqliteChangeRepo implements ChangeRepo {
  constructor(private readonly db: SqlDatabase) {}

  getBaseline(taskId: string, relativePath: string): FileBaseline | null {
    const row = this.db
      .prepare(
        'SELECT existed, blob_hash, mode, size, captured_at FROM file_baselines WHERE task_id = ? AND relative_path = ?',
      )
      .get(taskId, relativePath) as
      | {
          existed: number;
          blob_hash: string | null;
          mode: number | null;
          size: number;
          captured_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      taskId,
      relativePath,
      existed: row.existed === 1,
      blobHash: row.blob_hash,
      mode: row.mode,
      size: row.size,
      capturedAt: row.captured_at,
    };
  }

  saveBaseline(baseline: FileBaseline): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO file_baselines (task_id, relative_path, existed, blob_hash, mode, size, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        baseline.taskId,
        baseline.relativePath,
        baseline.existed ? 1 : 0,
        baseline.blobHash,
        baseline.mode,
        baseline.size,
        baseline.capturedAt,
      );
  }

  baselinesFor(taskId: string): FileBaseline[] {
    const rows = this.db
      .prepare(
        'SELECT relative_path, existed, blob_hash, mode, size, captured_at FROM file_baselines WHERE task_id = ?',
      )
      .all(taskId) as Array<{
      relative_path: string;
      existed: number;
      blob_hash: string | null;
      mode: number | null;
      size: number;
      captured_at: string;
    }>;
    return rows.map((row) => ({
      taskId,
      relativePath: row.relative_path,
      existed: row.existed === 1,
      blobHash: row.blob_hash,
      mode: row.mode,
      size: row.size,
      capturedAt: row.captured_at,
    }));
  }

  recordChange(change: FileChangeRecord): void {
    this.db
      .prepare(
        `INSERT INTO file_changes (id, task_id, tool_call_id, relative_path, kind, before_hash, after_hash, patch, rename_to, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        change.id,
        change.taskId,
        change.toolCallId,
        change.relativePath,
        change.kind,
        change.beforeHash,
        change.afterHash,
        change.patch,
        change.renameTo,
        change.author,
        change.createdAt,
      );
  }

  changesFor(taskId: string): FileChangeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, tool_call_id, relative_path, kind, before_hash, after_hash, patch, rename_to, author, created_at
         FROM file_changes WHERE task_id = ? ORDER BY created_at, id`,
      )
      .all(taskId) as Array<{
      id: string;
      tool_call_id: string | null;
      relative_path: string;
      kind: string;
      before_hash: string | null;
      after_hash: string | null;
      patch: string | null;
      rename_to: string | null;
      author: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      taskId,
      toolCallId: row.tool_call_id,
      relativePath: row.relative_path,
      kind: row.kind as FileChangeRecord['kind'],
      beforeHash: row.before_hash,
      afterHash: row.after_hash,
      patch: row.patch,
      renameTo: row.rename_to,
      author: row.author as FileChangeRecord['author'],
      createdAt: row.created_at,
    }));
  }
}

export class M5Services {
  private git: GitService | null = null;
  private changes: ChangeService | null = null;
  private blobs: BlobStore | null = null;
  private gitRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: WorkspaceHost,
    private readonly state: StateService,
    private readonly paths: AppPaths,
    private readonly logger: Logger,
  ) {
    host.onDidChangeWorkspace((ws) => {
      if (ws) {
        this.git = new GitService(ws.canonicalPath);
        const dataDir = workspaceDataDir(paths, ws.id);
        this.blobs = new BlobStore(join(dataDir, 'checkpoints', 'blobs'));
        this.changes = new ChangeService({
          root: ws.canonicalPath,
          blobs: this.blobs,
          repo: new SqliteChangeRepo(state.db),
          documents: ws.documents,
        });
        ws.watcher.onBatch(() => this.scheduleGitRefresh());
      } else {
        this.git = null;
        this.changes = null;
        this.blobs = null;
      }
    });
  }

  private scheduleGitRefresh(): void {
    if (this.gitRefreshTimer) clearTimeout(this.gitRefreshTimer);
    this.gitRefreshTimer = setTimeout(() => {
      broadcast('git.changed', { reason: 'fs' });
    }, 600);
  }

  mustGit(): GitService {
    if (!this.git) {
      throw new ProductFailure(
        productError('WS_NONE_OPEN', { userMessage: 'No workspace is open.' }),
      );
    }
    return this.git;
  }

  get changeService(): ChangeService | null {
    return this.changes;
  }

  get blobStore(): BlobStore | null {
    return this.blobs;
  }

  notifyGitChanged(reason: string): void {
    broadcast('git.changed', { reason });
  }
}

export function registerM5Handlers(
  services: M5Services,
  host: WorkspaceHost,
  logger: Logger,
): void {
  const after = (reason: string) => services.notifyGitChanged(reason);

  registerHandlers(
    {
      'git.status': async () => {
        const git = services.mustGit();
        const detect = await git.detect();
        if (!detect.isRepo) {
          return {
            gitAvailable: detect.gitAvailable,
            isRepo: false,
            branch: null,
            upstream: null,
            ahead: 0,
            behind: 0,
            detached: false,
            head: null,
            entries: [],
            stats: [],
          };
        }
        // Diffstat is decoration-only: a numstat failure must not break status.
        const [status, numstat] = await Promise.all([git.status(), git.numstat().catch(() => [])]);
        return {
          gitAvailable: true,
          isRepo: true,
          branch: status.branch,
          upstream: status.upstream,
          ahead: status.ahead,
          behind: status.behind,
          detached: detect.detached,
          head: detect.head,
          entries: status.entries.map((e) => ({
            path: e.path,
            origPath: e.origPath,
            group: e.group,
            indexState: e.indexState,
            workState: e.workState,
          })),
          stats: numstat
            .filter((s) => !s.binary)
            .map((s) => ({ path: s.path, insertions: s.insertions, deletions: s.deletions })),
        };
      },
      'git.diffFile': async ({ path, staged }) => ({
        diff: await services.mustGit().diffFile(path, { staged }),
      }),
      'git.show': async ({ path, ref }) => ({ content: await services.mustGit().show(path, ref) }),
      'git.stage': async ({ paths }) => {
        await services.mustGit().stage(paths);
        after('stage');
        return { ok: true };
      },
      'git.unstage': async ({ paths }) => {
        await services.mustGit().unstage(paths);
        after('unstage');
        return { ok: true };
      },
      'git.discard': async ({ paths, includeUntracked }) => {
        await services.mustGit().discard(paths, { includeUntracked });
        after('discard');
        return { ok: true };
      },
      'git.commit': async ({ message }) => {
        const result = await services.mustGit().commit(message);
        after('commit');
        return { output: result.output };
      },
      'git.branches': async () => ({ items: await services.mustGit().branches() }),
      'git.checkout': async ({ name }) => {
        await services.mustGit().checkout(name);
        after('checkout');
        return { ok: true };
      },
      'git.createBranch': async ({ name }) => {
        await services.mustGit().createBranch(name);
        after('branch');
        return { ok: true };
      },
      'git.init': async () => {
        const ws = host.mustActive();
        const { execFile } = await import('node:child_process');
        await new Promise<void>((resolve, reject) => {
          execFile('git', ['init'], { cwd: ws.canonicalPath }, (err) =>
            err ? reject(err) : resolve(),
          );
        });
        after('init');
        logger.info('git repo initialized', { path: ws.canonicalPath });
        return { ok: true };
      },
    },
    logger,
  );
}
