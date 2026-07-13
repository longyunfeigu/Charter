import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { GitService } from '@pi-ide/git-service';
import { resolveInsideRoot } from '@pi-ide/workspace-service';
import type { ChangeSet } from '@pi-ide/change-service';
import type { AppPaths } from '../app-paths.js';

/** Worktree metadata persisted on the task row (ADR-0009). */
export interface TaskWorktree {
  path: string;
  branch: string;
  baseHead: string | null;
  baseBranch: string | null;
}

export interface MergeConflict {
  path: string;
  reason: string;
}

function sha(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function hashOf(abs: string): Promise<string | null> {
  try {
    return sha(await fs.readFile(abs));
  } catch {
    return null; // missing
  }
}

/**
 * Task worktree isolation (ADR-0009): same-project parallel tasks each run in
 * their own `git worktree`; accepting merges the net change set back into the
 * main tree file-by-file with baseline conflict checks (mirrors CHG-009/010).
 */
export class WorktreeService {
  constructor(
    private readonly paths: AppPaths,
    private readonly logger: Logger,
  ) {}

  dirFor(wsId: string, taskId: string): string {
    return join(this.paths.userData, 'worktrees', wsId, taskId);
  }

  async create(projectRoot: string, wsId: string, taskId: string): Promise<TaskWorktree> {
    const git = new GitService(projectRoot);
    const detect = await git.detect();
    if (!detect.isRepo) {
      throw new ProductFailure(
        productError('WT_NOT_GIT', {
          userMessage: 'Worktree isolation needs a git repository — this project is not one.',
        }),
      );
    }
    if (!detect.head) {
      throw new ProductFailure(
        productError('WT_NO_COMMIT', {
          userMessage:
            'Worktree isolation needs at least one commit in the repository. Commit first, then retry.',
        }),
      );
    }
    const path = this.dirFor(wsId, taskId);
    await fs.mkdir(dirname(path), { recursive: true });
    const branch = `charter/${taskId}`;
    try {
      await git.worktreeAdd(path, branch);
    } catch (e) {
      throw new ProductFailure(
        productError('WT_CREATE_FAILED', {
          userMessage: 'Could not create the isolated worktree for this task.',
          technicalMessage: e instanceof Error ? e.message : String(e),
        }),
      );
    }
    this.logger.info('worktree created', { taskId, path, branch });
    return { path, branch, baseHead: detect.head, baseBranch: detect.branch };
  }

  /** Drop the worktree (rollback/cleanup). The branch is kept for audit. */
  async discard(projectRoot: string, worktree: TaskWorktree): Promise<void> {
    try {
      await new GitService(projectRoot).worktreeRemove(worktree.path);
    } catch (e) {
      this.logger.warn('worktree remove failed', {
        path: worktree.path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    await fs.rm(worktree.path, { recursive: true, force: true }).catch(() => undefined);
  }

  /**
   * Conflict preflight for merge-back: for every file in the task's net change
   * set the main tree must still match the task baseline (or already match the
   * task result — idempotent re-accept).
   */
  async mergeBackPreflight(mainRoot: string, changeSet: ChangeSet): Promise<MergeConflict[]> {
    const conflicts: MergeConflict[] = [];
    for (const file of changeSet.files) {
      const mainAbs = await resolveInsideRoot(mainRoot, file.path);
      const mainHash = await hashOf(mainAbs);
      if (file.status === 'deleted') {
        if (mainHash !== null && mainHash !== file.baselineHash) {
          conflicts.push({
            path: file.path,
            reason: 'changed in the main tree after the task branched',
          });
        }
        continue;
      }
      if (mainHash === file.currentHash) continue; // already applied
      if (mainHash === null) {
        if (file.baselineHash !== null) {
          conflicts.push({ path: file.path, reason: 'deleted in the main tree during the task' });
        }
        continue; // brand-new file — clean create
      }
      if (mainHash !== file.baselineHash) {
        conflicts.push({
          path: file.path,
          reason: 'changed in the main tree after the task branched',
        });
      }
      if (file.renamedFrom) {
        const fromAbs = await resolveInsideRoot(mainRoot, file.renamedFrom);
        const fromHash = await hashOf(fromAbs);
        if (fromHash !== null && fromHash !== file.baselineHash) {
          conflicts.push({
            path: file.renamedFrom,
            reason: 'rename source changed in the main tree during the task',
          });
        }
      }
    }
    return conflicts;
  }

  /** Apply the net change set onto the main tree (atomic per file). */
  async mergeBack(
    mainRoot: string,
    worktreeRoot: string,
    changeSet: ChangeSet,
  ): Promise<{ merged: string[] }> {
    const merged: string[] = [];
    for (const file of changeSet.files) {
      const mainAbs = await resolveInsideRoot(mainRoot, file.path);
      if (file.status === 'deleted') {
        await fs.rm(mainAbs, { force: true });
        merged.push(file.path);
        continue;
      }
      const wtAbs = await resolveInsideRoot(worktreeRoot, file.path);
      let bytes: Buffer;
      let mode: number | null = null;
      try {
        bytes = await fs.readFile(wtAbs);
        mode = (await fs.stat(wtAbs)).mode & 0o7777;
      } catch (e) {
        throw new ProductFailure(
          productError('WT_MERGE_READ_FAILED', {
            userMessage: `Could not read ${file.path} from the task worktree.`,
            technicalMessage: e instanceof Error ? e.message : String(e),
          }),
        );
      }
      await fs.mkdir(dirname(mainAbs), { recursive: true });
      const tmp = `${mainAbs}.charter-merge-${Date.now()}`;
      await fs.writeFile(tmp, bytes, mode !== null ? { mode } : {});
      await fs.rename(tmp, mainAbs);
      if (file.renamedFrom) {
        const fromAbs = await resolveInsideRoot(mainRoot, file.renamedFrom);
        await fs.rm(fromAbs, { force: true });
      }
      merged.push(file.path);
    }
    this.logger.info('worktree merged back', { files: merged.length, mainRoot });
    return { merged };
  }
}
