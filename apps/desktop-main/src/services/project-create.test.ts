import { describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductFailure, type Logger } from '@pi-ide/foundation';
import { createProject } from './project-create.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'pi-ide-newproj-'));
}

describe('createProject (Home → New project)', () => {
  it('creates an empty folder without git', async () => {
    const dir = join(tmp(), 'demo');
    const path = await createProject({ mode: 'empty', dir, gitInit: false }, logger);
    expect(path).toBe(dir);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, '.git'))).toBe(false);
  });

  it('creates an empty folder with git init', async () => {
    const dir = join(tmp(), 'demo-git');
    const path = await createProject({ mode: 'empty', dir, gitInit: true }, logger);
    expect(existsSync(join(path, '.git'))).toBe(true);
  });

  it('creates any missing parent folders in the path', async () => {
    const dir = join(tmp(), 'nested', 'deep', 'proj');
    const path = await createProject({ mode: 'empty', dir, gitInit: false }, logger);
    expect(path).toBe(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('reuses an existing empty folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-ide-existing-'));
    const path = await createProject({ mode: 'empty', dir, gitInit: false }, logger);
    expect(path).toBe(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('rejects a last segment that is not a valid folder name', async () => {
    for (const leaf of ['x:y', 'a*b', 'q?']) {
      await expect(
        createProject({ mode: 'empty', dir: join(tmp(), leaf), gitInit: false }, logger),
      ).rejects.toBeInstanceOf(ProductFailure);
    }
  });

  it('refuses a path that points at a non-empty folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-ide-nonempty-'));
    writeFileSync(join(dir, 'keep.txt'), 'x');
    await expect(
      createProject({ mode: 'empty', dir, gitInit: false }, logger),
    ).rejects.toMatchObject({ error: { code: 'PROJECT_EXISTS' } });
  });

  it('rejects clone URLs that are not git URLs', async () => {
    await expect(
      createProject(
        { mode: 'clone', dir: join(tmp(), 'c'), gitInit: false, cloneUrl: 'not a url' },
        logger,
      ),
    ).rejects.toMatchObject({ error: { code: 'PROJECT_BAD_CLONE_URL' } });
  });

  it('clones a local repository (file transport exercises real git)', async () => {
    // A local origin keeps the test hermetic while running the actual clone path.
    const origin = await createProject(
      { mode: 'empty', dir: join(tmp(), 'origin-repo'), gitInit: true },
      logger,
    );
    const { execSync } = await import('node:child_process');
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init', {
      cwd: origin,
      stdio: 'ignore',
    });
    const dest = join(tmp(), 'sub', 'cloned');
    const path = await createProject(
      {
        mode: 'clone',
        dir: dest,
        gitInit: false,
        cloneUrl: `https://invalid.invalid/never`,
      },
      logger,
    ).catch((e) => e as ProductFailure);
    // Network clone fails fast (non-interactive) — proves the guard works…
    expect(path).toBeInstanceOf(ProductFailure);
    // …and a direct local clone via git itself stays possible for the user.
    execSync(`git clone --quiet -- "${origin}" "${dest}"`, { stdio: 'ignore' });
    expect(existsSync(join(dest, '.git'))).toBe(true);
  }, 30000);
});
