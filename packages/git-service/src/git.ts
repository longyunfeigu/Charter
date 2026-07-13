import { execFile } from 'node:child_process';
import { productError, ProductFailure } from '@pi-ide/foundation';

export interface GitDetect {
  isRepo: boolean;
  gitAvailable: boolean;
  root: string | null;
  head: string | null;
  branch: string | null;
  detached: boolean;
}

export type GitGroup = 'staged' | 'changes' | 'untracked' | 'conflict';

export interface GitStatusEntry {
  path: string;
  origPath: string | null;
  indexState: string;
  workState: string;
  group: GitGroup;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
}

export interface GitBranch {
  name: string;
  current: boolean;
}

function gitError(
  code: string,
  userMessage: string,
  context?: Record<string, unknown>,
): ProductFailure {
  return new ProductFailure(productError(code, { userMessage, context }));
}

/** All operations spawn `git` with argument arrays — never through a shell (GIT-008). */
export class GitService {
  constructor(private readonly root: string) {}

  private run(
    args: string[],
    options: { allowCodes?: number[] } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd: this.root, maxBuffer: 32 * 1024 * 1024, timeout: 30000 },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code ?? 1)
              : error
                ? 1
                : 0;
          if (error && !(options.allowCodes ?? []).includes(code)) {
            if ((error as { code?: unknown }).code === 'ENOENT') {
              reject(
                gitError('GIT_UNAVAILABLE', 'Git is not installed or not on PATH.', {
                  args: args.slice(0, 3),
                }),
              );
              return;
            }
            reject(
              gitError(
                'GIT_COMMAND_FAILED',
                stderr.toString().trim().slice(0, 500) || 'Git command failed.',
                {
                  args: args.slice(0, 4),
                  code,
                },
              ),
            );
            return;
          }
          resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
        },
      );
    });
  }

  async detect(): Promise<GitDetect> {
    try {
      const inside = await this.run(['rev-parse', '--is-inside-work-tree'], { allowCodes: [128] });
      if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
        return {
          isRepo: false,
          gitAvailable: true,
          root: null,
          head: null,
          branch: null,
          detached: false,
        };
      }
      const top = await this.run(['rev-parse', '--show-toplevel']);
      const head = await this.run(['rev-parse', 'HEAD'], { allowCodes: [128] }); // may fail on empty repo
      const branchRes = await this.run(['symbolic-ref', '--short', '-q', 'HEAD'], {
        allowCodes: [1],
      });
      const branch = branchRes.stdout.trim() || null;
      return {
        isRepo: true,
        gitAvailable: true,
        root: top.stdout.trim(),
        head: head.code === 0 ? head.stdout.trim() : null,
        branch,
        detached: head.code === 0 && branch === null,
      };
    } catch (e) {
      if (e instanceof ProductFailure && e.error.code === 'GIT_UNAVAILABLE') {
        return {
          isRepo: false,
          gitAvailable: false,
          root: null,
          head: null,
          branch: null,
          detached: false,
        };
      }
      throw e;
    }
  }

  async status(): Promise<GitStatus> {
    const result = await this.run(['status', '--porcelain=v2', '--branch', '-z']);
    const records = result.stdout.split('\u0000');
    const entries: GitStatusEntry[] = [];
    let branch: string | null = null;
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;

    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      if (record === '') continue;
      if (record.startsWith('# branch.head ')) {
        const value = record.slice('# branch.head '.length);
        branch = value === '(detached)' ? null : value;
      } else if (record.startsWith('# branch.upstream ')) {
        upstream = record.slice('# branch.upstream '.length);
      } else if (record.startsWith('# branch.ab ')) {
        const m = record.match(/\+(\d+) -(\d+)/);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
        const parts = record.split(' ');
        const xy = parts[1]!;
        const indexState = xy[0]!;
        const workState = xy[1]!;
        let path: string;
        let origPath: string | null = null;
        if (record.startsWith('2 ')) {
          // rename: "2 <xy> ... <path>" + next NUL record is origPath
          path = parts.slice(9).join(' ');
          origPath = records[i + 1] ?? null;
          i++;
        } else {
          path = parts.slice(8).join(' ');
        }
        const isConflict = indexState === 'U' || workState === 'U';
        if (indexState !== '.' && indexState !== '?') {
          entries.push({
            path,
            origPath,
            indexState,
            workState,
            group: isConflict ? 'conflict' : 'staged',
          });
        }
        if (workState !== '.' && !isConflict) {
          entries.push({ path, origPath, indexState, workState, group: 'changes' });
        }
        if (isConflict) {
          entries.push({ path, origPath, indexState, workState, group: 'conflict' });
        }
      } else if (record.startsWith('u ')) {
        const parts = record.split(' ');
        const path = parts.slice(10).join(' ');
        entries.push({ path, origPath: null, indexState: 'U', workState: 'U', group: 'conflict' });
      } else if (record.startsWith('? ')) {
        entries.push({
          path: record.slice(2),
          origPath: null,
          indexState: '?',
          workState: '?',
          group: 'untracked',
        });
      }
    }

    // De-duplicate conflict double-push
    const seen = new Set<string>();
    const deduped = entries.filter((e) => {
      const key = `${e.group}:${e.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { branch, upstream, ahead, behind, entries: deduped };
  }

  async diffFile(path: string, options: { staged: boolean }): Promise<string> {
    if (options.staged) {
      const result = await this.run(['diff', '--cached', '--no-color', '--', path]);
      return result.stdout;
    }
    const tracked = await this.run(['ls-files', '--error-unmatch', '--', path], {
      allowCodes: [1],
    });
    if (tracked.code !== 0) {
      // Untracked: diff against /dev/null (exit code 1 is "differences found").
      const result = await this.run(['diff', '--no-color', '--no-index', '--', '/dev/null', path], {
        allowCodes: [1],
      });
      return result.stdout;
    }
    const result = await this.run(['diff', '--no-color', '--', path]);
    return result.stdout;
  }

  async show(path: string, ref: string): Promise<string> {
    if (!/^[A-Za-z0-9_./:^~-]{1,100}$/.test(ref)) {
      throw gitError('GIT_INVALID_REF', 'Invalid git reference.');
    }
    const result = await this.run(['show', `${ref}:${path}`], { allowCodes: [128] });
    return result.code === 0 ? result.stdout : '';
  }

  async stage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(['add', '--', ...paths]);
  }

  async unstage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run(['restore', '--staged', '--', ...paths]);
  }

  async discard(paths: string[], options: { includeUntracked: boolean }): Promise<void> {
    if (paths.length === 0) return;
    const status = await this.status();
    const untracked = new Set(
      status.entries.filter((e) => e.group === 'untracked').map((e) => e.path),
    );
    const trackedPaths = paths.filter((p) => !untracked.has(p));
    const untrackedPaths = paths.filter((p) => untracked.has(p));
    if (trackedPaths.length > 0) {
      await this.run(['restore', '--worktree', '--', ...trackedPaths]);
    }
    if (untrackedPaths.length > 0 && options.includeUntracked) {
      await this.run(['clean', '-f', '--', ...untrackedPaths]);
    }
  }

  async commit(message: string): Promise<{ ok: boolean; output: string }> {
    if (message.trim().length === 0) {
      throw gitError('GIT_EMPTY_MESSAGE', 'A commit message is required.');
    }
    const result = await this.run(['commit', '-m', message], { allowCodes: [1] });
    if (result.code !== 0) {
      throw gitError(
        'GIT_COMMIT_FAILED',
        result.stderr.trim().slice(0, 500) ||
          result.stdout.trim().slice(0, 500) ||
          'Commit failed (hooks or nothing staged).',
      );
    }
    return { ok: true, output: `${result.stdout}${result.stderr}`.trim().slice(0, 2000) };
  }

  async branches(): Promise<GitBranch[]> {
    const result = await this.run(['branch', '--format=%(refname:short)%09%(HEAD)']);
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, headMark] = line.split('\t');
        return { name: name!, current: headMark === '*' };
      });
  }

  async checkout(branch: string): Promise<void> {
    await this.run(['switch', '--', branch]);
  }

  async createBranch(name: string): Promise<void> {
    if (!/^[A-Za-z0-9_./-]{1,120}$/.test(name) || name.startsWith('-')) {
      throw gitError('GIT_INVALID_BRANCH', 'That branch name is not valid.');
    }
    await this.run(['switch', '-c', name]);
  }

  async headInfo(): Promise<{ head: string | null; branch: string | null }> {
    const detect = await this.detect();
    return { head: detect.head, branch: detect.branch };
  }

  // ---------- worktrees (ADR-0009) ----------

  /** Create a linked worktree at `path` on a new branch from HEAD. */
  async worktreeAdd(path: string, branch: string): Promise<void> {
    if (!/^[A-Za-z0-9_./-]{1,120}$/.test(branch) || branch.startsWith('-')) {
      throw gitError('GIT_INVALID_BRANCH', 'That branch name is not valid.');
    }
    const fresh = await this.run(['worktree', 'add', '-b', branch, '--', path, 'HEAD'], {
      allowCodes: [128],
    });
    if (fresh.code === 0) return;
    // Branch may survive from an earlier attempt — reuse it explicitly.
    await this.run(['worktree', 'add', '--', path, branch]);
  }

  /** Remove a linked worktree (forced — task worktrees are disposable) and prune. */
  async worktreeRemove(path: string): Promise<void> {
    await this.run(['worktree', 'remove', '--force', '--', path], { allowCodes: [128] });
    await this.run(['worktree', 'prune'], { allowCodes: [128] });
  }
}
