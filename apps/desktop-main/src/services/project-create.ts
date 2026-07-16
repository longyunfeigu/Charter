import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';

/**
 * Local project creation (Home → New project…): an empty directory (optional
 * `git init`) or a `git clone`. The caller supplies the full path to the
 * project folder; missing parent folders are created and the project name is
 * simply the path's last segment. Runs the system git binary — clone supports
 * only non-interactive auth (public repos or credentials already configured
 * for git/SSH); interactive prompts are disabled so a missing credential
 * fails fast with a clear message instead of hanging.
 */

const NAME_RE = /^[^/\\:*?"<>|]+$/;

function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // never hang on credential prompts
        GIT_ASKPASS: 'true', // "true" binary: returns empty instead of asking
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += '\n(timed out)';
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stderr });
    });
  });
}

export interface CreateProjectInput {
  mode: 'empty' | 'clone';
  /** Full path to the project folder. Missing parents are created. */
  dir: string;
  gitInit: boolean;
  cloneUrl?: string | undefined;
}

export async function createProject(input: CreateProjectInput, logger: Logger): Promise<string> {
  const target = resolve(input.dir.trim());
  const name = basename(target);
  // The last path segment becomes the project name — it must be a real folder
  // name (guards against roots like "/" and stray control characters).
  if (!name || !NAME_RE.test(name)) {
    throw new ProductFailure(
      productError('PROJECT_BAD_NAME', {
        userMessage: 'The last folder in that path is not a valid folder name.',
      }),
    );
  }
  const parent = dirname(target);

  // A path that already points at a non-empty folder would mix the new project
  // into existing files — reject it. An empty folder is fine to reuse.
  const existing = await fs.stat(target).catch(() => null);
  if (existing) {
    if (!existing.isDirectory()) {
      throw new ProductFailure(
        productError('PROJECT_EXISTS', {
          userMessage: `“${name}” already exists and is not a folder. Choose another path.`,
        }),
      );
    }
    const entries = await fs.readdir(target).catch(() => [] as string[]);
    if (entries.length > 0) {
      throw new ProductFailure(
        productError('PROJECT_EXISTS', {
          userMessage: `“${name}” already exists and is not empty. Choose another path.`,
        }),
      );
    }
  }

  if (input.mode === 'clone') {
    const url = (input.cloneUrl ?? '').trim();
    if (!/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(url)) {
      throw new ProductFailure(
        productError('PROJECT_BAD_CLONE_URL', {
          userMessage: 'Enter a git URL (https://…, git@…, or ssh://…).',
        }),
      );
    }
    // git needs its working dir to exist; create the parent path up front.
    await fs.mkdir(parent, { recursive: true });
    logger.info('project clone starting', { url, target });
    const { code, stderr } = await runGit(['clone', '--', url, target], parent, 10 * 60 * 1000);
    if (code !== 0) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
      const detail = stderr.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
      throw new ProductFailure(
        productError('PROJECT_CLONE_FAILED', {
          userMessage: `git clone failed${detail ? ` — ${detail}` : ''}. Only repositories that authenticate non-interactively (public, or credentials already set up for git) can be cloned here.`,
          retryable: true,
        }),
      );
    }
    logger.info('project cloned', { target });
    return target;
  }

  // Create the project folder and any missing parents in the path.
  await fs.mkdir(target, { recursive: true });
  if (input.gitInit) {
    const { code, stderr } = await runGit(['init'], target, 30 * 1000);
    if (code !== 0) {
      // The folder itself is fine — surface the git problem without deleting it.
      logger.warn('git init failed for new project', { target, stderr: stderr.slice(0, 300) });
      throw new ProductFailure(
        productError('PROJECT_GIT_INIT_FAILED', {
          userMessage: `The folder was created, but git init failed${stderr ? ` — ${stderr.split('\n')[0]}` : ''}.`,
          retryable: true,
        }),
      );
    }
  }
  logger.info('project created', { target, gitInit: input.gitInit });
  return target;
}
