import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, ProductFailure } from '@pi-ide/foundation';
import { StateService } from './state-service.js';
import {
  inspectRegisteredProject,
  listRegisteredProjectDirectory,
  readRegisteredProjectFile,
  setRegisteredProjectTrust,
} from './project-inspection.js';

let root: string;
let state: StateService;
let project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'charter-project-inspection-'));
  project = join(root, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'AGENTS.md'), '# Local instructions\n');
  writeFileSync(join(project, 'src', 'index.ts'), 'export const answer = 42;\n');
  project = realpathSync(project);
  state = new StateService(
    join(root, 'app.db'),
    join(root, 'backups'),
    createLogger('test', { write: () => undefined }),
  );
  const now = new Date().toISOString();
  state.db
    .prepare(
      "INSERT INTO workspaces (id, canonical_path, display_name, trust_state, last_opened_at, created_at) VALUES ('ws-project', ?, 'project', 'untrusted', ?, ?)",
    )
    .run(project, now, now);
});

afterEach(() => {
  state.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Project Center inspection', () => {
  it('reads real setup, directory and file data without opening the workspace', async () => {
    const inspected = await inspectRegisteredProject(state, project);
    expect(inspected.exists).toBe(true);
    expect(inspected.displayName).toBe('project');
    expect(inspected.setup.agentsMd).toBe(true);
    expect(inspected.setup.claudeMd).toBe(false);

    const rootEntries = await listRegisteredProjectDirectory(state, project, '', false);
    expect(rootEntries.map((entry) => entry.name).toSorted()).toEqual(['AGENTS.md', 'src']);
    await expect(readRegisteredProjectFile(state, project, 'src/index.ts')).resolves.toMatchObject({
      binary: false,
      truncated: false,
      content: 'export const answer = 42;\n',
    });
  });

  it('allows only registered roots and prevents file traversal', async () => {
    await expect(readRegisteredProjectFile(state, project, '../app.db')).rejects.toBeInstanceOf(
      ProductFailure,
    );
    await expect(inspectRegisteredProject(state, join(root, 'other'))).rejects.toBeInstanceOf(
      ProductFailure,
    );
  });

  it('updates trust for the selected project only', async () => {
    expect(setRegisteredProjectTrust(state, project, true)).toBe('trusted');
    await expect(inspectRegisteredProject(state, project)).resolves.toMatchObject({
      trustState: 'trusted',
    });
  });

  it('lists local branches without opening or switching the selected project', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
    execFileSync('git', ['config', 'user.email', 'project@example.com'], { cwd: project });
    execFileSync('git', ['config', 'user.name', 'Project Test'], { cwd: project });
    execFileSync('git', ['add', '.'], { cwd: project });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: project });
    execFileSync('git', ['branch', 'release/next'], { cwd: project });

    const inspected = await inspectRegisteredProject(state, project);

    expect(inspected.git.branch).toBe('main');
    expect(inspected.git.branches).toEqual([
      { name: 'main', current: true },
      { name: 'release/next', current: false },
    ]);
    expect(
      execFileSync('git', ['branch', '--show-current'], { cwd: project }).toString().trim(),
    ).toBe('main');
  });

  it('returns a stable unavailable shape after the folder is deleted', async () => {
    rmSync(project, { recursive: true, force: true });
    await expect(inspectRegisteredProject(state, project)).resolves.toMatchObject({
      exists: false,
      displayName: 'project',
      setup: { agentsMd: false, claudeMd: false, agentsDir: false, piDir: false },
    });
  });
});
