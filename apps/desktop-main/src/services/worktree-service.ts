import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
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

export interface WorktreeSetupResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
}

/** Readable branch: charter/<title-slug>-<short-id> (git-safe subset). */
export function worktreeBranchName(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const short = taskId
    .replace(/[^a-z0-9]/gi, '')
    .slice(-6)
    .toLowerCase();
  return slug ? `charter/${slug}-${short}` : `charter/${taskId}`;
}

/**
 * `.worktreeinclude` matching (de-facto convention shared with other agent
 * tools): gitignore-style patterns; only files git already ignores are
 * eligible, so tracked files are never duplicated.
 *
 * Supported subset: `*` (segment), `**` (any depth), `?`, leading `/` anchors
 * to the root, trailing `/` matches the directory and everything below, and
 * slash-free patterns match at any depth.
 */
export function matchesWorktreeInclude(patterns: string[], relPath: string): boolean {
  const path = relPath.replace(/\/+$/, '');
  for (const raw of patterns) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const dirOnly = line.endsWith('/');
    let pattern = line.replace(/\/+$/, '');
    const anchored = pattern.startsWith('/');
    if (anchored) pattern = pattern.slice(1);
    if (!pattern) continue;
    const body = toRegex(pattern).source.replace(/^\^|\$$/g, '');
    // Directory patterns match the directory itself and anything under it.
    const regex = new RegExp(`^${body}${dirOnly ? '(/.*)?' : ''}$`);
    const targets = anchored || pattern.includes('/') ? [path] : candidateSuffixes(path);
    for (const target of targets) {
      if (regex.test(target)) return true;
    }
  }
  return false;
}

function toRegex(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
        if (pattern[i + 1] === '/') i++; // `**/` — the .* covers the slash
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** For slash-free patterns: every path suffix starting at a segment boundary. */
function candidateSuffixes(path: string): string[] {
  const parts = path.split('/');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join('/'));
  return out;
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

  async create(
    projectRoot: string,
    wsId: string,
    taskId: string,
    title?: string,
  ): Promise<TaskWorktree> {
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
    const branch = worktreeBranchName(taskId, title ?? '');
    try {
      await git.worktreeAdd(path, branch);
    } catch (e) {
      throw new ProductFailure(
        productError('WT_CREATE_FAILED', {
          userMessage: 'Could not create the isolated worktree for this task.',
          technicalMessage: errorMessage(e),
        }),
      );
    }
    const copied = await this.copyIncludes(projectRoot, path).catch((e) => {
      this.logger.warn('worktreeinclude copy failed', {
        taskId,
        error: errorMessage(e),
      });
      return [] as string[];
    });
    this.logger.info('worktree created', { taskId, path, branch, copiedIncludes: copied.length });
    return { path, branch, baseHead: detect.head, baseBranch: detect.branch };
  }

  /**
   * Copy `.worktreeinclude`-matched, git-ignored files (e.g. .env) from the
   * main checkout into a fresh worktree. Returns the copied relative paths.
   */
  private async copyIncludes(projectRoot: string, worktreePath: string): Promise<string[]> {
    const includeFile = join(projectRoot, '.worktreeinclude');
    const raw = await fs.readFile(includeFile, 'utf8').catch(() => null);
    if (raw === null) return [];
    const patterns = raw.split('\n');
    const git = new GitService(projectRoot);
    const ignored = await git.listIgnored();
    const copied: string[] = [];
    for (const entry of ignored) {
      const rel = entry.replace(/\/+$/, '');
      if (!matchesWorktreeInclude(patterns, entry) && !matchesWorktreeInclude(patterns, rel)) {
        continue;
      }
      const from = await resolveInsideRoot(projectRoot, rel);
      const to = await resolveInsideRoot(worktreePath, rel).catch(() => null);
      if (!to) continue;
      try {
        await fs.mkdir(dirname(to), { recursive: true });
        await fs.cp(from, to, { recursive: true, force: false, errorOnExist: false });
        copied.push(rel);
      } catch (e) {
        this.logger.warn('worktreeinclude copy skipped', {
          rel,
          error: errorMessage(e),
        });
      }
    }
    return copied;
  }

  /**
   * Run the user-provided setup command once inside a fresh worktree (deps,
   * codegen — mirrors the setup-script convention of other agent runners).
   * The command is the user's own text, executed host-side like verification
   * commands; output is captured for the task timeline.
   */
  async runSetup(worktreePath: string, command: string): Promise<WorktreeSetupResult> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd: worktreePath,
        shell: true,
        env: { ...process.env, CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const feed = (chunk: Buffer): void => {
        output = (output + chunk.toString()).slice(-8000);
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      const timer = setTimeout(
        () => {
          child.kill('SIGKILL');
          output += '\n(setup timed out after 10 minutes)';
        },
        10 * 60 * 1000,
      );
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({
          command,
          ok: false,
          exitCode: null,
          durationMs: Date.now() - startedAt,
          outputTail: `${output}\n${e.message}`.slice(-2000),
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          command,
          ok: code === 0,
          exitCode: code,
          durationMs: Date.now() - startedAt,
          outputTail: output.slice(-2000),
        });
      });
    });
  }

  /**
   * Startup hygiene: remove worktree directories whose task is finished (or
   * gone). Live/resumable tasks keep theirs. Returns removed directory names.
   */
  async sweepOrphans(
    projectRootsByWsId: Map<string, string>,
    keep: Set<string>,
  ): Promise<string[]> {
    const removed: string[] = [];
    const base = join(this.paths.userData, 'worktrees');
    const wsDirs = await fs.readdir(base).catch(() => [] as string[]);
    for (const wsId of wsDirs) {
      const taskDirs = await fs.readdir(join(base, wsId)).catch(() => [] as string[]);
      for (const taskId of taskDirs) {
        if (keep.has(taskId)) continue;
        const dir = join(base, wsId, taskId);
        const root = projectRootsByWsId.get(wsId);
        if (root) {
          await new GitService(root).worktreeRemove(dir).catch(() => undefined);
        }
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        removed.push(`${wsId}/${basename(dir)}`);
      }
    }
    if (removed.length > 0) this.logger.info('worktree orphans swept', { removed });
    return removed;
  }

  /** True when the worktree directory still exists on disk. */
  async exists(worktree: TaskWorktree): Promise<boolean> {
    const stat = await fs.stat(worktree.path).catch(() => null);
    return Boolean(stat?.isDirectory());
  }

  /** Drop the worktree (rollback/cleanup). The branch is kept for audit. */
  async discard(projectRoot: string, worktree: TaskWorktree): Promise<void> {
    try {
      await new GitService(projectRoot).worktreeRemove(worktree.path);
    } catch (e) {
      this.logger.warn('worktree remove failed', {
        path: worktree.path,
        error: errorMessage(e),
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
            technicalMessage: errorMessage(e),
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
